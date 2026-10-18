import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import * as runtime from '../lib/frontend/client-runtime.js'

const { createRegexRunner, createTailPoller, workerMain } = runtime
const rows = [
  { source: 'alpha', level: 'error', text: 'Connection TIMEOUT', extra: () => 'not cloneable' },
  { source: 'beta', level: 'warn', text: 'disk failure' },
  { source: 'alpha.ext', level: 'info', text: 'ready' },
  { source: 'alpha', level: 'info', text: 'ready' },
]

function nodeWorkerFactory(records = []) {
  return main => {
    const worker = new Worker(`
      const { parentPort } = require('node:worker_threads');
      const scope = { postMessage: value => parentPort.postMessage(value) };
      (${main.toString()})(scope);
      parentPort.on('message', data => scope.onmessage({ data }));
    `, { eval: true })
    const adapter = {
      onmessage: null, onerror: null, terminated: 0,
      postMessage(data) { worker.postMessage(data) },
      terminate() { this.terminated++; return worker.terminate() },
    }
    worker.on('message', data => adapter.onmessage?.({ data }))
    worker.on('error', error => adapter.onerror?.(error))
    records.push(adapter)
    return adapter
  }
}

function controlledWorkers() {
  const workers = []
  return {
    workers,
    factory() {
      const worker = { onmessage: null, onerror: null, terminated: 0, data: null,
        postMessage(data) { this.data = data },
        terminate() { this.terminated++ },
      }
      workers.push(worker)
      return worker
    },
  }
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function clock() {
  let nextId = 0
  const timers = new Map()
  return {
    timers,
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    async next() {
      const [id, task] = timers.entries().next().value || []
      assert.ok(task, 'expected a scheduled timer')
      timers.delete(id)
      task.fn()
      await flush()
      return task.delay
    },
    delay() { assert.equal(timers.size, 1); return timers.values().next().value.delay },
  }
}
const record = (sequence = 1) => ({ sequence, time: 123, source: 'test', text: 'ok', level: 'info' })
const page = (entries = [], cursor = 0, epoch = 'first', reset = false, dropped = 0) => ({ entries: entries.map(row => ({ ...record(), ...row })), cursor, epoch, reset, dropped })

test('no regex uses exact source/level filtering without allocating a Worker', async () => {
  const runner = createRegexRunner({ workerFactory() { assert.fail('Worker must not be allocated') } })
  assert.deepEqual(await runner.run(rows, '', '', undefined), { rows, error: null })
  assert.deepEqual((await runner.run(rows, 'alpha', '', [null, '', undefined])).rows, [rows[0], rows[3]])
  assert.deepEqual((await runner.run(rows, '', 'info', '')).rows, rows.slice(2))
  assert.deepEqual((await runner.run(rows, 'alpha', 'info', [''])).rows, [rows[3]])
  assert.deepEqual((await runner.run(rows, 'alpha|beta', '', '')).rows, [])
  assert.deepEqual((await runner.run(rows, '^alpha$', '', '')).rows, [])
  assert.deepEqual((await runner.run(null, '', '', null)).rows, [])
  assert.deepEqual((await runner.run([null, {}], '', '', '')).rows, [null, {}])
  runner.dispose()
})

test('real Worker supports case-insensitive OR, source/level intersection, and original references', async t => {
  const workers = []
  const runner = createRegexRunner({ workerFactory: nodeWorkerFactory(workers), timeoutMs: 2000 })
  t.after(() => runner.dispose())
  let result = await runner.run(rows, '', '', ['timeout', 'failure'])
  assert.equal(result.error, null)
  assert.deepEqual(result.rows, rows.slice(0, 2))
  assert.equal(result.rows[0], rows[0])
  assert.equal(result.rows[0].extra(), 'not cloneable')
  result = await runner.run(rows, 'alpha', 'error', ['', 'failure', 'timeout'])
  assert.deepEqual(result.rows, rows.slice(0, 1))
  result = await runner.run(rows, '', '', '^beta ')
  assert.deepEqual(result.rows, rows.slice(1, 2))
  result = await runner.run(rows, 'alpha.ext', '', 'ready')
  assert.deepEqual(result.rows, rows.slice(2, 3))
  assert.ok(workers.every(worker => worker.terminated === 1))
})

test('real Worker handles null row values without matching literal undefined/null', async t => {
  const runner = createRegexRunner({ workerFactory: nodeWorkerFactory(), timeoutMs: 2000 })
  t.after(() => runner.dispose())
  const values = [{ source: null, text: null }, {}, null, { source: 'a', text: 'ok' }]
  assert.deepEqual((await runner.run(values, '', '', 'undefined|null')).rows, [])
  assert.deepEqual((await runner.run(values, '', '', '^ $')).rows, values.slice(0, 3))
})

test('real Worker reports invalid regex with the original nonempty condition index', async t => {
  const runner = createRegexRunner({ workerFactory: nodeWorkerFactory(), timeoutMs: 2000 })
  t.after(() => runner.dispose())
  for (const data of [rows, []]) {
    const result = await runner.run(data, '', '', ['', 'ready', '('])
    assert.deepEqual(result.rows, [])
    assert.equal(result.error.key, 'regexInvalid')
    assert.equal(result.error.values.n, 3)
    assert.match(result.error.values.error, /regular expression|unterminated/i)
  }
})

test('condition limits and malformed conditions fail before creating Workers', async () => {
  const runner = createRegexRunner({ workerFactory() { assert.fail('invalid input created a Worker') } })
  assert.deepEqual(await runner.run(rows, '', '', ['', 'x'.repeat(201)]), { rows: [], error: { key: 'regexTooLong', values: { n: 2 } } })
  assert.equal((await runner.run(rows, '', '', Array(9).fill('ok'))).error.key, 'regexTooMany')
  for (const value of [false, 1, {}, /a/]) {
    const result = await runner.run(rows, '', '', ['', value])
    assert.equal(result.error.key, 'regexInvalid')
    assert.equal(result.error.values.n, 2)
  }
  runner.dispose()
})

test('exactly eight conditions and exactly 200 characters are allowed', async t => {
  const runner = createRegexRunner({ workerFactory: nodeWorkerFactory(), timeoutMs: 2000 })
  t.after(() => runner.dispose())
  assert.equal((await runner.run(rows, '', '', [...Array(7).fill('never'), 'x'.repeat(200)])).error, null)
})

test('new runs settle and terminate stale work; captured stale handlers cannot replace newer output', async () => {
  const fake = controlledWorkers()
  const runner = createRegexRunner({ workerFactory: fake.factory })
  const first = runner.run(rows, '', '', 'timeout')
  const staleMessage = fake.workers[0].onmessage
  const staleError = fake.workers[0].onerror
  const second = runner.run(rows, 'beta', '', 'failure')
  assert.deepEqual(await first, { rows: [], error: null })
  assert.equal(fake.workers[0].terminated, 1)
  assert.equal(fake.workers[0].onmessage, null)
  staleMessage({ data: { indices: [0], error: null } })
  staleError(new Error('stale'))
  fake.workers[1].onmessage({ data: { indices: [0], error: null } })
  assert.deepEqual(await second, { rows: [rows[1]], error: null })
  assert.equal(fake.workers[1].terminated, 1)
  const third = runner.run(rows, '', '', 'ready')
  assert.deepEqual(await runner.run(rows, 'alpha', '', ''), { rows: [rows[0], rows[3]], error: null })
  assert.deepEqual(await third, { rows: [], error: null })
  runner.dispose()
})

test('cancel and dispose settle pending promises, clean once, and tolerate teardown failures', async () => {
  const fake = controlledWorkers()
  const runner = createRegexRunner({ workerFactory: fake.factory })
  const one = runner.run(rows, '', '', 'ready')
  runner.cancel(); runner.cancel()
  assert.deepEqual(await one, { rows: [], error: null })
  assert.equal(fake.workers[0].terminated, 1)
  const two = runner.run(rows, '', '', 'ready')
  fake.workers[1].terminate = () => { throw new Error('termination failed') }
  runner.dispose(); runner.dispose()
  assert.deepEqual(await two, { rows: [], error: null })
  assert.deepEqual(await runner.run(rows, '', '', ''), { rows: [], error: null })
})

test('worker construction, postMessage, runtime, and malformed replies report unavailable', async () => {
  for (const factory of [() => { throw new Error('CSP') }, () => null, () => ({ terminate() {}, postMessage() { throw new Error('clone failed') } })]) {
    const runner = createRegexRunner({ workerFactory: factory })
    assert.equal((await runner.run(rows, '', '', 'ready')).error.key, 'regexUnavailable')
    runner.dispose()
  }
  for (const reply of [null, { indices: [-1] }, { indices: [100] }, { indices: [0.5] }, { indices: 'bad' }, { error: { key: 'other' } }]) {
    const fake = controlledWorkers()
    const runner = createRegexRunner({ workerFactory: fake.factory })
    const pending = runner.run(rows, '', '', 'ready')
    fake.workers[0].onmessage({ data: reply })
    assert.equal((await pending).error.key, 'regexUnavailable')
    assert.equal(fake.workers[0].terminated, 1)
    runner.dispose()
  }
  for (const event of ['onerror', 'onmessageerror']) {
    const fake = controlledWorkers()
    const runner = createRegexRunner({ workerFactory: fake.factory })
    const pending = runner.run(rows, '', '', 'ready')
    fake.workers[0][event](new Error('worker failed'))
    assert.equal((await pending).error.key, 'regexUnavailable')
    runner.dispose()
  }
})

test('real catastrophic backtracking times out off-thread, blocks repeated polling, and query edits unblock', async t => {
  const workers = []
  const runner = createRegexRunner({ workerFactory: nodeWorkerFactory(workers), timeoutMs: 180 })
  t.after(() => runner.dispose())
  const hostile = [{ source: 'alpha', level: 'info', text: `${'a'.repeat(30000)}!` }]
  let heartbeats = 0
  const heartbeat = setInterval(() => heartbeats++, 10)
  t.after(() => clearInterval(heartbeat))
  const started = Date.now()
  const result = await runner.run(hostile, '', '', '(a+)+$')
  assert.equal(result.error.key, 'regexTimeout')
  assert.ok(Date.now() - started < 1500, 'main thread timeout must remain responsive')
  assert.ok(heartbeats >= 2, 'GUI event loop remains responsive')
  assert.equal(workers[0].terminated, 1)
  assert.equal((await runner.run(hostile, 'alpha', 'info', '(a+)+$')).error.key, 'regexTimeout')
  assert.equal(workers.length, 1, 'polling and source/level changes must not restart a blocked regex')
  assert.equal((await runner.run(rows, '', '', '')).error, null)
  assert.equal((await runner.run(hostile, '', '', '(a+)+$')).error.key, 'regexTimeout')
  assert.equal(workers.length, 2, 'editing a query allows retry')
})

test('default browser factory revokes every Blob URL and never executes RegExp on the GUI thread', async () => {
  const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const urls = [], revoked = [], workers = [], timers = new Map()
  let nextTimer = 0
  const context = {
    exports: {}, Blob: class Blob { constructor(parts, options) { this.parts = parts; this.options = options } },
    URL: { createObjectURL(blob) { assert.match(blob.parts[0], /function workerMain/); const url = `blob:${urls.length}`; urls.push(url); return url }, revokeObjectURL(url) { revoked.push(url) } },
    Worker: class BrowserWorker { constructor(url) { this.url = url; this.terminated = 0; workers.push(this) } postMessage(data) { this.data = data } terminate() { this.terminated++ } },
    RegExp: function ForbiddenRegExp() { assert.fail('GUI thread executed regex') },
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id }, clearTimeout(id) { timers.delete(id) },
  }
  context.window = { __ModuleLoader__: { load(value) { context.exports = value.factory(() => ({})) } } }
  vm.runInNewContext(code, context)
  const runner = context.exports.createRegexRunner()
  const pending = runner.run(rows, '', '', '(')
  workers[0].onmessage({ data: { indices: [], error: { key: 'regexInvalid', values: { n: 1, error: 'invalid' } } } })
  assert.equal((await pending).error.key, 'regexInvalid')
  const cancelled = runner.run(rows, '', '', 'ready')
  runner.cancel(); await cancelled
  const timed = runner.run(rows, '', '', '(a+)+$')
  timers.values().next().value()
  assert.equal((await timed).error.key, 'regexTimeout')
  const disposed = runner.run(rows, '', '', 'changed')
  runner.dispose(); await disposed
  assert.deepEqual(revoked, urls)
  assert.equal(timers.size, 0)
  assert.ok(workers.every(worker => worker.terminated === 1))
  context.Worker = class { constructor() { throw new Error('CSP denied') } }
  const broken = context.exports.createRegexRunner()
  assert.equal((await broken.run(rows, '', '', 'ready')).error.key, 'regexUnavailable')
  assert.deepEqual(revoked, urls, 'constructor failure must also revoke its URL')
  broken.dispose()
  context.Worker = undefined
  assert.equal((await context.exports.createRegexRunner().run(rows, '', '', 'ready')).error.key, 'regexUnavailable')
})

