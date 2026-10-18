import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogPage, parseToolStatus } from '../lib/shared/contract.js'
import { createTailPoller } from '../lib/frontend/client-runtime.js'
import { observeTools } from '../lib/frontend/tool-state.js'
import { LogBuffer } from '../lib/backend/core.js'

const row = { sequence: 1, time: 123, source: 'old-source', text: 'old text', level: 'info' }
const page = { entries: [row], cursor: 1, dropped: 0, epoch: 'legacy-epoch', reset: false }
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

test('existing RPC pages and status retain identity and original values', () => {
  const original = JSON.stringify(page)
  Object.freeze(row); Object.freeze(page.entries); Object.freeze(page)
  assert.equal(parseLogPage(page), page)
  assert.equal(JSON.stringify(page), original)
  const status = Object.freeze({ enabled: true, extra: 'preserved' })
  assert.equal(parseToolStatus(status), status)
})

test('missing required fields and malformed nested entries remain rejected', () => {
  for (const key of Object.keys(page)) {
    const value = { ...page }; delete value[key]
    assert.throws(() => parseLogPage(value))
  }
  for (const key of Object.keys(row)) {
    const value = { ...row }; delete value[key]
    assert.throws(() => parseLogPage({ ...page, entries: [value] }))
  }
  for (const value of [null, {}, { enabled: 'true' }, { enabled: 0 }]) assert.throws(() => parseToolStatus(value))
})

test('page relationships reject duplicate, reversed, skipped and mismatched records', () => {
  for (const invalid of [
    { ...page, entries: [row, row] },
    { ...page, entries: [{ ...row, sequence: 2 }, row] },
    { ...page, entries: [row, { ...row, sequence: 3 }], cursor: 3 },
    { ...page, cursor: 0 },
    { ...page, cursor: 900 },
    { ...page, epoch: '' },
    { ...page, epoch: 'x'.repeat(101) },
    { ...page, reset: true, dropped: 1 },
    { ...page, entries: [], dropped: 1 },
    { ...page, entries: [], reset: true },
  ]) assert.throws(() => parseLogPage(invalid), /Invalid log page/)
  const entries = Object.freeze([Object.freeze({ ...row, sequence: 2 }), Object.freeze({ ...row, sequence: 3 })])
  const valid = Object.freeze({ ...page, entries, cursor: 3, dropped: 1, epoch: 'x'.repeat(100) })
  assert.equal(parseLogPage(valid), valid)
  assert.equal(valid.entries, entries)
})

test('invalid initial pages cannot advance cursor or epoch', async () => {
  for (const invalid of [
    { ...page, cursor: 900, epoch: 'bad', entries: [{}] },
    { ...page, cursor: 900, epoch: 'bad' },
    { ...page, entries: [row, row] },
    { ...page, epoch: 'x'.repeat(101) },
    { ...page, reset: true },
  ]) {
    const calls = [], errors = [], pages = []
    let next
    const poller = createTailPoller({ tail(...args) { calls.push(args); return calls.length === 1 ? invalid : page } }, {
      setTimeout(callback) { next = callback; return 1 }, clearTimeout() {},
      onError(error) { errors.push(error.message) }, onPage(value) { pages.push(value) },
    })
    try {
      poller.setPaused(false); await flush()
      assert.deepEqual(errors, ['Invalid plugin logs page'])
      next(); await flush()
      assert.deepEqual(calls, [[0, 300, ''], [0, 300, '']])
      assert.equal(pages[0], page)
    } finally { poller.dispose() }
  }
})

test('replayed pages, false gaps and inconsistent resets leave the accepted cursor unchanged', async () => {
  const nextRow = { ...row, sequence: 2 }
  const recovery = { ...page, entries: [nextRow], cursor: 2 }
  for (const invalid of [
    page,
    { ...page, entries: [], cursor: 0 },
    { ...page, entries: [], cursor: 2 },
    { ...page, entries: [{ ...row, sequence: 3 }], cursor: 3 },
    { ...recovery, dropped: 1 },
    { ...recovery, epoch: 'unannounced-epoch' },
    { ...recovery, reset: true },
  ]) {
    const calls = [], errors = [], pages = []
    const responses = [page, invalid, recovery]
    let next
    const poller = createTailPoller({ tail(...args) { calls.push(args); return responses.shift() } }, {
      setTimeout(callback) { next = callback; return 1 }, clearTimeout() {},
      onError(error) { errors.push(error.message) }, onPage(value) { pages.push(value) },
    })
    try {
      poller.setPaused(false); await flush()
      next(); await flush()
      assert.deepEqual(errors, ['Invalid plugin logs page'])
      assert.equal(pages.length, 1)
      next(); await flush()
      assert.deepEqual(calls, [[0, 300, ''], [1, 300, page.epoch], [1, 300, page.epoch]])
      assert.equal(pages[0], page)
      assert.equal(pages[1], recovery)
    } finally { poller.dispose() }
  }
})

test('real buffer overwrite, idle pages and generation resets retain the original RPC objects', async () => {
  let buffer = new LogBuffer(3)
  const append = count => { for (let i = 0; i < count; i++) buffer.push({ time: 123, source: 'test', level: 'info', text: 'ok' }) }
  const pages = [], responses = [], errors = []
  let next
  const poller = createTailPoller({ tail(...args) { const response = buffer.tail(...args); responses.push(response); return response } }, {
    setTimeout(callback) { next = callback; return 1 }, clearTimeout() {},
    onError(error) { errors.push(error.message) }, onPage(value) { pages.push(value) },
  })
  try {
    append(5)
    poller.setPaused(false); await flush()
    assert.deepEqual(pages[0].entries.map(row => row.sequence), [3, 4, 5])
    assert.equal(pages[0].dropped, 2)
    append(5)
    next(); await flush()
    assert.deepEqual(pages[1].entries.map(row => row.sequence), [8, 9, 10])
    assert.equal(pages[1].dropped, 2)
    next(); await flush()
    assert.deepEqual(pages[2].entries, [])
    assert.equal(pages[2].cursor, 10)
    buffer = new LogBuffer(3); append(12)
    next(); await flush()
    assert.equal(pages[3].reset, true)
    assert.equal(pages[3].dropped, 0)
    assert.equal(pages[3].cursor, 12)
    buffer = new LogBuffer(3)
    next(); await flush()
    assert.equal(pages[4].reset, true)
    assert.equal(pages[4].cursor, 0)
    assert.deepEqual(errors, [])
    for (let i = 0; i < responses.length; i++) assert.equal(pages[i], responses[i])
  } finally { poller.dispose() }
})

test('malformed Tool status fails closed and prevents mutation', async () => {
  let writes = 0, state
  const remote = { toolStatus: () => ({ ok: true, value: { enabled: 'yes' } }), setToolEnabled() { writes++ } }
  const sessions = { using(_id, _meta, callback) { return callback({ binding: { ctx: { get: () => remote } } }) } }
  const controller = observeTools(sessions, 'main', value => { state = value }, {})
  try {
    await flush()
    assert.equal(state.ready, false)
    assert.match(state.error, /Invalid tool status/)
    await controller.toggle()
    assert.equal(writes, 0)
    assert.equal(state.enabled, false)
  } finally { controller.dispose() }
})
