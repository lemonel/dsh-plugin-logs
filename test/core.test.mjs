import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { inspect } from 'node:util'
import { LogBuffer, normalize } from '../lib/backend/core.js'

const message = (...args) => ({ ts: 123, name: 'plugin-a', type: 'warn', args })

test('cursor pagination and overwritten gap accounting', () => {
  const buffer = new LogBuffer(3)
  for (let i = 0; i < 5; i++) buffer.push({ text: `${i}` })
  assert.deepEqual(buffer.tail(0, 2), { entries: [{ sequence: 3, text: '2' }, { sequence: 4, text: '3' }], cursor: 4, dropped: 2, epoch: buffer.epoch, reset: false })
  assert.deepEqual(buffer.tail(4, 2, buffer.epoch), { entries: [{ sequence: 5, text: '4' }], cursor: 5, dropped: 0, epoch: buffer.epoch, reset: false })
  assert.equal(buffer.tail(5, 2).cursor, 5)
})

test('random buffer epochs reset to the live window without false dropped counts', () => {
  const old = new LogBuffer(3)
  const buffer = new LogBuffer(3)
  assert.match(buffer.epoch, /^[0-9a-f-]{36}$/)
  assert.notEqual(buffer.epoch, old.epoch)
  for (let i = 0; i < 6; i++) buffer.push({ text: `${i}` })
  const page = buffer.tail(1, 2, old.epoch)
  assert.deepEqual(page, { entries: [{ sequence: 4, text: '3' }, { sequence: 5, text: '4' }], cursor: 5, dropped: 0, epoch: buffer.epoch, reset: true })
  const next = buffer.tail(page.cursor, 2, page.epoch)
  assert.equal(next.reset, false)
  assert.equal(next.dropped, 0)
  assert.deepEqual(next.entries, [{ sequence: 6, text: '5' }])
  assert.equal(buffer.tail(0, 2).reset, false)
  assert.equal(buffer.tail(0, 2).dropped, 3)
})

test('future cursors reset even without an epoch, including empty buffers', () => {
  const buffer = new LogBuffer(2)
  assert.deepEqual(buffer.tail(100, 1), { entries: [], cursor: 0, dropped: 0, epoch: buffer.epoch, reset: true })
  assert.deepEqual(buffer.tail(0, 1, 'old'), { entries: [], cursor: 0, dropped: 0, epoch: buffer.epoch, reset: true })
  assert.equal(buffer.tail().reset, false)
  assert.equal(buffer.tail(0, 1, '').reset, false)
  for (let i = 0; i < 4; i++) buffer.push({ text: `${i}` })
  for (const epoch of [undefined, buffer.epoch, 'old']) {
    const page = buffer.tail(Number.MAX_SAFE_INTEGER, 1, epoch)
    assert.equal(page.reset, true)
    assert.equal(page.dropped, 0)
    assert.equal(page.cursor, 3)
    assert.deepEqual(page.entries, [{ sequence: 3, text: '2' }])
  }
})

