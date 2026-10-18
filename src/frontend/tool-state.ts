import { parseToolStatus } from '../shared/contract.js'
import { errorMessage, isRecord, toolRemote } from './client-compat.js'
import type { Sessions, ToolRemote } from './client-compat.js'
import type { ToolStatus } from '../shared/types.js'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export interface ToolState { enabled: boolean; ready: boolean; busy: boolean; error: string | null }
export interface ToolController { toggle(): Promise<void>; dispose(): void }
interface Environment {
  addEventListener?(event: string, listener: () => void): void
  removeEventListener?(event: string, listener: () => void): void
  document?: { visibilityState?: string; addEventListener?(event: string, listener: () => void): void; removeEventListener?(event: string, listener: () => void): void }
}
interface Store { listeners: Set<(state: ToolState) => void>; toggle(): Promise<void>; refresh(): void; readonly state: ToolState; close(): void }
// One ref-counted controller per Session and sessions service. Polling also sees
// changes from other browsers; toggles always re-read Host state before changing it.
const toolStores = new WeakMap<Sessions, Map<string, Store>>()
export function observeTools(sessions: Sessions, sessionId: SessionId, listener: (state: ToolState) => void, environment: Environment = globalThis): ToolController {
  let stores = toolStores.get(sessions)
  if (!stores) { stores = new Map(); toolStores.set(sessions, stores) }
  let entry = stores.get(sessionId)
  if (!entry) {
    const listeners = new Set<(state: ToolState) => void>()
    let closed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: Promise<void> | null = null
    let state: ToolState = { enabled: false, ready: false, busy: false, error: null }
    const emit = (patch: Partial<ToolState>) => {
      if (closed) return
      state = { ...state, ...patch }
      for (const callback of listeners) callback(state)
    }
    const remoteCall = (callback: (remote: ToolRemote) => Promise<ToolStatus>) => Promise.resolve().then(() => sessions.using(sessionId, { source: 'pluginLogs' }, async ({ binding }) => {
      const remote = binding.ctx.get('remote.pluginLogs')
      if (!remote) throw new Error('Plugin logs Remote is not ready')
      return callback(toolRemote(remote))
    }))
    const unwrap = (result: unknown): ToolStatus => {
      if (!isRecord(result) || result.ok !== true) {
        const message = isRecord(result) && isRecord(result.error) && typeof result.error.message === 'string' ? result.error.message : 'Plugin logs Remote request failed'
        throw new Error(message)
      }
      return parseToolStatus(result.value)
    }
    const schedule = () => {
      clearTimeout(timer)
      if (!closed) timer = setTimeout(refresh, 2000)
    }
    const refresh = () => {
      if (closed || state.busy || request) return
      request = remoteCall(async remote => unwrap(await remote.toolStatus()))
        .then(value => emit({ enabled: value.enabled, ready: true, error: null }))
        .catch((error: unknown) => emit({ ready: false, error: errorMessage(error) }))
        .finally(() => { request = null; schedule() })
    }
    const toggle = async () => {
      if (closed || state.busy) return
      emit({ busy: true, error: null })
      clearTimeout(timer)
      try {
        // A status request from before this click must settle before mutation.
        if (request) await request
        if (closed) return
        const value = await remoteCall(async remote => {
          const current = unwrap(await remote.toolStatus())
          if (closed) return current
          return unwrap(await remote.setToolEnabled(!current.enabled))
        })
        emit({ enabled: value.enabled, ready: true, error: null })
      } catch (error) { emit({ ready: false, error: errorMessage(error) }) }
      finally { emit({ busy: false }); schedule() }
    }
    const onFocus = () => { if (!environment.document || environment.document.visibilityState !== 'hidden') refresh() }
    environment.addEventListener?.('focus', onFocus)
    environment.document?.addEventListener?.('visibilitychange', onFocus)
    entry = {
      listeners, toggle, refresh,
      get state() { return state },
      close() {
        closed = true; clearTimeout(timer)
        environment.removeEventListener?.('focus', onFocus)
        environment.document?.removeEventListener?.('visibilitychange', onFocus)
      },
    }
    stores.set(sessionId, entry)
  }
  entry.listeners.add(listener)
  listener(entry.state)
  entry.refresh()
  let disposed = false
  return {
    toggle: () => disposed ? Promise.resolve() : entry.toggle(),
    dispose() {
      if (disposed) return
      disposed = true; entry.listeners.delete(listener)
      if (!entry.listeners.size) { entry.close(); stores.delete(sessionId) }
    },
  }
}
