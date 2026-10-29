# Changelog

## 0.1.3

- Declare the tested host line in `engines.dsh` (`>=0.2.1-rc.2`) so plugin
  markets can show an explicit DSH requirement instead of "unknown".
- No runtime changes; behaviour is identical to 0.1.2.

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