test('workerMain export is a self-contained serializable Worker kernel', () => {
  assert.equal(typeof workerMain, 'function')
  assert.match(workerMain.toString(), /scope\.onmessage/)
})

test('poller starts only on first resume, passes cursor/limit/epoch, and forwards reset pages', async () => {
  const time = clock(), calls = [], pages = [], errors = []
  const replies = [page([{ sequence: 10 }], 10, 'epoch-a', false, 9), page([{ sequence: 1 }], 1, 'epoch-b', true), page([], 1, 'epoch-b')]
  const poller = createTailPoller({ tail(...args) { calls.push(args); return Promise.resolve({ ok: true, value: replies.shift() }) } }, { ...time, onPage: value => pages.push(value), onError: error => errors.push(error) })
  assert.equal(calls.length, 0)
  assert.equal(time.timers.size, 0)
  poller.setPaused(true)
  assert.equal(calls.length, 0)
  poller.setPaused(false)
  await flush()
  assert.deepEqual(calls, [[0, 300, '']])
  assert.equal(time.delay(), 1200)
  poller.setPaused(false)
  assert.equal(calls.length, 1)
  await time.next()
  assert.deepEqual(calls[1], [10, 300, 'epoch-a'])
  assert.equal(pages[1].reset, true)
  await time.next()
  assert.deepEqual(calls[2], [1, 300, 'epoch-b'])
  assert.deepEqual(errors, [])
  poller.dispose()
  assert.equal(time.timers.size, 0)
})

