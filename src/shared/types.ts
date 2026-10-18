export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A detached, bounded logger message before insertion into the ring. */
export type LogRecord = {
  time: number
  source: string
  level: LogLevel
  text: string
}
export type LogEntry = LogRecord & { sequence: number }
export interface LogPage {
  entries: LogEntry[]
  cursor: number
  dropped: number
  epoch: string
  reset: boolean
}
export interface ToolStatus { enabled: boolean }

export function isLogLevel(value: unknown): value is LogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error'
}
