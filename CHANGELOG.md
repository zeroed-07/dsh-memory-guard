# Changelog

## 0.1.2

- First public release.
- Host heap sampling (`process.memoryUsage()` + `v8.getHeapStatistics()`).
- Session-log size scan under `$DSH_HOME/sessions`.
- Synchronous tool-argument guard (`ctx.tools.guard`), default 2 MiB.
- Alerts for persisted large events and oversized session logs.
- `/memguard` status command and `memguard` tool (`status`, `vacuum-scan`,
  `vacuum-apply`).
- Offline vacuum core for multi-frame `session.v4.jsonl.zstd` files, including
  header-only first frame and PTC start/final placeholder pairing.
- Header chip fed by `/memory-guard/stats`.
- `dsh-memory-guard-vacuum` CLI.
- `guardEnabled` and `guardExemptTools` options.