test('capacity and cursor/limit validation remains strict', () => {
  for (const capacity of [0, -1, 1.1, NaN, Infinity, '3', 10001]) assert.throws(() => new LogBuffer(capacity), RangeError)
  const buffer = new LogBuffer()
  for (const cursor of [-1, 1.1, NaN, Infinity, '0', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => buffer.tail(cursor, 1, 'old'), RangeError)
  for (const limit of [0, -1, 1.1, NaN, Infinity, '1', 501]) assert.throws(() => buffer.tail(0, limit, 'old'), RangeError)
})

test('normalization detaches cyclic objects, hostile inspectors and weak refs', () => {
  let hooks = 0
  const cyclic = { id: 1 }; cyclic.cause = cyclic
  const hostile = new Proxy({}, {
    ownKeys() { hooks++; throw Error('bad') },
    getOwnPropertyDescriptor() { hooks++; throw Error('bad') },
    get() { hooks++; throw Error('bad') },
    getPrototypeOf() { hooks++; throw Error('bad') },
  })
  const value = { message: 'before', [inspect.custom]() { hooks++; throw Error('bad') }, toJSON() { hooks++; throw Error('bad') } }
  Object.defineProperty(value, 'data', { get() { hooks++; throw Error('bad') } })
  const input = { ...message(cyclic, hostile, value), fiber: new WeakRef({}) }
  const record = normalize(input)
  assert.equal(record.source, 'plugin-a')
  assert.equal(record.level, 'warn')
  assert.equal(record.time, 123)
  assert.match(record.text, /\[Circular\]/)
  assert.match(record.text, /\[Proxy\]/)
  assert.match(record.text, /before/)
  value.message = 'after'
  input.args.length = 0
  assert.match(record.text, /before/)
  assert.equal(hooks, 0)
  assert.deepEqual(Object.keys(record), ['time', 'source', 'level', 'text'])
  assert.equal(JSON.stringify(record).includes('fiber'), false)
})

test('wide plain objects use bounded descriptor probes, never key enumeration', () => {
  const wide = { message: 'visible', sessionId: 'session-1', agentId: 'agent-1' }
  for (let i = 0; i < 100000; i++) Object.defineProperty(wide, `business_${i}`, { get() { throw Error('must not read business fields') }, enumerable: true })
  const descriptor = Object.getOwnPropertyDescriptor
  const keys = Object.keys
  const ownKeys = Reflect.ownKeys
  let probes = 0
  let enumerations = 0
  Object.getOwnPropertyDescriptor = (value, key) => { if (value === wide) probes++; return descriptor(value, key) }
  Object.keys = Reflect.ownKeys = () => { enumerations++; throw Error('must not enumerate') }
  let record
  try { record = normalize(message(wide)) }
  finally { Object.getOwnPropertyDescriptor = descriptor; Object.keys = keys; Reflect.ownKeys = ownKeys }
  assert.equal(enumerations, 0)
  assert.ok(probes > 0 && probes <= 64, `descriptor probes: ${probes}`)
  assert.match(record.text, /visible/)
  assert.match(record.text, /session-1/)
  assert.match(record.text, /agent-1/)
  assert.match(record.text, /…/)
  assert.equal(record.text.includes('business_'), false)
})

test('argument, total property, nesting and output budgets apply before traversal', () => {
  const wide = { message: 'value' }
  const args = Array.from({ length: 100000 }, () => wide)
  const descriptor = Object.getOwnPropertyDescriptor
  let argReads = 0
  let probes = 0
  Object.getOwnPropertyDescriptor = (value, key) => {
    if (value === args && key !== 'length') argReads++
    if (value === wide) probes++
    return descriptor(value, key)
  }
  let record
  try { record = normalize({ ...message(), args }) }
  finally { Object.getOwnPropertyDescriptor = descriptor }
  assert.equal(argReads, 32)
  assert.ok(probes <= 64, `total property probes: ${probes}`)
  assert.ok(record.text.length <= 4096)
  assert.match(record.text, /…$/)
  const nested = { data: { data: { data: { message: 'too deep' } } } }
  assert.equal(normalize(message(nested)).text.includes('too deep'), false)
  const blocked = new Proxy({}, { get() { throw Error('too late') }, ownKeys() { throw Error('too late') } })
  const full = normalize(message('x'.repeat(10_000_000), blocked))
  assert.equal(full.text, 'x'.repeat(4096))
  const array = new Array(100000)
  Object.defineProperty(array, '21', { get() { throw Error('array budget exceeded') } })
  assert.match(normalize(message(array)).text, /…/)
})

test('printf placeholders use bounded safe formatting and preserve unknown/missing tokens', () => {
  assert.equal(normalize(message('%s %d %i %f %%', 'value', 3.9, '4.7', '1.25')).text, 'value 3 4 1.25 %')
  assert.equal(normalize(message('%C %cend', 'colored', 'style')).text, 'colored end')
  assert.equal(normalize(message('%q %s %d', 'ok')).text, '%q ok %d')
  assert.equal(normalize(message('done', 1, true, null)).text, 'done 1 true null')
  assert.match(normalize(message('%o %O %j', { id: 1 }, { code: 2 }, { message: 'safe' })).text, /id: 1.*code: 2.*safe/)
  const hostile = { toString() { throw Error('coercion') }, valueOf() { throw Error('coercion') }, [Symbol.toPrimitive]() { throw Error('coercion') } }
  assert.equal(normalize(message('%s %d', hostile, hostile)).text, '{ … } [non-numeric]')
  assert.equal(normalize(message('%d', '9'.repeat(1000000))).text, '[non-numeric]')
  assert.equal(normalize(message(1n << 1000000n)).text, '[BigInt]')
})

test('Error previews preserve useful fields without evaluating lazy stacks', () => {
  const original = Error.prepareStackTrace
  let calls = 0
  Error.prepareStackTrace = () => { calls++; throw Error('must not prepare stack') }
  let record
  try { record = normalize(message(Object.assign(new Error('failure'), { code: 'E_TEST', cause: { message: 'root' } }))) }
  finally { Error.prepareStackTrace = original }
  assert.equal(calls, 0)
  assert.match(record.text, /failure/)
  assert.match(record.text, /E_TEST/)
  assert.match(record.text, /root/)
  assert.match(normalize(message({ stack: 'already materialized' })).text, /already materialized/)
})

test('metadata, accessors, revoked proxies and malformed arguments never run user code', () => {
  let calls = 0
  const input = {}
  for (const key of ['ts', 'name', 'type', 'args', 'fiber']) Object.defineProperty(input, key, { get() { calls++; throw Error('getter') } })
  const record = normalize(input)
  assert.equal(record.source, 'unknown')
  assert.equal(record.level, 'info')
  assert.ok(Math.abs(normalize({ ...message('bad date'), ts: 1e20 }).time) <= 8640000000000000)
  assert.equal(calls, 0)
  const { proxy, revoke } = Proxy.revocable([], {})
  revoke()
  for (const value of [proxy, null, undefined, {}, new Proxy({}, { get() { throw Error('bad') } })]) {
    assert.doesNotThrow(() => normalize(value))
    assert.doesNotThrow(() => normalize(message(value)))
  }
  assert.equal(normalize({ ...message('text'), name: { toString() { throw Error('bad') } } }).source, 'unknown')
  const sparse = new Array(2)
  Object.defineProperty(sparse, '0', { get() { calls++; throw Error('arg getter') } })
  assert.match(normalize({ ...message(), args: sparse }).text, /unavailable/)
  assert.equal(calls, 0)
})

test('huge text and source strings are copied, not retained as sliced backing stores', () => {
  // Isolate a V8 heap snapshot from the test runner. A slice-only implementation
  // retains the >4MB parent string, visible in snapshot.strings after full GC.
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { randomBytes } from 'node:crypto'
    import { getHeapSnapshot } from 'node:v8'
    import { normalize } from ${JSON.stringify(new URL('../lib/backend/core.js', import.meta.url).href)}
    globalThis.record = (() => {
      const huge = 'detachment-regression-' + randomBytes(2 * 1024 * 1024).toString('hex')
      return normalize({ ts: 1, name: huge, type: 'info', args: [huge] })
    })()
    globalThis.gc()
    assert.equal(record.text.length, 4096)
    assert.equal(record.source.length, 160)
    const chunks = []
    for await (const chunk of getHeapSnapshot()) chunks.push(chunk)
    const snapshot = JSON.parse(Buffer.concat(chunks).toString())
    assert.equal(snapshot.strings.some(value => value.length > 1024 * 1024 && value.startsWith('detachment-regression-')), false, 'retained huge parent string')
  `], { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  const lone = '\ud800'.repeat(5000)
  const record = normalize({ ...message(lone), name: lone })
  assert.equal(record.text, lone.slice(0, 4096))
  assert.equal(record.source, lone.slice(0, 160))
})
