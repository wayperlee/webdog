/**
 * LLM relevance filter for website change alerts.
 *
 * Change detection is a byte-level diff, so it fires on anything that moves —
 * cookie banners, rotating ads, "N people viewing", timestamps, CSRF tokens.
 * When a monitor opts in, this module scores each detected change against the
 * owner's `watchNote` (their stated intent) and decides whether it is worth a
 * notification. A change judged to be noise is held (stored, marked read, not
 * delivered) instead of paging the owner.
 *
 * Safety contract: this filter only ever *withholds a notification*. It fails
 * open — any missing config, timeout, malformed model output, or thrown error
 * resolves to "surface the alert". A bug here can make Webdog noisier; it can
 * never make it silently miss a real change.
 */

import { generateText } from "ai";
import type { AlertKind, Website } from "./db/schema";
import {
  buildChangePayload,
  createLanguageModel,
  type AiSummaryConfig,
  type AlertDetailsForSummary,
} from "./ai-change-summary";

const LLM_TIMEOUT_MS = 30_000;
const MAX_CHANGE_CHARS = 8_000;
const MAX_OUTPUT_TOKENS = 120;
const MAX_REASON_CHARS = 200;

export const TRIAGE_SYSTEM_PROMPT = `You are a change-monitoring triage filter. A website Webdog is watching changed, and byte-level diffing already flagged it. Your only job is to decide whether this change is worth notifying the site owner about, or whether it is routine noise.

Treat as NOISE (suppress): cookie/consent banners, rotating ads or promos, view/visitor counters, "last updated" timestamps and dates, session/CSRF tokens, cache-busting query strings, social share counts, and pure whitespace or reordering with no change in meaning.

Treat as MEANINGFUL (do not suppress): changes to pricing, product availability, copy that states a fact or claim, new or removed pages/sections, policy/terms/legal text, contact details, and anything the owner explicitly said they care about.

If the owner provided a watch note, weigh the change against it: a change clearly unrelated to their stated interest leans toward noise, but still surface any substantive change.

When you are not sure, DO NOT suppress. Surfacing a borderline change is cheap; hiding a real one is not.

Reply with a single minified JSON object and nothing else:
{"suppress": boolean, "reason": "<8 words or fewer>"}`;

export type TriageDecision = {
  /** True only when the model clearly judged the change to be noise. */
  suppress: boolean;
  /** Short model rationale; empty string when unavailable. */
  reason: string;
};

/** Fail-open default: never suppress without a clear, well-formed positive decision. */
const SURFACE: TriageDecision = { suppress: false, reason: "" };

/**
 * Parse a model reply into a decision. Pure and defensive: tolerates prose or
 * code fences around the JSON, and returns SURFACE on anything it cannot read
 * as an explicit `suppress: true`. Exported for unit testing.
 */
export function parseTriageDecision(text: string | null | undefined): TriageDecision {
  if (!text) return SURFACE;

  // Prefer a clean parse of the whole reply; this rejects arrays and other
  // non-object top-level shapes. Only if that fails do we fall back to pulling a
  // brace-delimited object out of surrounding prose or code fences.
  let parsed = tryJsonParse(text.trim());
  if (parsed === undefined) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) parsed = tryJsonParse(text.slice(start, end + 1));
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return SURFACE;

  const obj = parsed as Record<string, unknown>;
  // Strict: only an explicit boolean true suppresses. Missing / "true" / 1 all surface.
  if (obj.suppress !== true) return SURFACE;

  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, MAX_REASON_CHARS) : "";
  return { suppress: true, reason: reason || "Judged routine noise" };
}

function tryJsonParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function truncateChangeText(text: string): string {
  if (text.length <= MAX_CHANGE_CHARS) return text;
  return text.slice(0, MAX_CHANGE_CHARS - 20) + "\n… (truncated)";
}

function buildTriageContext(
  website: Pick<Website, "name" | "domain" | "url" | "title" | "description">,
): string {
  const lines = [`Site name: ${website.name}`, `Domain: ${website.domain}`, `URL: ${website.url}`];
  if (website.title?.trim()) lines.push(`Title: ${website.title.trim()}`);
  if (website.description?.trim()) lines.push(`Description: ${website.description.trim()}`);
  return lines.join("\n");
}

export async function triageChange(params: {
  config: AiSummaryConfig;
  website: Pick<Website, "name" | "domain" | "url" | "title" | "description">;
  alertKind: AlertKind;
  title: string;
  changeText: string;
  /** User's free-text intent for this monitor; steers what counts as relevant. */
  watchNote?: string | null;
}): Promise<TriageDecision> {
  const { config, website, alertKind, title, changeText, watchNote } = params;
  const note = watchNote?.trim();
  const userMessage = [
    `Website context:\n${buildTriageContext(website)}`,
    "",
    `Change type: ${alertKind}`,
    `Alert title: ${title}`,
    ...(note ? ["", `The owner set up this monitor to watch for: "${note}".`] : []),
    "",
    "Change data:",
    truncateChangeText(changeText),
  ].join("\n");

  try {
    const { text } = await generateText({
      model: createLanguageModel(config),
      system: TRIAGE_SYSTEM_PROMPT,
      prompt: userMessage,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      temperature: 0,
      abortSignal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    return parseTriageDecision(text);
  } catch (err) {
    // Fail open: a triage failure must never hide a real change.
    console.error("AI alert triage failed:", err);
    return SURFACE;
  }
}

/**
 * Convenience wrapper mirroring `trySummarizeAlert`: resolve the change payload
 * from an alert's details, then triage it. Returns SURFACE on any problem.
 */
export async function triageAlert(params: {
  config: AiSummaryConfig;
  website: Pick<Website, "name" | "domain" | "url" | "title" | "description">;
  alertKind: AlertKind;
  title: string;
  detailsJson: string;
  detailsForSummary?: AlertDetailsForSummary;
  watchNote?: string | null;
}): Promise<TriageDecision> {
  let details: AlertDetailsForSummary = params.detailsForSummary ?? {};
  if (!params.detailsForSummary) {
    try {
      details = JSON.parse(params.detailsJson) as AlertDetailsForSummary;
    } catch {
      details = {};
    }
  }
  const changeText = buildChangePayload(params.alertKind, details, params.title);
  return triageChange({
    config: params.config,
    website: params.website,
    alertKind: params.alertKind,
    title: params.title,
    changeText,
    watchNote: params.watchNote,
  });
}
