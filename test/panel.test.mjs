import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React from 'react'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { render, fireEvent, act, cleanup } = await import('@testing-library/react')
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
const record = (sequence, source) => ({ sequence, source, level: 'info', time: 123, text: `record ${sequence}` })

test('real React Panel integrates polling, source expiry, epoch reset, shared Tools, and unmount cleanup', async t => {
  let plugin
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    setTimeout, clearTimeout,
    window: { __ModuleLoader__: { load(value) { plugin = value.factory(name => { assert.equal(name, 'react'); return React }) } } },
  })
  let resolveTail, tailCalls = 0, enabled = false
  const writes = []
  const service = { tail() { tailCalls++; return new Promise(resolve => { resolveTail = resolve }) } }
  const remote = {
    async toolStatus() { return { ok: true, value: { enabled } } },
    async setToolEnabled(value) { enabled = value; writes.push(value); return { ok: true, value: { enabled } } },
  }
  const sessions = { using(_id, _meta, callback) { return callback({ binding: { ctx: { get: () => remote } } }) } }
  const props = { service, sessions, sessionId: 'main', useSession: selector => selector({ subagent: false }), t: (key, values = {}) => key === 'expiredSource' ? `${values.source} (expired)` : key }
  const view = render(React.createElement(plugin.Panel, props))
  t.after(() => { cleanup(); dom.window.close() })
  await tick()
  assert.equal(tailCalls, 1)
  await act(async () => resolveTail({ ok: true, value: { entries: [record(1, 'alpha')], cursor: 1, epoch: 'one', reset: false, dropped: 0 } }))
  await tick(); await tick()
  fireEvent.change(view.getByLabelText('source'), { target: { value: 'alpha' } })
  await tick()
  const pause = () => fireEvent.click(view.getByText('pause'))
  const resume = () => fireEvent.click(view.getByText('resume'))
  pause(); resume()
  assert.equal(tailCalls, 2)
  // Repeated pause/resume while RPC is pending stays single-flight.
  for (let i = 0; i < 5; i++) { pause(); resume() }
  assert.equal(tailCalls, 2)
  // Drain four real-sized RPC pages to expire alpha from the browser window.
  for (let batch = 0; batch < 4; batch++) {
    await act(async () => resolveTail({ ok: true, value: { entries: Array.from({ length: 500 }, (_, i) => record(batch * 500 + i + 2, 'beta')), cursor: (batch + 1) * 500 + 1, epoch: 'one', reset: false, dropped: 0 } }))
  }
  await tick()
  assert.equal(view.getByLabelText('source').value, 'alpha')
  assert.ok([...view.getByLabelText('source').options].some(option => option.value === 'alpha' && /expired/.test(option.text)))
  // A second instance sees the same shared state, without stale toggles.
  const second = render(React.createElement(plugin.Panel, { ...props, service: { tail: () => new Promise(() => {}) } }))
  await tick()
  const buttons = () => [...document.querySelectorAll('button')].filter(button => /toolEnable|toolDisable/.test(button.textContent))
  await act(async () => { fireEvent.click(buttons()[0]) })
  assert.equal(buttons()[1].textContent, 'toolDisable')
  await act(async () => { fireEvent.click(buttons()[1]) })
  assert.deepEqual(writes, [true, false])
  second.unmount()
  // The first poller's pending call returns a new Host generation.
  await act(async () => resolveTail({ ok: true, value: { entries: [record(1, 'gamma')], cursor: 1, epoch: 'two', reset: true, dropped: 0 } }))
  fireEvent.change(view.getByLabelText('source'), { target: { value: '' } })
  await tick(); await tick()
  assert.equal(view.container.querySelectorAll('.pl-line').length, 1)
  assert.match(view.container.textContent, /gamma/)
  assert.doesNotMatch(view.container.querySelector('.pl-list').textContent, /beta/)
  view.unmount()
  const before = tailCalls
  await tick()
  assert.equal(tailCalls, before)
  const failing = render(React.createElement(plugin.Panel, { ...props, service: { tail: () => Promise.reject(new Error('remote down')) } }))
  await tick()
  assert.match(failing.container.textContent, /readError: remote down/)
  failing.unmount()
})