test('same-epoch future-cursor resets remain valid for populated and empty buffers', async () => {
  for (const reset of [page([{ sequence: 1 }], 1, 'epoch-a', true), page([], 0, 'epoch-a', true)]) {
    const time = clock(), calls = [], pages = [], errors = []
    const initial = page([{ sequence: 10 }], 10, 'epoch-a', false, 9)
    const idle = page([], reset.cursor, reset.epoch)
    const replies = [initial, reset, idle]
    const poller = createTailPoller({ tail(...args) { calls.push(args); return replies.shift() } }, {
      ...time, onPage: value => pages.push(value), onError: error => errors.push(error),
    })
    try {
      poller.setPaused(false); await flush()
      await time.next(); await time.next()
      assert.deepEqual(errors, [])
      assert.deepEqual(calls, [[0, 300, ''], [10, 300, 'epoch-a'], [reset.cursor, 300, reset.epoch]])
      assert.equal(pages[0], initial)
      assert.equal(pages[1], reset)
      assert.equal(pages[2], idle)
    } finally { poller.dispose() }
  }
})

test('pause/resume retains one inflight request and never overlaps Remote calls', async () => {
  const time = clock(), calls = [], requests = [], pages = []
  let active = 0, peak = 0
  const poller = createTailPoller({ tail(...args) {
    calls.push(args); active++; peak = Math.max(peak, active)
    const request = deferred(); requests.push(request)
    return request.promise.finally(() => active--)
  } }, { ...time, onPage: value => pages.push(value) })
  poller.setPaused(false)
  poller.setPaused(true); poller.setPaused(false); poller.setPaused(true); poller.setPaused(false)
  assert.equal(calls.length, 1)
  requests[0].resolve(page([{ sequence: 7 }], 7, 'a', false, 6))
  await flush()
  assert.equal(pages.length, 1, 'resume consumes the original inflight response')
  await time.next()
  assert.deepEqual(calls[1], [7, 300, 'a'])
  poller.setPaused(true)
  requests[1].resolve(page([{ sequence: 9 }], 9, 'b', true))
  await flush()
  assert.equal(pages.length, 1, 'paused responses are not consumed')
  assert.equal(time.timers.size, 0)
  poller.setPaused(false)
  assert.deepEqual(calls[2], [7, 300, 'a'], 'discarded page cannot move cursor or epoch')
  requests[2].resolve(page([], 7, 'a'))
  await flush()
  assert.equal(peak, 1)
  poller.dispose()
})

