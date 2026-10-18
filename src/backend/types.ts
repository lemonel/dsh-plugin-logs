import type { LogEntry, LogLevel } from '../shared/types.js'

export interface PluginLogsConfig { capacity?: number }
export interface LogQueryArgs {
  source?: string
  text?: string
  level?: LogLevel
  limit?: number
}
export interface LogQueryResult { entries: LogEntry[]; newestSequence: number }
export type LogSource = { source: string; count: number; latestSequence: number; latestTime: number | null }
export interface LogSourcesResult { sources: LogSource[]; totalSources: number; truncated: boolean; newestSequence: number }
