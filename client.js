// Client half of dsh-memory-guard: a compact header chip fed by the Host's
// /memory-guard/stats endpoint. No client-side Host RPC needed.

const factory = (require) => {
    const React = require('react')
    const h = React.createElement

    function text(bytes) {
      if (!Number.isFinite(bytes)) return 'n/a'
      if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
      if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${bytes} B`
    }

    function Chip() {
      const [stats, setStats] = React.useState(null)

      React.useEffect(() => {
        let alive = true
        let timer = null
        async function tick() {
          try {
            const response = await fetch('/memory-guard/stats', { cache: 'no-store' })
            if (!response.ok) return
            const next = await response.json()
            if (alive) setStats(next)
          } catch {
            /* Host may still be starting; keep the last value */
          }
        }
        tick()
        timer = setInterval(tick, 5000)
        return () => {
          alive = false
          if (timer !== null) clearInterval(timer)
        }
      }, [])

      if (stats === null || stats.heap === null) return null

      const ratio = typeof stats.heap.ratio === 'number' ? stats.heap.ratio : 0
      const percent = Math.round(ratio * 100)
      const level = typeof stats.level === 'string' ? stats.level : 'ok'
      const critical = level === 'critical' || ratio >= 0.9
      const warn = level === 'warn' || ratio >= 0.75
      const top = stats.sessions && Array.isArray(stats.sessions.top) ? stats.sessions.top[0] : null
      const alerts = Array.isArray(stats.alerts) ? stats.alerts : []
      const recent = Array.isArray(stats.recent) ? stats.recent : []
      const title = [
        `Host heap: ${stats.heap.usedText} / ${stats.heap.limitText} (${percent}%)`,
        `RSS: ${text(stats.heap.rss)}`,
        `Session logs: ${stats.sessions.files} files, ${stats.sessions.totalText}`,
        top ? `Largest: ${top.id} ${top.text}` : null,
        `Guard: tool args > ${stats.guard.maxToolArgText} rejected`,
        alerts.length > 0 ? `Alerts (${level}):` : null,
        ...alerts.slice(0, 3).map((alert) => `  [${alert.level}] ${alert.message}`),
        recent.length > 0 ? 'Recent large payloads:' : null,
        ...recent.slice(0, 3).map((entry) => `  ${entry.kind} ${entry.name} ~${text(entry.bytes)}`),
        `Vacuum: /memguard vacuum (dry-run) then /memguard vacuum <session-id> confirm`,
      ]
        .filter(Boolean)
        .join('\n')

      const color = critical
        ? 'var(--dsw-alias-state-error-primary, #d64545)'
        : warn
          ? 'var(--dsw-alias-state-warning-primary, #c98a00)'
          : 'var(--dsw-alias-label-secondary)'

      return h(
        'span',
        {
          title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '11px',
            lineHeight: '18px',
            padding: '1px 8px',
            borderRadius: '999px',
            border: `1px solid ${critical || warn ? color : 'var(--dsw-alias-border-l2)'}`,
            color,
            background: 'var(--dsw-alias-bg-base)',
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
            cursor: 'default',
            userSelect: 'none',
          },
        },
        h('span', null, critical || warn ? `⚠ MEM ${percent}%` : `MEM ${percent}%`),
        h('span', { style: { opacity: 0.7 } }, '·'),
        h('span', null, stats.sessions.totalText),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'memory-guard', order: 20 },
            Chip,
          ),
        )
      },
    }
}

// Register under the published package name and under the legacy local link
// name. Only the id requested by the client module graph is ever materialized;
// the duplicate registration is inert.
window.__ModuleLoader__.load({ id: 'dsh-memory-guard', factory })
window.__ModuleLoader__.load({ id: '@local/dsh-memory-guard', factory })
