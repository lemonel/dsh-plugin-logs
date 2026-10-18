import { remote as REMOTE } from './shared/contract.js'
import type { ClientContext } from './frontend/client-compat.js'
import { NS, zh, en } from './frontend/locale.js'
import { PluginLogsIcon } from './frontend/display.js'
import { Panel } from './frontend/panel.js'

// Preserve the public runtime/test exports through actual module exports.
export { workerMain, createRegexRunner, createTailPoller } from './frontend/client-runtime.js'
export { observeTools } from './frontend/tool-state.js'
export { sourceOptions } from './frontend/display.js'
export { scopedRemote } from './frontend/client-compat.js'
export { Panel } from './frontend/panel.js'

const ID = '@lemonel/dsh-plugin-logs'
export const name = 'plugin-logs/client'
export const inject = ['slots', 'remote', 'sessions', 'locale']
export async function apply(ctx: ClientContext) {
  const unmount = await ctx.remote.$mount(REMOTE)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-logs: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.inject(['remote', 'remote.pluginLogs', 'sidebarRightTabs', 'sessions'], child => {
    child.effect(() => child.sidebarRightTabs.register({ id: ID, kind: 'plugin-logs', title: () => t('title'), guide: [{ id: 'plugin-logs', order: 45, title: () => t('title'), description: () => t('guideDescription'), icon: PluginLogsIcon }] }), 'plugin-logs: tab')
    child.slots.inject('sidebar.right.pane.tab', () => child.slots.register({ name: 'sidebar.right.pane.tab', key: ID, locale: NS, inject: () => ({ service: child.remote.pluginLogs, sessions: child.sessions }) }, Panel))
  })
  return unmount
}