test('full pages drain immediately up to maxBurst, yield, then use normal interval for partial pages', async () => {
  const time = clock(), calls = [], pages = []
  const poller = createTailPoller({ tail(cursor, limit, epoch) {
    calls.push([cursor, limit, epoch])
    const entries = calls.length <= 4 ? Array.from({ length: 300 }, (_, index) => record(cursor + index + 1)) : []
    return Promise.resolve(page(entries, cursor + entries.length, 'epoch'))
  } }, { ...time, onPage: value => pages.push(value) })
  poller.setPaused(false)
  await flush()
  assert.equal(calls.length, 4)
  assert.equal(pages.length, 4)
  assert.equal(time.delay(), 16)
  await time.next()
  assert.equal(calls.length, 5)
  assert.equal(time.delay(), 1200)
  assert.deepEqual(calls.slice(0, 3), [[0, 300, ''], [300, 300, 'epoch'], [600, 300, 'epoch']])
  poller.dispose()
})

test('poller supports configured maxBurst/yield/interval and callback pause prevents continuation', async () => {
  const time = clock(), pages = []
  let calls = 0
  const poller = createTailPoller({ tail(cursor) {
    calls++
    const full = Array.from({ length: 300 }, (_, index) => record(cursor + index + 1))
    return page(full, cursor + full.length, 'epoch')
  } }, { ...time, maxBurst: 2, yieldMs: 3, intervalMs: 5,
    onPage(value) { pages.push(value); if (pages.length === 3) poller.setPaused(true) },
  })
  poller.setPaused(false)
  await flush()
  assert.equal(calls, 2)
  assert.equal(time.delay(), 3)
  await time.next()
  assert.equal(calls, 3)
  assert.equal(time.timers.size, 0)
  poller.dispose()
})

