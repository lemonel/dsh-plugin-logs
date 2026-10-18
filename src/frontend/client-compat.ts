import { fallback } from './locale.js'
import type { ComponentType } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { remote } from '../shared/contract.js'
export type { Translate } from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap { pluginLogs: unknown }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { pluginLogs: string }
}

// Narrow structural views of the APIs used here. Cordis Context.get binds the
// third-party namespace to the scoped caller even without an inject declaration.
export type Dispose = () => void
export interface TailService { tail(cursor: number, limit: number, epoch: string): unknown | Promise<unknown> }
export interface ToolRemote {
  toolStatus(): unknown | Promise<unknown>
  setToolEnabled(enabled: boolean): unknown | Promise<unknown>
}
export interface ScopedBinding { ctx: { get(name: 'remote.pluginLogs'): unknown } }
export type Sessions = Pick<ISessions, 'using'>
export interface PanelProps {
  service: TailService
  sessions: Sessions
  sessionId?: SessionId
  useSession: <T>(selector: (snapshot: { subagent?: unknown }) => T) => T
  t: Translate
}
// The slots package exports the pure SlotCore, not the renderer's Cordis
// service (including slots.inject). Keep only that runtime face local. Remote
// pluginLogs is dynamically mounted and is absent from the SDK generated map.
// Host and client both augment Context.sessions; select the official client face
// explicitly so the Host SessionStore declaration cannot leak across this boundary.
export type ClientContext = Omit<Context, 'remote' | 'inject' | 'sessions'> & {
  sessions: Sessions
  remote: { pluginLogs: TailService; $mount(definition: typeof remote): Promise<Dispose> }
  inject(services: string[], callback: (child: ClientContext) => void): void
  slots: {
    inject(name: string, callback: () => Dispose): void
    register(definition: { name: string; key: string; locale: string; inject: () => { service: TailService; sessions: Sessions } }, component: ComponentType<PanelProps>): Dispose
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
export function errorMessage(value: unknown): string {
  return String(isRecord(value) && value.message ? value.message : value)
}
function isToolRemote(value: unknown): value is ToolRemote {
  return isRecord(value) && typeof value.toolStatus === 'function' && typeof value.setToolEnabled === 'function'
}
export function toolRemote(value: unknown): ToolRemote {
  if (!isToolRemote(value)) throw new Error('Plugin logs Remote is not ready')
  return value
}

// Cordis scoped bindings do not inject third-party Remote namespaces by default.
// Context.get reads the mounted service without an inject declaration and binds
// its traceable methods to this exact Agent-scoped caller context.
export function scopedRemote(binding: ScopedBinding, t: Translate = fallback) {
  const remote = binding.ctx.get('remote.pluginLogs')
  if (!remote) throw new Error(t('remoteUnavailable'))
  return remote
}
