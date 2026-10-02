/** Legacy provider pipeline is intentionally unavailable until the native queue exists. */
export function requireLegacyCapability(): void {
  throw new Error("LEGACY_CAPABILITY_DISABLED: native sitemap checks are not implemented in PR 1.");
}
