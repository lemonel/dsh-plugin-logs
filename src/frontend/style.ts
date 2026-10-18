// Match the MCP log dialog's layered surfaces, compact controls and timestamp/message columns.
export const css = `
.pl-root, .pl-root * { box-sizing:border-box; }
.pl-root { container-type:inline-size; height:100%; min-height:0; min-width:0; display:flex; flex-direction:column; padding:12px; gap:12px; color:var(--dsw-alias-label-primary,CanvasText); font:13px/1.6 ui-sans-serif,system-ui,sans-serif; }
.pl-head { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.pl-head strong { font-size:14px; }
.pl-actions { display:flex; flex-wrap:wrap; gap:8px; }
.pl-actions button { min-height:28px; padding:4px 9px; border:1px solid var(--dsw-alias-border-l4,#aaa5); border-radius:var(--dsw-radius-md,7px); background:transparent; color:inherit; font:inherit; font-size:11px; cursor:pointer; }
.pl-actions button:hover { background:var(--dsw-alias-interactive-bg-hover,#8882); }
.pl-filters { display:flex; flex-wrap:wrap; gap:8px; }
.pl-filters select, .pl-filters input { min-width:0; min-height:34px; border:1px solid var(--dsw-alias-border-l3,#aaa6); border-radius:9px; background:var(--dsw-alias-bg-layer-1,transparent); color:inherit; font:inherit; padding:6px 10px; }
.pl-filters select { flex:1 1 105px; }
.pl-search { display:flex; flex-wrap:wrap; align-items:center; gap:8px; min-width:0; width:100%; }
.pl-search-item { display:flex; flex:0 1 190px; align-items:center; min-width:0; max-width:100%; gap:4px; }
.pl-search-item input { flex:1 1 auto; width:100%; min-width:0; }
.pl-search button { flex:0 0 auto; min-height:34px; border:1px solid var(--dsw-alias-border-l3,#aaa6); border-radius:9px; background:var(--dsw-alias-bg-layer-1,transparent); color:inherit; padding:6px 10px; font:inherit; cursor:pointer; }
.pl-search button:hover { background:var(--dsw-alias-interactive-bg-hover,#8882); }
.pl-search-item button { padding-inline:7px; }
.pl-filter-help { margin:-5px 0 0; color:var(--dsw-alias-label-tertiary,#888); font-size:11px; }
.pl-hint { color:var(--dsw-alias-label-tertiary,#888); font-size:12px; }
.pl-hint summary { cursor:pointer; }
.pl-hint p { margin:8px 0 0; }
.pl-list { flex:1; min-height:100px; min-width:0; overflow:auto; overscroll-behavior:contain; scrollbar-gutter:stable; padding:10px 0; border:1px solid var(--dsw-alias-border-l4,#aaa5); border-radius:10px; background:var(--dsw-alias-bg-layer-2,transparent); }
.pl-line { display:grid; grid-template-columns:max-content minmax(0,1fr); align-items:baseline; gap:12px; padding:5px 12px; font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace; }
.pl-line:hover { background:var(--dsw-alias-bg-layer-1,#8882); }
.pl-time { color:var(--dsw-alias-label-tertiary,#888); font-variant-numeric:tabular-nums; white-space:nowrap; }
.pl-message { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; }
.pl-line[data-level="error"] .pl-message { color:var(--dsw-alias-label-error,#d14343); }
.pl-line[data-level="warn"] .pl-message { color:var(--dsw-alias-label-warning,#bd7c13); }
.pl-source { font-weight:600; }
.pl-empty { margin:16px; color:var(--dsw-alias-label-tertiary,#888); }
.pl-root :focus-visible { outline:2px solid var(--dsw-alias-label-secondary,currentColor); outline-offset:2px; }
@container (max-width:360px) { .pl-line { grid-template-columns:minmax(0,1fr); gap:0; } }
`
