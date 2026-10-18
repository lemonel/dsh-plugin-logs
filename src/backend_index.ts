import type { Context } from '@deepseek-ai/cordis'
import type { PluginLogsConfig } from './backend/types.js'
import z from '@deepseek-ai/schemastery'
import { PluginLogs } from './backend/host.js'
export const name = 'plugin-logs'
export const Config = z.object({ capacity: z.number().min(1).max(10000).step(1).default(2000) })
export function apply(ctx: Context, config: PluginLogsConfig) { return ctx.plugin(PluginLogs, config) }
