// Shared offline vacuum core for DSH session.v4.jsonl.zstd files.
//
// WHY: run_code's PTC bridge logs BOTH `tool/ptc-dispatch-start` (arguments) and
// the matching `tool/ptc-dispatch` (same arguments + result) for every sub-call.
// Large `write` payloads are therefore stored twice: a 47 MB file becomes ~95 MB
// of log. The session format validator requires the start/final pair to carry
// DEEP-EQUAL `arguments`, so dropping lines is NOT safe. The safe transform is
// to replace oversized argument strings with an identical marker in BOTH events:
// structure, seq numbers and pairing stay valid, the payload stops being stored
// twice, and the file's real content is untouched on disk.
//
// FRAME LAYOUT: DSH's reader requires the FIRST zstd frame to contain exactly the
// header line, and every frame must end on a complete JSONL record boundary.
// (dsh-session-persistence-jsonl asserts this when reading.) We therefore write
// the header as its own frame and pack events into ~1 MiB frames.
//
// SAFETY: never rewrites the source in place here. Callers get a separate output
// file and are responsible for backup/rename.
import { promises as fsp } from 'node:fs'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528
const FCS_BYTES = [0, 2, 4, 8]
const PACK_BYTES = 1 << 20
const DEFAULT_MAX_STRING_BYTES = 1 << 20

export const MARK = (bytes) =>
  `[dsh-memory-guard vacuum: removed ${bytes} bytes of oversized argument; original stays on disk]`

/** Yields {start, end} compressed byte ranges of each zstd frame in `buf`. */
export function* frameRanges(buf) {
  let off = 0
  while (off < buf.length) {
    const start = off
    if (off + 4 > buf.length) throw new Error(`truncated frame header at ${off}`)
    if (buf.readUInt32LE(off) !== MAGIC) throw new Error(`bad zstd magic at ${off}`)
    off += 4
    if (off + 1 > buf.length) throw new Error(`truncated frame descriptor at ${off}`)
    const fhd = buf[off++]
    const fcsFlag = (fhd >> 6) & 3
    const single = (fhd >> 5) & 1
    const checksum = (fhd >> 2) & 1
    const dictFlag = fhd & 3
    if (!single) off += 1 // window descriptor
    off += fcsFlag === 0 ? (single ? 1 : 0) : FCS_BYTES[fcsFlag]
    off += [0, 1, 2, 4][dictFlag]
    for (;;) {
      if (off + 3 > buf.length) throw new Error(`truncated block header at ${off}`)
      const bh = buf.readUIntLE(off, 3)
      off += 3
      const last = bh & 1
      const type = (bh >> 1) & 3
      const size = bh >>> 3
      if (type === 0) off += size
      else if (type === 1) off += 1
      else if (type === 2) off += size
      else throw new Error('reserved block type')
      if (off > buf.length) throw new Error(`truncated block payload at ${off}`)
      if (last) break
    }
    if (checksum) off += 4
    yield { start, end: off }
  }
}

/** Yields each decompressed frame as a Buffer, in file order. */
export function* decompressedFrames(buf) {
  for (const { start, end } of frameRanges(buf)) {
    yield zstdDecompressSync(buf.subarray(start, end))
  }
}

/** Async JSONL line reader across concatenated zstd frames (newline stripped). */
export async function* linesOf(filePath) {
  const buf = await fsp.readFile(filePath)
  let carry = Buffer.alloc(0)
  for (const frame of decompressedFrames(buf)) {
    let chunk = carry.length > 0 ? Buffer.concat([carry, frame]) : frame
    let nl
    while ((nl = chunk.indexOf(0x0a)) !== -1) {
      yield chunk.subarray(0, nl)
      chunk = chunk.subarray(nl + 1)
    }
    carry = Buffer.from(chunk)
  }
  if (carry.length > 0) yield carry
}

function safeParse(line) {
  try {
    return JSON.parse(line.toString('utf8'))
  } catch {
    return undefined
  }
}

function isPayloadEvent(evt) {
  return evt?.type === 'tool/ptc-dispatch-start' || evt?.type === 'tool/ptc-dispatch'
}

