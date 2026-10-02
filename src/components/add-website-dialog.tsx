"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { normalizeDomain } from "@/lib/domain";
import { parseWebsiteUrlInput } from "@/lib/website-url-input";

export function AddWebsiteDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [domain, setDomain] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function applyParsedInput(raw: string) {
    const { domainHost } = parseWebsiteUrlInput(raw);
    setDomain(domainHost);
  }

  function reset() {
    setDomain("");
    setError(null);
    setLoading(false);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const normalized = normalizeDomain(domain);
    if (!normalized) {
      setError("Enter a valid domain like example.com");
      return;
    }

    setLoading(true);
    const body = { domain: normalized };

    try {
      const res = await fetch("/api/websites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not add website");
      setOpen(false);
      reset();
      router.push(`/dashboard/websites/${data.website.id}`);
      router.refresh();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not add website. Please try again.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-accent h-8 !py-0"
      >
        <PlusIcon className="size-4" /> Add website
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Add website"
          className="fixed inset-0 z-50"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={() => {
              setOpen(false);
              reset();
            }}
            className="absolute inset-0 bg-neutral-950/40"
          />
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <form
              onSubmit={onSubmit}
              className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-neutral-950/5"
            >
              <h2 className="text-base font-semibold text-neutral-900">
                Add a website to watch
              </h2>
              <p className="mt-1 text-sm text-neutral-600">
                Add a domain for sitemap monitoring. No provider API key is
                required.
              </p>
              <div className="mt-6">
                <label
                  htmlFor="w-domain"
                  className="block text-sm font-medium text-neutral-900"
                >
                  Domain
                </label>
                <div className="relative mt-1.5">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-3 flex items-center font-mono text-xs text-neutral-400"
                  >
                    https://
                  </span>
                  <input
                    id="w-domain"
                    name="domain"
                    className="input pl-[4.25rem] font-mono"
                    placeholder="anthropic.com"
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    value={domain}
                    onChange={(e) => applyParsedInput(e.target.value)}
                    onPaste={(e) => {
                      const raw = e.clipboardData.getData("text/plain");
                      const parsed = parseWebsiteUrlInput(raw);
                      if (parsed.domainHost === raw.trim() && !parsed.pagePath)
                        return;
                      e.preventDefault();
                      const el = e.currentTarget;
                      const start = el.selectionStart ?? 0;
                      const end = el.selectionEnd ?? start;
                      const merged = `${domain.slice(0, start)}${raw}${domain.slice(end)}`;
                      applyParsedInput(merged);
                      requestAnimationFrame(() => {
                        const pos = parsed.domainHost.length;
                        el.setSelectionRange(pos, pos);
                      });
                    }}
                  />
                </div>
                <p className="mt-2 text-xs text-neutral-500">
                  Paste a domain or URL. Only the domain is saved; page content
                  monitoring is unavailable.
                </p>
              </div>
              {error && (
                <p className="mt-4 text-sm text-brand-700" role="alert">
                  {error}
                </p>
              )}
              <div className="mt-6 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    reset();
                  }}
                  className="btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={loading || !domain.trim()}
                  className="btn-accent"
                >
                  {loading ? "Saving…" : "Add website"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function PlusIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      {...props}
    >
      <path d="M8 3v10M3 8h10" strokeLinecap="round" />
    </svg>
  );
}
