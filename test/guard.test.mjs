// Unit test for the host guard decision (no DSH runtime needed).
import { decideGuard, estimateBytes } from '../index.js'

const MB = 1024 * 1024
const cases = []

function check(label, ok) {
  cases.push({ label, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

// small call: allowed
{
  const d = decideGuard('write', { path: 'a.txt', content: 'hello' }, 2 * MB)
  check('small write allowed', d.reason === undefined && d.bytes > 0)
}

// 3MB string: denied
{
  const d = decideGuard('write', { path: 'big', content: 'x'.repeat(3 * MB) }, 2 * MB)
  check('3MB write denied', typeof d.reason === 'string' && d.reason.includes('超过单次上限'))
}

// nested arrays/objects counted
{
  const args = { a: ['x'.repeat(1024), { b: 'y'.repeat(2048) }] }
  check('nested estimate >= 3KB', estimateBytes(args) >= 3072)
}

// exact boundary: equal limit produces a finite estimate
{
  const limit = 1024
  const content = 'z'.repeat(limit - 2)
  const d = decideGuard('t', { content }, limit)
  check('boundary estimate finite', Number.isFinite(d.bytes))
}

const failed = cases.filter((c) => !c.ok)
console.log(`\n${cases.length - failed.length}/${cases.length} passed`)
if (failed.length > 0) process.exitCode = 1