/** Replace oversized top-level string fields of `arguments` deterministically. */
export function truncateArguments(args, maxStringBytes = DEFAULT_MAX_STRING_BYTES) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { args, changed: 0 }
  let changed = 0
  let out = args
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue
    const bytes = Buffer.byteLength(value)
    if (bytes <= maxStringBytes) continue
    if (out === args) out = { ...args }
    out[key] = MARK(bytes)
    changed += bytes
  }
  return { args: out, changed }
}

/**
 * Pass 1: measure savings without writing.
 * @param {string} file
 * @param {{maxStringBytes?: number}} [opts]
 */
export async function scan(file, opts = {}) {
  const maxStringBytes = opts.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES
  let lines = 0
  let total = 0
  let maxLine = 0
  let oversizedLines = 0
  let oversizedBytes = 0
  let header
  for await (const line of linesOf(file)) {
    lines += 1
    const bytes = line.length + 1
    total += bytes
    if (bytes > maxLine) maxLine = bytes
    const evt = safeParse(line)
    if (evt === undefined) continue
    if (lines === 1) header = evt
    if (!isPayloadEvent(evt)) continue
    const { changed } = truncateArguments(evt.data?.arguments, maxStringBytes)
    if (changed > 0) {
      oversizedLines += 1
      oversizedBytes += changed
    }
  }
  return {
    file,
    lines,
    totalBytes: total,
    maxLine,
    oversizedLines,
    oversizedBytes,
    expectedBytesAfter: total - oversizedBytes,
    headerType: header?.type,
    headerVersion: header?.version,
  }
}

/**
 * Pass 2: write a vacuumed copy; oversized argument strings are replaced in
 * both start and final events (deterministically, so the pair stays deep-equal).
 *
 * @param {{file: string, out: string, maxStringBytes?: number}} opts
 */
export async function vacuum({ file, out, maxStringBytes = DEFAULT_MAX_STRING_BYTES }) {
  const before = await scan(file, { maxStringBytes })
  const frames = []
  let pack = Buffer.alloc(0)
  const flush = () => {
    if (pack.length === 0) return
    frames.push(zstdCompressSync(pack))
    pack = Buffer.alloc(0)
  }

  let writtenLines = 0
  let writtenBytes = 0
  let changedLines = 0
  let removedBytes = 0
  for await (const line of linesOf(file)) {
    const evt = safeParse(line)
    let keep = line
    if (evt !== undefined && isPayloadEvent(evt)) {
      const { args, changed } = truncateArguments(evt.data?.arguments, maxStringBytes)
      if (changed > 0) {
        evt.data.arguments = args
        keep = Buffer.from(JSON.stringify(evt))
        changedLines += 1
        removedBytes += line.length + 1 - (keep.length + 1)
      }
    }
    const record = Buffer.concat([keep, Buffer.from('\n')])
    writtenLines += 1
    writtenBytes += record.length
    if (writtenLines === 1) {
      frames.push(zstdCompressSync(record))
      continue
    }
    pack = pack.length === 0 ? record : Buffer.concat([pack, record])
    if (pack.length >= PACK_BYTES) flush()
  }
  flush()
  await fsp.writeFile(`${out}.tmp`, Buffer.concat(frames))
  await fsp.rename(`${out}.tmp`, out)
  const st = await fsp.stat(out)
  return { ...before, writtenLines, writtenBytes, changedLines, removedBytes, outBytes: st.size }
}

/** Parse-only structural check used before replacing a session log. */
export async function verify(file) {
  let lines = 0
  let first
  let lastOk = false
  for await (const line of linesOf(file)) {
    lines += 1
    if (lines === 1) {
      try {
        first = JSON.parse(line.toString('utf8'))
      } catch {
        return { ok: false, reason: 'header is not JSON', lines }
      }
    }
    try {
      JSON.parse(line.toString('utf8'))
      lastOk = true
    } catch {
      lastOk = false
    }
  }
  if (first?.type !== 'session') return { ok: false, reason: 'first line is not a session header', lines }
  if (first?.version !== 4) return { ok: false, reason: `unsupported session version ${String(first?.version)}`, lines }
  if (!lastOk) return { ok: false, reason: 'last line is not JSON', lines }
  return { ok: true, lines, version: first.version, id: first.id }
}
