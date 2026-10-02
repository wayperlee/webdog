/** Read-only live acceptance harness. Optional DoH avoids local fake-IP DNS without relaxing crawler checks. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { crawlSitemaps, type CrawlResult } from "../src/lib/sitemap";
import { createSafeFetcher } from "../src/lib/sitemap/http";

const execute = promisify(execFile);
async function publicDns(host: string) {
  // Fixed HTTPS control-plane endpoint; curl keeps normal certificate verification enabled.
  const { stdout } = await execute("curl", ["--silent", "--show-error", "--fail", "--max-time", "8", "-H", "accept: application/dns-json", `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`], { maxBuffer: 256_000 });
  const reply = JSON.parse(stdout) as { Status: number; Answer?: { type: number; data: string }[] };
  if (reply.Status !== 0) throw new Error("Public DNS query failed");
  return (reply.Answer ?? []).filter((answer) => answer.type === 1).map((answer) => ({ address: answer.data, family: 4 }));
}
function summary(result: CrawlResult) {
  const { state, urls, ...details } = result;
  return { ...details, urlCount: urls?.length ?? null, urlSetHash: urls ? createHash("sha256").update(JSON.stringify(urls)).digest("hex") : null, notModifiedCount: result.sources.filter((source) => source.status === "not_modified").length, retainedRevisionCount: Object.keys(state.revisions).length };
}
async function main() {
  const args = process.argv.slice(2), sites: string[] = [];
  let doh = false, output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--doh") doh = true;
    else if (args[i] === "--site" && args[i + 1]) sites.push(args[++i]);
    else if (args[i] === "--output" && args[i + 1] && !output) output = resolve(args[++i]);
    else throw new Error("Usage: npm run sitemap:compatibility -- [--doh] --site URL [--site URL ...] [--output PATH]");
  }
  if (!sites.length) throw new Error("At least one --site is required");
  const fetcher = createSafeFetcher(doh ? { resolve: publicDns } : {});
  const reports = [];
  for (const site of sites) {
    const start = performance.now();
    const first = await crawlSitemaps({ siteUrl: site, fetcher, limits: { maxAttemptMs: 90_000, requestTimeoutMs: 10_000 } });
    const second = first.completeness === "complete" ? await crawlSitemaps({ siteUrl: site, fetcher, state: first.state, limits: { maxAttemptMs: 90_000, requestTimeoutMs: 10_000 } }) : undefined;
    const report = { site, observedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), first: summary(first), second: second ? summary(second) : null };
    reports.push(report);
    console.log(JSON.stringify({ site, elapsedMs: report.elapsedMs, first: first.completeness, firstUrls: first.urls?.length ?? null, second: second?.completeness ?? null, secondUrls: second?.urls?.length ?? null, issues: first.issues }, null, 2));
  }
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify({ resolver: doh ? "Cloudflare DoH (acceptance harness only)" : "system DNS", reports }, null, 2)}\n`);
  }
  process.exitCode = reports.some((report) => report.first.completeness !== "complete" || report.second?.completeness !== "complete") ? 1 : 0;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Acceptance failed"); process.exitCode = 2; });
