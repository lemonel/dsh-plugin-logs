import { createElement as h, useId } from 'react'
import type { ChangeEvent } from 'react'
import type { PanelProps } from './client-compat.js'
import { css } from './style.js'
import { usePanelState } from './use-panel-state.js'

export function Panel(props: PanelProps) {
  const { sessionId, t } = props
  const {
    subagent, tool, toggleTool, source, setSource, level, setLevel, queries,
    paused, togglePaused, clearRows, updateQuery, removeQuery, addQuery,
    error, dropped, sources, filtered, filterError, currentMatches,
  } = usePanelState(props)
  const helpId = useId()
  return h('section', { className: 'pl-root', 'aria-label': t('title') }, h('style', null, css),
    h('div', { className: 'pl-head' }, h('strong', null, t('title')), h('div', { className: 'pl-actions' },
      h('button', { type: 'button', onClick: togglePaused }, t(paused ? 'resume' : 'pause')), ' ',
      h('button', { type: 'button', onClick: clearRows, title: t('clearHint') }, t('clear')))),
    h('div', { className: 'pl-actions' },
      h('button', { type: 'button', disabled: tool.busy || !tool.ready || !!subagent || !sessionId, onClick: toggleTool, 'aria-pressed': tool.enabled }, t(tool.busy ? 'toolBusy' : tool.enabled ? 'toolDisable' : 'toolEnable')),
      h('span', { className: 'pl-hint' }, t(subagent ? 'subagentHint' : 'toolHint'))),
    tool.error && h('div', { role: 'alert' }, `${t('toolStatusError')}: ${tool.error}`),
    h('div', { className: 'pl-filters' },
      h('select', { 'aria-label': t('source'), value: source, onChange: (event: ChangeEvent<HTMLSelectElement>) => setSource(event.target.value) }, h('option', { value: '' }, t('allSources')), ...sources.map(({ value, expired }) => h('option', { key: value, value }, expired ? t('expiredSource', { source: value }) : value))),
      h('select', { 'aria-label': t('level'), value: level, onChange: (event: ChangeEvent<HTMLSelectElement>) => setLevel(event.target.value) }, h('option', { value: '' }, t('allLevels')), ...['debug', 'info', 'warn', 'error'].map(value => h('option', { key: value }, value))),
      h('div', { className: 'pl-search', role: 'group', 'aria-label': t('searchGroup') },
        ...queries.map((query, index) => h('div', { className: 'pl-search-item', key: index },
          h('input', { 'aria-label': t('searchLabel', { n: index + 1 }), 'aria-invalid': !!filterError, 'aria-describedby': helpId, placeholder: t('regexPlaceholder', { n: index + 1 }), maxLength: 200, value: query, onChange: (event: ChangeEvent<HTMLInputElement>) => updateQuery(index, event.target.value) }),
          index > 0 && h('button', { type: 'button', 'aria-label': t('removeRegex', { n: index + 1 }), onClick: () => removeQuery(index) }, '×'))),
        h('button', { type: 'button', disabled: queries.length >= 8, title: queries.length >= 8 ? t('regexTooMany') : undefined, onClick: addQuery }, t('or')))),
    h('p', { className: 'pl-filter-help', id: helpId }, t('filterHelp')),
    filterError && h('div', { role: 'alert' }, filterError),
    h('details', { className: 'pl-hint' }, h('summary', null, t('retention')), h('p', null, t('retentionHint'))),
    dropped > 0 && h('div', { role: 'status' }, t('dropped', { n: dropped })),
    error && h('div', { role: 'alert' }, `${t('readError')}: ${error}`),
    h('div', { className: 'pl-list', role: 'log', 'aria-live': 'off', tabIndex: 0 }, filterError ? null : filtered.length ? filtered.map(row => h('div', { className: 'pl-line', 'data-level': row.level, key: row.sequence },
      h('time', { className: 'pl-time', dateTime: new Date(row.time).toISOString() }, new Date(row.time).toLocaleTimeString()), h('pre', { className: 'pl-message' }, h('span', { className: 'pl-source' }, row.source), ' · ', row.level.toUpperCase(), ' · ', row.text))) : h('p', { className: 'pl-empty' }, t(currentMatches ? 'noMatches' : 'searching'))))
}
