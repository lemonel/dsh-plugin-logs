export const NS = 'pluginLogs'
export const zh: Record<string, string> = {
  title: '插件日志', pause: '暂停', resume: '继续', clear: '清屏', clearHint: '仅清空此浏览器当前列表',
  toolBusy: '切换中…', toolDisable: '关闭此 Agent 的日志查询与来源 Tool', toolEnable: '为此 Agent 启用日志查询与来源 Tool',
  subagentHint: '子代理不支持启用；不会继承主 Agent 的 Tool', toolHint: '仅当前 Session Agent 可见；查询 Host 全局近期日志。',
  toolStatusError: '无法读取工具状态', toolToggleError: '无法切换日志查询工具', remoteUnavailable: '插件日志 Remote 尚未就绪',
  source: '日志来源', allSources: '全部来源', level: '日志级别', allLevels: '全部级别',
  searchGroup: '日志正则搜索条件', searchLabel: '搜索日志正则 {n}', regexPlaceholder: '正则 {n}', removeRegex: '删除正则 {n}', or: '或',
  filterHelp: '来源下拉框展示当前已读取日志的来源；多个非空正则条件满足任意一个即可（或），不区分大小写；与来源、级别取交集。空正则不参与筛选。',
  regexTooLong: '搜索日志正则 {n}不能超过 200 个字符', regexInvalid: '搜索日志正则 {n}无效：{error}',
  regexTooMany: '最多添加 8 个正则条件', regexTimeout: '正则搜索超时，请简化表达式后重试', regexUnavailable: '无法启动隔离搜索，请检查浏览器 Worker 支持与安全策略',
  searching: '正在搜索…', expiredSource: '{source}（当前窗口无记录）',
  retention: '日志保留与隐私', retentionHint: '仅保留 Host 内存中最近的日志；刷新页面可重新读取，重载插件或重启进程会清空缓冲区。日志可能包含敏感信息。',
  dropped: '主机缓冲区已丢失 {n} 条未读取日志', readError: '无法读取插件日志', noMatches: '暂无匹配的日志', guideDescription: '按插件查看运行日志',
}
export const en: Record<string, string> = {
  title: 'Plugin logs', pause: 'Pause', resume: 'Resume', clear: 'Clear', clearHint: 'Clear only this browser’s current list',
  toolBusy: 'Switching…', toolDisable: 'Disable log query and source Tools for this Agent', toolEnable: 'Enable log query and source Tools for this Agent',
  subagentHint: 'Unavailable for subagents; they do not inherit the main Agent’s Tool', toolHint: 'Visible only to the current Session Agent; queries recent Host-wide logs.',
  toolStatusError: 'Could not read Tool status', toolToggleError: 'Could not switch the log query Tool', remoteUnavailable: 'Plugin logs Remote is not ready',
  source: 'Log source', allSources: 'All sources', level: 'Log level', allLevels: 'All levels',
  searchGroup: 'Log regex search conditions', searchLabel: 'Search log regex {n}', regexPlaceholder: 'Regex {n}', removeRegex: 'Remove regex {n}', or: 'or',
  filterHelp: 'Sources list names in the logs read so far. Any nonempty regex may match (OR), case-insensitively; source and level also apply. Empty regex fields do not filter.',
  regexTooLong: 'Search log regex {n} must be at most 200 characters', regexInvalid: 'Search log regex {n} is invalid: {error}',
  regexTooMany: 'At most 8 regex conditions are allowed', regexTimeout: 'Regex search timed out; simplify the expression and retry', regexUnavailable: 'Isolated search is unavailable; check browser Worker support and security policy',
  searching: 'Searching…', expiredSource: '{source} (no records in this window)',
  retention: 'Retention & privacy', retentionHint: 'Only recent logs are held in Host memory. Refresh to read them again; reloading the plugin or restarting the process clears the buffer. Logs may contain sensitive data.',
  dropped: '{n} unread logs were lost from the Host buffer', readError: 'Could not read plugin logs', noMatches: 'No matching logs', guideDescription: 'View runtime logs by plugin',
}
export function fallback(key: string, values: Record<string, unknown> = {}) { return (zh[key] || key).replace(/\{(\w+)\}/g, (_match: string, name: string) => String(values[name] ?? '')) }
