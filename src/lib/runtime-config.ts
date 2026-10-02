export function envInteger(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid ${name}`);
  return Number(raw);
}
export function poolConfig(env: Record<string, string | undefined> = process.env) {
  const schema = env.DATABASE_SCHEMA;
  if (schema && !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid DATABASE_SCHEMA");
  return {
    max: envInteger(env, "DB_POOL_MAX", 10, 1, 50),
    connectionTimeoutMillis: envInteger(env, "DB_CONNECTION_TIMEOUT_MS", 5000, 100, 60_000),
    idleTimeoutMillis: envInteger(env, "DB_IDLE_TIMEOUT_MS", 30_000, 1000, 300_000),
    application_name: env.DB_APPLICATION_NAME || "sitemap-radar-web",
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  };
}
