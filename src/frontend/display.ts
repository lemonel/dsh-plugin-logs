import { createElement as h } from 'react'

const ICON_URL = '__PLUGIN_LOGS_ICON_DATA_URL__'
export function PluginLogsIcon({ size = 26, className }: { size?: number; className?: string }) { return h('img', { src: ICON_URL, width: size, height: size, className, alt: '', 'aria-hidden': 'true' }) }

export function sourceOptions(rows: readonly { source: string }[], selected: string) {
  const available = new Set(rows.map(row => row.source))
  const values = new Set(available)
  if (selected) values.add(selected)
  return [...values].sort((a, b) => a.localeCompare(b)).map(value => ({ value, expired: !available.has(value) }))
}
