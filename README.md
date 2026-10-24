# dsh-memory-guard

[![npm](https://img.shields.io/npm/v/dsh-memory-guard)](https://www.npmjs.com/package/dsh-memory-guard)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Host memory and session-log guard for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

It exists because a single DSH session log can grow far past the size the Host
can parse at once. A real case: a 7,913-line session reached **954 MB
decompressed / 177 MB on disk**, of which 98.5% was duplicated PTC dispatch
payloads, and opening it exhausted the Host heap. This plugin watches for that
before it happens, blocks the worst single calls, and can shrink existing logs
offline.

## What it does

- **Heap monitoring** — samples `process.memoryUsage()` and
  `v8.getHeapStatistics()` every 3 s (used / limit / ratio / RSS).
- **Session-log accounting** — scans `$DSH_HOME/sessions` every 15 s, reports
  total bytes, file count, and the largest sessions.
- **Runtime guard** — synchronously rejects any tool call whose arguments are
  estimated above `maxToolArgBytes` (default **2 MiB**), with a message telling
  the model to chunk the write or generate the file from a script.
- **Persisted-payload alerts** — watches `session/event` rows that were already
  appended (`tool/call`, `tool/ptc-dispatch*`) and warns at 8 MiB, escalates at
  32 MiB. Session logs warn at 50 MiB / critical at 200 MiB.
- **Offline vacuum** — `/memguard vacuum` previews; `/memguard vacuum <id>
  confirm` rewrites a **cold** session log: oversized argument strings are
  replaced with an identical placeholder in PTC start/final pairs, a verified
  copy is produced, and the original is kept as `.orig-<timestamp>`.
- **Header chip** — `MEM 42% · 24.6 MB` in the session header, turning yellow /
  red when the Host reports warn / critical.
- **`/memguard` command and `memguard` tool** — status report; the tool also
  exposes `vacuum-scan` / `vacuum-apply` for agents.

## Requirements

| Item | Requirement |
| --- | --- |
| DSH | tested on `0.2.1-rc.2` (desktop and web profiles) |
| Node.js | `>= 22.15` (uses the built-in zstd API; DSH bundles a suitable runtime) |
| Platform | developed and verified on Windows; code is path-agnostic, Linux/macOS are untested |

## Install

```sh
# desktop profile (DeepSeek Harness desktop app)
dsh plugin --profile desktop add dsh-memory-guard

# web / headless profile
dsh plugin --profile web add dsh-memory-guard
```

From the DSH UI: **Settings → Plugins → Install** and enter `dsh-memory-guard`.
Restart the app after the Host half is installed; the client chip needs a page
refresh.

Upgrade:

```sh
dsh plugin --profile desktop remove dsh-memory-guard
dsh plugin --profile desktop add dsh-memory-guard
```

Uninstall:

```sh
dsh plugin --profile desktop remove dsh-memory-guard
```

## Header chip

The chip is registered in `conversation.session.header.utilities`. It polls the
same-origin endpoint `/memory-guard/stats` every 5 seconds. Hover it for heap,
RSS, session totals, the largest session, recent alerts and recent large
payloads.

If the chip does not appear after a DSH upgrade, the Host functionality still
works through `/memguard` and the `memguard` tool.

## Commands

| Command | Description |
| --- | --- |
| `/memguard` | Heap, session-log top 5, alerts, recent large payloads, current thresholds |
| `/memguard vacuum` | Dry-run: list cold sessions eligible for vacuum and the bytes they could save |
| `/memguard vacuum <session-id> confirm` | Rewrite that cold session log, verify it, keep `.orig-<timestamp>` |

`memguard` tool actions: `status`, `vacuum-scan`, `vacuum-apply` (the last one
requires `confirm: true` and refuses live sessions).

## Configuration

Edit the `config` block in the installed `cordis.patch.yml` (or the bundle row in
your profile composition), then restart DSH.

| Key | Default | Meaning |
| --- | --- | --- |
| `guardEnabled` | `true` | Set `false` to disable rejection while keeping monitoring |
| `guardExemptTools` | `[]` | Tool names that bypass the size guard, e.g. `["write"]` |
| `maxToolArgBytes` | `2097152` (2 MiB) | Reject tool calls whose arguments estimate above this |
| `noticeToolArgBytes` | `524288` (512 KiB) | Only record, do not alert |
| `heapWarnRatio` / `heapCriticalRatio` | `0.75` / `0.90` | Host heap yellow / red |
| `sessionLogWarnBytes` / `sessionLogCriticalBytes` | `50 MiB` / `200 MiB` | Per-session log yellow / red |
| `maxEventWarnBytes` / `maxEventCriticalBytes` | `8 MiB` / `32 MiB` | Already-persisted event yellow / red |
| `vacuumMinBytes` | `10485760` (10 MiB) | Do not consider smaller logs for vacuum |
| `notifyCooldownMs` | `300000` | Per session + code alert cooldown |
| `sampleIntervalMs` / `scanIntervalMs` | `3000` / `15000` | Heap sampling / session scan interval |

## HTTP endpoints

Local, same-origin prefix `/memory-guard`:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/memory-guard/stats` | Heap, session sizes, alerts, recent large payloads |
| POST | `/memory-guard/limit` | `{"maxToolArgBytes": <int>}` — temporary runtime override (resets on restart) |
| POST | `/memory-guard/vacuum` | Dry-run scan of cold sessions |

There is no authentication beyond an `Origin` check. Do not expose the DSH web
port to untrusted networks.

## Offline vacuum CLI

For a session log you already have on disk (for example a backup) you can run the
vacuum without installing DSH:

```sh
npx dsh-memory-guard-vacuum ./session.v4.jsonl.zstd scan
npx dsh-memory-guard-vacuum ./session.v4.jsonl.zstd write --out=./session.slim.jsonl.zstd
```

Always keep the source file. The CLI writes a new file, verifies line count,
JSON validity, header, and PTC pairing, and never edits the input.

## Why the vacuum is conservative

DSH stores a session as **concatenated zstd frames**, and its reader requires the
**first frame to contain exactly the header line**. Writing the whole file as a
single frame makes the session unlistable. This tool therefore writes a
header-only first frame followed by ~1 MiB event frames.

For PTC (`run_code`) sub-calls, DSH logs both `tool/ptc-dispatch-start` (with the
full arguments) and the matching `tool/ptc-dispatch`. The session-format
validator requires the pair to carry **deep-equal `arguments`**, so deleting the
start row corrupts the session. The vacuum replaces oversized argument strings
with the same placeholder on both sides; line count and `seq` numbers are
preserved.

## Known limitations

- **PTC writes before the guard runs.** For `run_code` sub-calls the Host appends
  `tool/ptc-dispatch-start` before `tools/pre-execute` and the guard, so the
  first copy of a huge argument can still reach the log. The guard prevents
  execution and the second (result-bearing) row; alerts and vacuum cover the
  rest. This is documented rather than hidden.
- **Live logs are never rewritten.** Only cold sessions can be vacuumed.
- **Only the Host heap is visible.** Renderer memory is not accessible from a
  Host plugin.
- **It does not raise the heap limit.** Node/Electron heap flags are set by the
  launcher, not by a plugin.
- **Vacuum is destructive by design.** It removes oversized payloads from the
  copy; the original is kept as `.orig-<timestamp>`, and dry-run is the default
  in `/memguard vacuum`.

## Privacy

- Reads local session-log file sizes and (for vacuum) the selected cold log.
- No network requests, no telemetry, no uploads.
- The web UI only calls the same-origin `/memory-guard/*` endpoints.

## Development

```sh
npm test
```

The suite covers the guard estimator and an end-to-end vacuum round-trip
(multi-frame input, header-only first frame, PTC pair deep-equality, marker).

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

`dsh-memory-guard` 是一个 DSH 插件（Host + Client），用来防止“单次超大工具参数 /
会话日志膨胀 / Host 堆压力”导致的 OOM。真实案例：一个 954 MB（解压后）的会话日志，
其中 98.5% 是同一次写入在 PTC start/final 中重复保存的参数。

功能：

- 每 3 秒采样 Host 堆，每 15 秒扫描会话日志体积；
- 工具参数超过 2 MiB 直接拒绝，并提示分块写入或让脚本生成文件；
- 单条已落盘事件 ≥8 MiB 告警、≥32 MiB 严重告警；会话日志 ≥50 MiB / ≥200 MiB 分级告警；
- 会话标题栏显示 `MEM xx% · 日志总量` 徽标；
- `/memguard` 查看状态，`/memguard vacuum` 预览冷会话可省空间，
  `/memguard vacuum <id> confirm` 执行离线瘦身（保留 `.orig-时间戳` 备份）。

安装：

```sh
dsh plugin --profile desktop add dsh-memory-guard
```

注意：

- 需要 Node.js ≥ 22.15（使用内置 zstd）；DSH 0.2.1-rc.2 上验证，Windows 实测；
- `run_code` 的 PTC 子调用会先落盘 `ptc-dispatch-start` 再走 guard，插件无法阻止
  第一次写入，只能阻止执行与第二条记录；超大参数请优先用分块写入或脚本生成文件；
- 插件不会改写 live 会话日志，也不会提高 Node 堆上限。
