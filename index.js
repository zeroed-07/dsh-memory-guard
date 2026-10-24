// Host half of dsh-memory-guard.
//
// Goals:
//  1) a single tool call cannot EXECUTE with more than maxToolArgBytes of
//     arguments (guard), and oversized results are reported;
//  2) per-session log size is measured, alerted on, and cold logs can be
//     vacuumed on demand (the only safe way to shrink an existing log);
//  3) host V8 heap and live alert state are visible, so an ineffective
//     NODE_OPTIONS and a growing session are noticed early.
//
// KNOWN HOST LIMIT: for PTC (`run_code`) sub-calls the Host appends
// `tool/ptc-dispatch-start` (full arguments) BEFORE running tools/pre-execute
// and the guard (dsh-tools/lib/index.js:1424 vs :1431/:3321). A guard can stop
// execution but cannot stop that first log write. Native `tool/call` rows are
// likewise logged before the tool runs. The guard therefore halves the damage
// (no final dispatch row, no execution), while alerting + offline vacuum cover
// the rest. The plugin never rewrites a live session log.

import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { getHeapStatistics } from 'node:v8'
import { scan as vacuumScan, vacuum as vacuumWrite, verify as vacuumVerify } from './lib/vacuum.js'

export const name = 'memory-guard'
export const inject = ['tools', 'commands']

const MB = 1024 * 1024

const DEFAULTS = {
  guardEnabled: true,
  guardExemptTools: [],
  maxToolArgBytes: 2 * MB,
  noticeToolArgBytes: 512 * 1024,
  heapWarnRatio: 0.75,
  heapCriticalRatio: 0.9,
  sessionLogWarnBytes: 50 * MB,
  sessionLogCriticalBytes: 200 * MB,
  maxEventWarnBytes: 8 * MB,
  maxEventCriticalBytes: 32 * MB,
  vacuumMinBytes: 10 * MB,
  notifyCooldownMs: 5 * 60 * 1000,
  maxRecent: 12,
  maxAlerts: 20,
  sampleIntervalMs: 3000,
  scanIntervalMs: 15000,
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'n/a'
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** Iterative byte estimate of parsed tool arguments (no JSON.stringify of the whole tree). */
export function estimateBytes(value, stopAfter = 8 * MB) {
  let bytes = 0
  const stack = [value]
  while (stack.length > 0) {
    if (bytes > stopAfter) return bytes
    const v = stack.pop()
    if (typeof v === 'string') {
      bytes += Buffer.byteLength(v)
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      bytes += 8
    } else if (Array.isArray(v)) {
      bytes += 2
      for (const item of v) stack.push(item)
    } else if (typeof v === 'object') {
      bytes += 2
      for (const key of Object.keys(v)) {
        bytes += Buffer.byteLength(key) + 3
        stack.push(v[key])
      }
    }
  }
  return bytes
}

/** Pure guard decision, exported for tests. */
export function decideGuard(toolName, args, limit) {
  const bytes = estimateBytes(args, limit * 4 + 65536)
  if (bytes <= limit) return { bytes, reason: undefined }
  const reason =
    `[memory-guard] 已拒绝 ${toolName}：本次参数约 ${fmtBytes(bytes)}，超过单次上限 ${fmtBytes(limit)}。` +
    `请改为分块写入（多次少量追加），或让脚本从磁盘读取源数据直接生成文件，避免把大内容放进工具参数。`
  return { bytes, reason }
}

function readHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env.length > 0) return env
  return path.join(os.homedir(), '.dsh')
}

