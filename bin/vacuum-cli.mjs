#!/usr/bin/env node
// Offline vacuum CLI for DSH session logs (session.v4.jsonl.zstd).
//
// usage:
//   dsh-memory-guard-vacuum <file.zstd> scan
//   dsh-memory-guard-vacuum <file.zstd> write [--out=path] [--max-string-mb=1]
import { stat } from 'node:fs/promises'
import { vacuum, scan, verify } from '../lib/vacuum.js'

const [file, mode, ...rest] = process.argv.slice(2)
if (!file || !mode) {
  console.error('usage: dsh-memory-guard-vacuum <file> <scan|write> [--out=path] [--max-string-mb=N]')
  process.exit(2)
}
const opt = Object.fromEntries(
  rest.map((arg) => {
    const match = /^--([^=]+)=(.*)$/.exec(arg)
    return match ? [match[1], match[2]] : [arg.replace(/^--/, ''), true]
  }),
)

if (mode === 'scan') {
  console.log(JSON.stringify(await scan(file), null, 2))
  process.exit(0)
}

if (mode !== 'write') {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}

const out = typeof opt.out === 'string' ? opt.out : file.replace(/\.zstd$/, '') + '.vacuumed.jsonl.zstd'
const maxMb = Number(opt['max-string-mb'] ?? 1)
const startedAt = Date.now()
const result = await vacuum({ file, out, maxStringBytes: maxMb * 1024 * 1024 })
const check = await verify(out)
const src = await stat(file)
const dst = await stat(out)
console.log(
  JSON.stringify(
    {
      out,
      ms: Date.now() - startedAt,
      srcBytes: src.size,
      outBytes: dst.size,
      verify: check,
      result,
    },
    null,
    2,
  ),
)
if (!check.ok) process.exitCode = 1