test('poller reports rejection, thrown Remote errors, error envelopes and malformed pages without overlap', async () => {
  const time = clock(), errors = [], calls = []
  const failures = [() => Promise.reject(new Error('rejected')), () => { throw new Error('thrown') }, () => ({ ok: false, error: { message: 'remote error' } }), () => null]
  const poller = createTailPoller({ tail(...args) { calls.push(args); return failures.shift()() } }, { ...time, intervalMs: 5, onError: error => { errors.push(error.message); if (errors.length === 2) throw new Error('callback failure') } })
  poller.setPaused(false)
  await flush()
  for (let count = 1; count < 4; count++) { assert.equal(time.delay(), 5); await time.next() }
  assert.deepEqual(errors, ['rejected', 'thrown', 'remote error', 'Invalid plugin logs page'])
  assert.ok(calls.every(args => JSON.stringify(args) === JSON.stringify([0, 300, ''])))
  poller.dispose()
})

test('pause/dispose clear timers, discard late successes/errors, and cannot restart disposed pollers', async () => {
  for (const reject of [false, true]) {
    const time = clock(), request = deferred(), pages = [], errors = []
    let calls = 0
    const poller = createTailPoller({ tail() { calls++; return request.promise } }, { ...time, onPage: value => pages.push(value), onError: error => errors.push(error) })
    poller.setPaused(false)
    poller.dispose(); poller.dispose(); poller.setPaused(false)
    if (reject) request.reject(new Error('late'))
    else request.resolve(page([{ sequence: 1 }], 1))
    await flush()
    assert.deepEqual(pages, []); assert.deepEqual(errors, [])
    assert.equal(calls, 1)
    assert.equal(time.timers.size, 0)
  }
  const time = clock()
  let calls = 0
  const poller = createTailPoller({ tail() { calls++; return page() } }, { ...time })
  poller.setPaused(false); await flush()
  assert.equal(time.timers.size, 1)
  poller.setPaused(true)
  assert.equal(time.timers.size, 0)
  poller.setPaused(false); await flush()
  assert.equal(calls, 2)
  poller.dispose()
  assert.equal(time.timers.size, 0)
})
