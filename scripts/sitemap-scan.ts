import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { crawlSitemaps, type CrawlState } from "../src/lib/sitemap";

async function save(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await rename(temporary, path);
}

async function main() {
  const values = new Map<string, string[]>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--site", "--root", "--host", "--state", "--output"].includes(key) || !value || value.startsWith("--")) throw new Error("Usage: npm run sitemap:scan -- --site URL [--root URL ...] [--host HOST ...] [--state PATH] [--output PATH]");
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  for (const key of ["--site", "--state", "--output"]) if ((values.get(key)?.length ?? 0) > 1) throw new Error(`${key} may be specified only once`);
  const site = values.get("--site")?.[0];
  if (!site) throw new Error("--site is required");
  const statePath = values.get("--state")?.[0] ? resolve(values.get("--state")![0]) : undefined;
  const outputPath = values.get("--output")?.[0] ? resolve(values.get("--output")![0]) : undefined;
  if (statePath && outputPath === statePath) throw new Error("State and output paths must differ");
  let state: CrawlState | undefined;
  if (statePath) {
    try { state = JSON.parse(await readFile(statePath, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const start = performance.now();
  const result = await crawlSitemaps({ siteUrl: site, roots: values.get("--root"), allowedPageHosts: values.get("--host"), state });
  const { state: checkpoint, ...details } = result;
  const report = { site, scannedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), ...details };
  if (statePath) await save(statePath, checkpoint);
  if (outputPath) await save(outputPath, report);
  console.log(JSON.stringify({ site, completeness: result.completeness, urls: result.urls?.length ?? null, sources: result.sources.length, notModified: result.sources.filter((source) => source.status === "not_modified").length, elapsedMs: report.elapsedMs, compressedBytes: result.compressedBytes, inflatedBytes: result.inflatedBytes, issues: result.issues, statePath, outputPath }, null, 2));
  process.exitCode = result.completeness === "complete" ? 0 : 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "Scan failed"); process.exitCode = 2; });
