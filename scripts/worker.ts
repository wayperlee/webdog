#!/usr/bin/env tsx
// PR 3 replaces this entrypoint with the durable native queue worker.
console.error("CHECKS_NOT_AVAILABLE: the legacy Context.dev worker is disabled in PR 1.");
process.exitCode = 1;
