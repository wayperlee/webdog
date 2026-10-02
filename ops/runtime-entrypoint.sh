#!/bin/sh
set -eu
node --input-type=module -e '
const secret = process.env.BETTER_AUTH_SECRET || "";
let valid = secret.length >= 32 && !secret.startsWith("replace-");
try {
  const db = new URL(process.env.DATABASE_URL);
  const origin = new URL(process.env.BETTER_AUTH_URL);
  valid &&= ["postgres:", "postgresql:"].includes(db.protocol)
    && (origin.protocol === "https:" || (origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname)))
    && ["system", "cloudflare-doh"].includes(process.env.SITEMAP_DNS_RESOLVER || "system");
} catch { valid = false; }
if (!valid) { console.error("RUNTIME_CONFIG_INVALID: database, auth secret, canonical origin or resolver"); process.exit(1); }
'
exec "$@"