async function walkSessionLogs(dir, depth, out) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < 4) await walkSessionLogs(full, depth + 1, out)
      continue
    }
    if (entry.name !== 'session.v4.jsonl.zstd' && entry.name !== 'session.jsonl.zstd') continue
    try {
      const st = await fsp.stat(full)
      out.push({ id: path.basename(path.dirname(full)), file: full, bytes: st.size, mtime: st.mtimeMs })
    } catch {
      /* a session may be removed while scanning */
    }
  }
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const home = readHome()
  const sessionsDir = path.join(home, 'sessions')
  const state = {
    heap: null,
    logs: [],
    logsTotalBytes: 0,
    scannedAt: 0,
    liveSessions: 0,
    recent: [],
    alerts: [],
    level: 'ok',
  }
  const alertSeen = new Map()

  // ---- alerts ------------------------------------------------------------
  function raiseAlert(level, code, message, sessionId = '') {
    const key = `${code}:${sessionId}`
    const now = Date.now()
    const last = alertSeen.get(key)
    if (typeof last === 'number' && now - last < Math.max(1000, cfg.notifyCooldownMs)) return
    alertSeen.set(key, now)
    state.alerts.unshift({ level, code, message, sessionId, at: now })
    if (state.alerts.length > cfg.maxAlerts) state.alerts.length = cfg.maxAlerts
    state.level = state.alerts.some((a) => a.level === 'critical') ? 'critical' : state.alerts.length > 0 ? 'warn' : 'ok'
    console.warn(`[memory-guard] ${level.toUpperCase()} ${code}: ${message}`)
  }

  // ---- host heap ---------------------------------------------------------
  function sampleHeap() {
    try {
      const usage = process.memoryUsage()
      const hs = getHeapStatistics()
      const limit = hs.heap_size_limit
      state.heap = {
        used: usage.heapUsed,
        limit,
        rss: usage.rss,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        ratio: limit > 0 ? usage.heapUsed / limit : 0,
        at: Date.now(),
      }
      if (state.heap.ratio >= cfg.heapCriticalRatio) {
        raiseAlert('critical', 'heap-critical', `host 堆已用 ${(state.heap.ratio * 100).toFixed(1)}%（${fmtBytes(usage.heapUsed)} / ${fmtBytes(limit)}）`)
      } else if (state.heap.ratio >= cfg.heapWarnRatio) {
        raiseAlert('warn', 'heap-warn', `host 堆已用 ${(state.heap.ratio * 100).toFixed(1)}%（${fmtBytes(usage.heapUsed)} / ${fmtBytes(limit)}）`)
      }
      if (limit > 0 && limit < 4 * 1024 * MB) {
        raiseAlert('warn', 'heap-limit-low', `host 堆上限只有 ${fmtBytes(limit)}，NODE_OPTIONS 很可能没有传进 host 进程`)
      }
    } catch {
      /* ignore sampling errors */
    }
  }

  // ---- session log sizes -------------------------------------------------
  function liveIds() {
    try {
      const list = ctx.get('sessions')?.list?.() ?? []
      return new Set(list.map((session) => session?.id).filter((id) => typeof id === 'string'))
    } catch {
      return new Set()
    }
  }

  async function scanSessionLogs() {
    const logs = []
    await walkSessionLogs(sessionsDir, 0, logs)
    logs.sort((a, b) => b.bytes - a.bytes)
    state.logs = logs
    state.logsTotalBytes = logs.reduce((sum, item) => sum + item.bytes, 0)
    state.scannedAt = Date.now()
    const live = liveIds()
    state.liveSessions = live.size
    for (const item of logs) {
      if (item.bytes >= cfg.sessionLogCriticalBytes) {
        raiseAlert('critical', 'session-log-critical', `会话日志 ${fmtBytes(item.bytes)}，已超过 ${fmtBytes(cfg.sessionLogCriticalBytes)}`, item.id)
      } else if (item.bytes >= cfg.sessionLogWarnBytes) {
        raiseAlert('warn', 'session-log-warn', `会话日志 ${fmtBytes(item.bytes)}，接近危险体积`, item.id)
      }
      void live
    }
  }

  function noteRecent(entry) {
    state.recent.unshift(entry)
    if (state.recent.length > cfg.maxRecent) state.recent.length = cfg.maxRecent
  }

  // ---- observe rows that were already appended to the log -----------------
  const offEvent = ctx.on('session/event', (session, event) => {
    try {
      const type = event?.type
      if (type !== 'tool/call' && type !== 'tool/ptc-dispatch' && type !== 'tool/ptc-dispatch-start') return
      const data = event?.data ?? {}
      let bytes = 0
      if (typeof data.arguments === 'string') bytes = Buffer.byteLength(data.arguments)
      else if (data.arguments && typeof data.arguments === 'object') bytes = estimateBytes(data.arguments, 64 * MB)
      if (typeof data.content === 'string') bytes += Buffer.byteLength(data.content)
      if (bytes < cfg.noticeToolArgBytes) return
      noteRecent({
        source: 'log',
        kind: type,
        name: typeof data.name === 'string' ? data.name : type,
        sessionId: session?.id ?? '',
        bytes,
        at: Date.now(),
      })
      if (bytes >= cfg.maxEventCriticalBytes) {
        raiseAlert('critical', 'event-critical', `${type} 已落盘 ${fmtBytes(bytes)}（${String(data.name ?? type)}）`, session?.id ?? '')
      } else if (bytes >= cfg.maxEventWarnBytes) {
        raiseAlert('warn', 'event-warn', `${type} 已落盘 ${fmtBytes(bytes)}（${String(data.name ?? type)}）`, session?.id ?? '')
      }
    } catch {
      /* observers must never break an append */
    }
  })
  ctx.effect(() => offEvent)

  // ---- runtime guard -----------------------------------------------------
  const exempt = new Set(Array.isArray(cfg.guardExemptTools) ? cfg.guardExemptTools : [])
  const offGuard = ctx.tools.guard((exec) => {
    if (cfg.guardEnabled === false || exempt.has(exec.name)) return undefined
    const decision = decideGuard(exec.name, exec.arguments, cfg.maxToolArgBytes)
    if (decision.reason === undefined) return undefined
    noteRecent({
      source: 'guard',
      kind: 'tool/guard',
      name: exec.name,
      sessionId: exec.agent?.id ?? '',
      bytes: decision.bytes,
      at: Date.now(),
    })
    return decision.reason
  })
  ctx.effect(() => offGuard)

  // ---- offline vacuum for cold sessions ----------------------------------
  async function candidates(minBytes = cfg.vacuumMinBytes) {
    const live = liveIds()
    const out = []
    for (const item of state.logs) {
      if (live.has(item.id)) continue
      if (item.bytes < minBytes) continue
      out.push(item)
      if (out.length >= 5) break
    }
    return out
  }

  async function scanVacuum() {
    const list = await candidates()
    const rows = []
    for (const item of list) {
      try {
        const r = await vacuumScan(item.file)
        rows.push({
          id: item.id,
          file: item.file,
          bytes: item.bytes,
          lines: r.lines,
          oversizedLines: r.oversizedLines,
          savingsBytes: r.oversizedBytes,
          afterBytes: r.expectedBytesAfter,
        })
      } catch (error) {
        rows.push({ id: item.id, file: item.file, bytes: item.bytes, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return rows
  }

  async function vacuumOne(sessionId) {
    const live = liveIds()
    if (live.has(sessionId)) throw new Error(`会话 ${sessionId} 仍在运行，拒绝改写 live 日志`)
    const item = state.logs.find((entry) => entry.id === sessionId)
    if (!item) throw new Error(`未找到会话 ${sessionId}`)
    const out = `${item.file}.vacuumed`
    const result = await vacuumWrite({ file: item.file, out })
    const check = await vacuumVerify(out)
    if (!check.ok) {
      await fsp.rm(out, { force: true })
      throw new Error(`vacuum 输出校验失败：${check.reason}`)
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = `${item.file}.orig-${stamp}`
    await fsp.rename(item.file, backup)
    await fsp.rename(out, item.file)
    await scanSessionLogs()
    return {
      id: sessionId,
      beforeBytes: item.bytes,
      afterBytes: check.lines === undefined ? undefined : (await fsp.stat(item.file)).size,
      backup,
      lines: check.lines,
      changedLines: result.changedLines,
      removedBytes: result.removedBytes,
    }
  }

  // ---- /memguard command -------------------------------------------------
  function buildReport() {
    const heap = state.heap
    const lines = []
    lines.push('memory-guard 状态')
    if (heap) {
      lines.push(
        `host 堆：${fmtBytes(heap.used)} / ${fmtBytes(heap.limit)}（${(heap.ratio * 100).toFixed(1)}%），RSS ${fmtBytes(heap.rss)}`,
      )
      if (heap.limit < 4 * 1024 * MB) {
        lines.push(`⚠ host 堆上限只有 ${fmtBytes(heap.limit)}。NODE_OPTIONS 很可能没有传进 host 进程；单个 900MB 级会话即可耗尽它。`)
      }
    } else {
      lines.push('host 堆：尚未采样')
    }
    lines.push(`会话日志：${state.logs.length} 个文件，合计 ${fmtBytes(state.logsTotalBytes)}（live 会话 ${state.liveSessions}）`)
    for (const item of state.logs.slice(0, 5)) {
      const flag = item.bytes >= cfg.sessionLogWarnBytes ? ' ⚠' : ''
      lines.push(`  ${item.id}  ${fmtBytes(item.bytes)}${flag}`)
    }
    if (state.alerts.length > 0) {
      lines.push(`告警（${state.level}）：`)
      for (const alert of state.alerts.slice(0, 5)) {
        lines.push(`  [${alert.level}] ${alert.message}`)
      }
    }
    if (state.recent.length > 0) {
      lines.push('近期大参数：')
      for (const entry of state.recent.slice(0, 5)) {
        lines.push(`  ${entry.kind} ${entry.name} 约 ${fmtBytes(entry.bytes)}  (${entry.source})`)
      }
    }
    lines.push(`拦截规则：单次工具参数 > ${fmtBytes(cfg.maxToolArgBytes)} 直接拒绝；单事件 > ${fmtBytes(cfg.maxEventWarnBytes)} 告警；会话日志 > ${fmtBytes(cfg.sessionLogWarnBytes)} 告警。`)
    lines.push('离线瘦身：/memguard vacuum（dry-run）→ /memguard vacuum confirm（对冷会话执行，保留 .orig 备份）')
    return lines.join('\n')
  }

  function vacuumReport(rows) {
    if (rows.length === 0) return '没有超过阈值的冷会话需要瘦身。'
    const lines = ['冷会话瘦身候选（dry-run，未改动任何文件）：']
    for (const row of rows) {
      if (row.error !== undefined) {
        lines.push(`  ${row.id}  ${fmtBytes(row.bytes)}  扫描失败：${row.error}`)
        continue
      }
      lines.push(`  ${row.id}  ${fmtBytes(row.bytes)}  ${row.lines} 行，可省 ${fmtBytes(row.savingsBytes)} → 预计 ${fmtBytes(row.afterBytes)}`)
    }
    lines.push('执行：/memguard vacuum <session-id> confirm')
    return lines.join('\n')
  }

  const offCommand = ctx.commands.register({
    name: 'memguard',
    description: 'Host heap + session log guard: /memguard, /memguard vacuum, /memguard vacuum <id> confirm',
    input: { hint: '[vacuum | vacuum <session-id> confirm]' },
    recordInput: true,
    handler: async (invocation) => {
      try {
        const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput.trim() : ''
        const tokens = raw.length > 0 ? raw.split(/\s+/) : []
        if (tokens[0] === 'vacuum') {
          if (tokens.includes('confirm') && tokens.length >= 2 && !tokens[1].startsWith('-')) {
            const id = tokens[1] === 'confirm' ? undefined : tokens[1]
            if (id === undefined) return { kind: 'error', text: '用法：/memguard vacuum <session-id> confirm' }
            const result = await vacuumOne(id)
            return {
              kind: 'success',
              text: `已瘦身 ${result.id}\n  ${fmtBytes(result.beforeBytes)} → ${fmtBytes(result.afterBytes)}（${result.lines} 行，改动 ${result.changedLines} 行，省 ${fmtBytes(result.removedBytes)}）\n  原件备份：${result.backup}`,
            }
          }
          const rows = await scanVacuum()
          return { kind: 'success', text: vacuumReport(rows) }
        }
        return { kind: 'success', text: buildReport() }
      } catch (error) {
        return { kind: 'error', text: `memory-guard: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  })
  ctx.effect(() => offCommand)

  // ---- `memguard` tool (also reachable when the slash command is awkward) --
  const offTool = ctx.tools.register({
    name: 'memguard',
    description:
      'Inspect Host heap and session-log sizes, dry-run offline vacuum on cold session logs, or apply vacuum to one cold log. ' +
      'action="status" returns heap + top sessions + alerts; action="vacuum-scan" is read-only; ' +
      'action="vacuum-apply" needs sessionId and confirm=true, keeps a .orig-<timestamp> backup, and never touches a live session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['status', 'vacuum-scan', 'vacuum-apply'], description: 'Operation to run.' },
        sessionId: { type: 'string', description: 'Session id for vacuum-apply (directory name under $DSH_HOME/sessions).' },
        confirm: { type: 'boolean', description: 'Must be true for vacuum-apply; otherwise only a dry-run preview is returned.' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(args, value) {
        return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const action = typeof args?.action === 'string' ? args.action : 'status'
      if (action === 'status') return { ok: true, action, text: buildReport(), snapshot: snapshot() }
      if (action === 'vacuum-scan' || action === 'vacuum-apply') {
        if (action === 'vacuum-apply' && args?.confirm === true && typeof args?.sessionId === 'string') {
          const result = await vacuumOne(args.sessionId)
          return {
            ok: true,
            action,
            ...result,
            text: `已瘦身 ${result.id}\n  ${fmtBytes(result.beforeBytes)} → ${fmtBytes(result.afterBytes)}（${result.lines} 行，改动 ${result.changedLines} 行，省 ${fmtBytes(result.removedBytes)}）\n  原件备份：${result.backup}`,
          }
        }
        const rows = await scanVacuum()
        return { ok: true, action: 'vacuum-scan', dryRun: true, rows, text: vacuumReport(rows) }
      }
      return { ok: false, action, text: `unknown action: ${action}` }
    },
  })
  ctx.effect(() => offTool)


  // ---- local HTTP feed for the header chip ------------------------------
  function snapshot() {
    const heap = state.heap
    return {
      at: Date.now(),
      level: state.level,
      heap: heap
        ? {
            used: heap.used,
            limit: heap.limit,
            ratio: heap.ratio,
            rss: heap.rss,
            usedText: fmtBytes(heap.used),
            limitText: fmtBytes(heap.limit),
          }
        : null,
      sessions: {
        files: state.logs.length,
        live: state.liveSessions,
        totalBytes: state.logsTotalBytes,
        totalText: fmtBytes(state.logsTotalBytes),
        top: state.logs.slice(0, 5).map((item) => ({ id: item.id, bytes: item.bytes, text: fmtBytes(item.bytes) })),
      },
      recent: state.recent.slice(0, 5),
      alerts: state.alerts.slice(0, 5),
      guard: { maxToolArgBytes: cfg.maxToolArgBytes, maxToolArgText: fmtBytes(cfg.maxToolArgBytes) },
    }
  }

  function registerRoutes(webServer) {
    if (!webServer || typeof webServer.register !== 'function') return
    ctx.effect(() =>
      webServer.register({
        kind: 'prefix',
        path: '/memory-guard',
        handler: async (req, res) => {
          try {
            const origin = req.headers.origin
            if (typeof origin === 'string' && origin.length > 0) {
              const expected = `${req.headers['x-forwarded-proto'] ?? 'http'}://${req.headers.host}`
              if (origin !== expected) return json(res, 403, { error: 'cross-origin request rejected' })
            }
            const url = new URL(req.url ?? '/', 'http://local')
            if (url.pathname === '/memory-guard/stats' && (req.method === 'GET' || req.method === 'HEAD')) {
              return json(res, 200, snapshot())
            }
            if (url.pathname === '/memory-guard/limit' && req.method === 'POST') {
              const chunks = []
              let size = 0
              for await (const chunk of req) {
                size += chunk.length
                if (size > 64 * 1024) {
                  req.destroy()
                  return
                }
                chunks.push(chunk)
              }
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              const next = Number(body?.maxToolArgBytes)
              if (!Number.isFinite(next) || next < 0) return json(res, 400, { error: 'maxToolArgBytes must be a non-negative number' })
              cfg.maxToolArgBytes = Math.floor(next)
              return json(res, 200, { ok: true, maxToolArgBytes: cfg.maxToolArgBytes, maxToolArgText: fmtBytes(cfg.maxToolArgBytes) })
            }
            if (url.pathname === '/memory-guard/vacuum' && req.method === 'POST') {
              const rows = await scanVacuum()
              return json(res, 200, { dryRun: true, rows })
            }
            return json(res, 404, { error: 'not found' })
          } catch (error) {
            return json(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
        },
      }),
    )
  }

  const webServer = ctx.get('webServer')
  if (webServer) registerRoutes(webServer)
  else if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => registerRoutes(scope.get('webServer')))
    } catch {
      /* HTTP feed is optional */
    }
  }

  // ---- sampling loops ----------------------------------------------------
  sampleHeap()
  scanSessionLogs().catch(() => {})
  const heapTimer = setInterval(sampleHeap, Math.max(500, Number(cfg.sampleIntervalMs) || 3000))
  heapTimer.unref?.()
  ctx.effect(() => () => clearInterval(heapTimer))

  const scanTimer = setInterval(() => {
    scanSessionLogs().catch(() => {})
  }, Math.max(2000, Number(cfg.scanIntervalMs) || 15000))
  scanTimer.unref?.()
  ctx.effect(() => () => clearInterval(scanTimer))

  console.log(`[memory-guard] active: home=${home} maxToolArgBytes=${cfg.maxToolArgBytes}`)
}
