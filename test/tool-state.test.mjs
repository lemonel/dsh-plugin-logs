import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeTools } from '../lib/frontend/tool-state.js'
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
function fixture() {
  let enabled = false, reads = 0
  const writes = [], events = new Map(), documentEvents = new Map()
  const remote = {
    async toolStatus() { reads++; return { ok: true, value: { enabled } } },
    async setToolEnabled(value) { writes.push(value); enabled = value; return { ok: true, value: { enabled } } },
  }
  const sessions = { using(_id, _meta, callback) { return callback({ binding: { ctx: { get: () => remote } } }) } }
  const environment = {
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: key => events.delete(key),
    document: { visibilityState: 'visible', addEventListener: (key, fn) => documentEvents.set(key, fn), removeEventListener: key => documentEvents.delete(key) },
  }
  return { sessions, remote, writes, events, documentEvents, environment, get reads() { return reads }, setEnabled(value) { enabled = value } }
}
test('two panels share Tool state, serialize toggles, and release observers on last unmount', async () => {
  const f = fixture()
  let a, b
  const first = observeTools(f.sessions, 'main', state => { a = state }, f.environment)
  const second = observeTools(f.sessions, 'main', state => { b = state }, f.environment)
  await flush()
  assert.equal(f.reads, 1)
  await first.toggle()
  assert.equal(a.enabled, true)
  assert.equal(b.enabled, true)
  await second.toggle()
  assert.deepEqual(f.writes, [true, false])
  first.dispose()
  assert.equal(f.events.size, 1)
  second.dispose()
  assert.equal(f.events.size, 0)
  assert.equal(f.documentEvents.size, 0)
})
test('stale external state is re-read on click and focus; errors can recover', async () => {
  const f = fixture()
  let latest
  const controller = observeTools(f.sessions, 'main', value => { latest = value }, f.environment)
  await flush()
  f.setEnabled(true)
  await controller.toggle()
  assert.deepEqual(f.writes, [false])
  f.setEnabled(true)
  f.events.get('focus')()
  await flush()
  assert.equal(latest.enabled, true)
  const original = f.remote.toolStatus
  f.remote.toolStatus = async () => { throw Error('offline') }
  f.events.get('focus')(); await flush()
  assert.equal(latest.ready, false)
  assert.match(latest.error, /offline/)
  f.remote.toolStatus = original
  f.events.get('focus')(); await flush()
  assert.equal(latest.ready, true)
  controller.dispose()
})
test('late status responses after unmount cannot notify or retain event listeners', async () => {
  const f = fixture()
  let resolve, notifications = 0
  f.remote.toolStatus = () => new Promise(yes => { resolve = yes })
  const controller = observeTools(f.sessions, 'main', () => { notifications++ }, f.environment)
  assert.equal(notifications, 1)
  await flush()
  controller.dispose()
  resolve({ ok: true, value: { enabled: true } })
  await flush()
  assert.equal(notifications, 1)
  assert.equal(f.events.size, 0)
})

test('unmount during toggle status cannot start a mutation afterwards', async () => {
  const f = fixture()
  const controller = observeTools(f.sessions, 'main', () => {}, f.environment)
  await flush()
  let resolve
  f.remote.toolStatus = () => new Promise(yes => { resolve = yes })
  const pending = controller.toggle()
  await flush()
  controller.dispose()
  resolve({ ok: true, value: { enabled: false } })
  await pending
  assert.deepEqual(f.writes, [])
})

test('synchronous Session acquisition errors are reported without throwing from subscription', async () => {
  const f = fixture()
  f.sessions.using = () => { throw Error('Session unavailable') }
  let latest
  const controller = observeTools(f.sessions, 'main', value => { latest = value }, f.environment)
  await flush()
  assert.equal(latest.ready, false)
  assert.match(latest.error, /Session unavailable/)
  controller.dispose()
})
