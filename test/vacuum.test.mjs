// End-to-end test for the vacuum core: multi-frame input, header-only first
// frame, start/final deep-equal arguments, placeholder marker.
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vacuum, scan, verify, MARK, linesOf, frameRanges } from '../lib/vacuum.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '.tmp')
await fsp.mkdir(dir, { recursive: true })
const src = path.join(dir, 'synthetic.v4.jsonl.zstd')
const out = path.join(dir, 'synthetic.vacuumed.jsonl.zstd')

const big = 'x'.repeat(2 * 1024 * 1024 + 17)
const args = { path: 'a.txt', content: big, note: 'keep me' }
const header = JSON.stringify({ type: 'session', version: 4, id: 'session-synthetic', createdAt: 1, cwd: 'C:/x', agentPreset: 'standard' })
const start = JSON.stringify({ type: 'tool/ptc-dispatch-start', seq: 1, time: 1, data: { rootCallId: 'r', parentCallId: 'p', subCallId: 's', name: 'write', arguments: args } })
const final = JSON.stringify({ type: 'tool/ptc-dispatch', seq: 2, time: 2, data: { rootCallId: 'r', parentCallId: 'p', subCallId: 's', name: 'write', arguments: args, isError: false, content: [], meta: {} } })
const small = JSON.stringify({ type: 'turn/start', seq: 3, time: 3, data: {} })

// Multi-frame: header alone, then the rest.
const frames = [zstdCompressSync(Buffer.from(header + '\n')), zstdCompressSync(Buffer.from([start, final, small].join('\n') + '\n'))]
await fsp.writeFile(src, Buffer.concat(frames))

const before = await scan(src, { maxStringBytes: 1024 * 1024 })
if (before.lines !== 4 || before.oversizedLines !== 2 || before.oversizedBytes <= 0) {
  throw new Error(`scan mismatch: ${JSON.stringify(before)}`)
}

const result = await vacuum({ file: src, out, maxStringBytes: 1024 * 1024 })
const check = await verify(out)
if (!check.ok) throw new Error(`verify failed: ${check.reason}`)
if (result.changedLines !== 2) throw new Error(`expected 2 changed lines, got ${result.changedLines}`)
if (result.writtenLines !== 4) throw new Error(`expected 4 lines, got ${result.writtenLines}`)

// The rewritten pair must still be deep-equal and carry the same marker.
const rows = []
for await (const line of linesOf(out)) rows.push(JSON.parse(line.toString('utf8')))
const a = rows[1].data.arguments
const b = rows[2].data.arguments
if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('start/final arguments diverged')
if (a.content !== MARK(Buffer.byteLength(big))) throw new Error(`marker mismatch: ${a.content}`)
if (a.note !== 'keep me') throw new Error('small string was modified')
if (rows[0].type !== 'session') throw new Error('header frame is not first')

// First frame must decode to exactly the header line.
const buf = await fsp.readFile(out)
const first = [...frameRanges(buf)][0]
const decoded = zstdDecompressSync(buf.subarray(first.start, first.end)).toString('utf8')
if (decoded !== header + '\n') throw new Error(`first frame is not header-only: ${JSON.stringify(decoded.slice(0, 60))}`)

await fsp.rm(dir, { recursive: true, force: true })
console.log(JSON.stringify({ ok: true, beforeLines: before.lines, changedLines: result.changedLines, outBytes: result.outBytes }))
