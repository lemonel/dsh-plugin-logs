# 插件日志（Plugin Logs）

在 DSH 右侧栏查看 Host 运行日志：按来源和级别筛选，用多个正则条件搜索，暂停、恢复或清空当前列表，也可以按需让当前 Agent 查询近期日志。日志只保存在 Host 内存中，不写入磁盘。

[English](./README.en.md)

## 适用场景

- 排查 DSH 插件、服务或工具在 Host 端输出的 Cordis `ctx.logger` 日志。
- 复现问题时查看最近的运行记录，或让当前 Agent 临时检索日志。
- 不采集浏览器 console、安装输出、自定义日志文件或历史会话，也不提供已安装插件清单。

## 安装

要求 DSH `0.2.0-rc.2` 或 `0.2.1-rc.1`；从源码构建还需要 Node.js 22。

本仓库暂未提供公开的预构建 tgz。先在插件目录构建：

```sh
cd /absolute/path/to/plugin-logs
npm ci --prefer-offline --no-audit --no-fund
npm run build
```

然后在 DSH 的 Plugins 页从本地路径安装，或执行：

```sh
dsh plugin --profile web add /absolute/path/to/plugin-logs
```

将 `web` 替换为实际 profile。确认 `@lemonel/dsh-plugin-logs` 已作为 bundle 启用（Loader 条目 ID 为 `lemonel-plugin-logs`），按 DSH 提示重载后端并刷新页面。构建或打包不会自动安装插件、重启 Host，也不会更新已经打开的页面。本地依赖链接应指向包根目录，而不是 `lib/`。

请通过 DSH 的管理流程安装和重载，不要手动修改运行中的 profile。

## 使用

1. 打开右侧栏，在引导页选择「插件日志」。
2. 「日志来源」列出当前列表中出现的 logger 名称（通常包含插件或服务名），按精确名称筛选；「全部来源」不筛选。已选来源离开当前窗口后仍会保留，并标注没有记录。
3. 「日志级别」与来源、搜索条件取交集。
4. 搜索可添加多个非空正则条件：满足任意一个即可（或），不区分大小写；最多 8 个，每个最多 200 字符。空条件不限制文字。
5. 「暂停」停止读取；「继续」从原游标补读，并显示已被 Host 缓冲覆盖的未读条数。「清屏」只清空当前浏览器的列表，不删除 Host 缓冲，也不会重新拉取旧记录。
6. 需要 Agent 查询日志时，使用面板中的 Tool 开关（见下一节）。

正则只在独立 Worker 中执行，500ms 超时会终止；没有 Worker 或 Blob Worker 被 CSP 阻止时，非空正则失败关闭，不会回退到主线程。超时后需要修改表达式再重试，相同条件不会随新日志自动重跑。

界面跟随 DSH 的中英文语言设置；DSH 未提供的语言按宿主语言回退处理。日志原文、logger 名称和级别标识不翻译。

## 当前 Agent 的 Tools

面板中的开关只对**当前顶层 Session Agent** 生效，默认关闭。打开后为该 Agent 注册两个 Tool：

- `plugin_logs_query`：按 `source`、`text`、`level`、`limit`（默认 20，最多 50）从新到旧查询。`source` 和 `text` 是不区分大小写的字面包含，用 `|` 分隔备选项，不是正则；每个过滤值最多 120 字符。
- `plugin_logs_sources`：返回当前缓冲区出现过的 logger 来源（最多 200 个），附保留条数、最近记录时间、总数和是否截断。

开关影响下一次模型请求；子代理不能启用，也不会继承该 Tool。Agent 销毁或插件卸载时会清理注册；同一页面、同一 Session 的多个面板每 2 秒及重新聚焦时同步状态。

`plugin_logs_sources` 不是已安装插件清单：静默或日志已被淘汰的来源不会出现。

## 数据与安全边界

- 日志仅保存在 Host 内存。Host 默认保留最近 2000 条（`capacity` 可设为 1–10000），浏览器保留最近 2000 条；不写磁盘，不回填插件启用前的记录，重载插件或重启 Host 会清空缓冲。
- 满页会立即追赶，连续 4 页后让出 16ms，追平后每 1200ms 轮询；不保证任意日志速率下无损。Remote 没有取消接口，暂停、卸载或重载后的迟到响应会被丢弃。
- 单条消息和来源分别最多 4096 / 160 个 UTF-16 单元。格式化最多读取 32 个参数、探测 64 个属性、递归 3 层、数组 20 项；不执行 getter、自定义 inspect/toJSON，也不枚举任意对象键。其他业务字段可能省略为 `…`，原生 Error 不求值惰性 stack。
- **日志不脱敏，可能包含凭据、路径、配置或提示词。** 仅供可信的 Web 用户使用。Agent scope 只控制 Tool 的可见性和执行对象，不是远端用户鉴权边界；读取 tail 会返回 Host 全局日志。

## 兼容性

| 项目 | 状态 |
| --- | --- |
| DSH `0.2.0-rc.2` | 通过；Linux x64、Node.js 22，隔离安装、完整构建与测试 |
| DSH `0.2.1-rc.1` | 通过；Linux x64、Node.js 22，隔离安装、完整构建与测试 |
| Linux x64 | 原生实测 |
| Linux arm64 / 其他架构 | 未实测 |
| Node.js 22 | 构建与测试使用 |
| 其他 Node.js 版本 | 未实测 |
| Windows / macOS 原生运行 | 未实测 |
| 真实浏览器交互 | 未验收；组件测试使用 jsdom 和真实 Worker 线程，不等于浏览器验收 |

宿主包以 `peerDependencies` 声明并限定上述两个 DSH 预发布范围；不匹配时 DSH 会禁用该插件。正则搜索还要求浏览器支持 Worker 和 Blob URL。

## 从旧包名升级

原先的 `@hsx/dsh-plugin-logs` 已改名为 `@lemonel/dsh-plugin-logs`，bundle 配置中的 Loader 条目 ID 改为 `lemonel-plugin-logs`。升级时先停用旧 bundle，再安装并启用新包，确认后移除旧依赖；不要同时启用两份。

此插件不持久化日志，没有需要迁移的日志或存储目录。`pluginLogs` Remote namespace、`plugin_logs_*` 工具名、`plugin-logs` 面板 kind 和语言 namespace 保持兼容；RPC 包标识与客户端注册 ID 随包名变化，Host 和浏览器必须加载同一版新产物。涉及 Host 模块或 Remote 标识的变更需要重载后端并刷新页面。

## 开发

源码采用 [MIT 许可证](./LICENSE)，作者为 lemonel。GitHub CI 对分支、PR 和手动运行验证两个 DSH 版本；`v*` 标签触发 Release，复用完整 CI，再打包、校验并上传 tgz 与 SHA-256 校验文件。只有发布任务有仓库写权限，使用 Actions 自带令牌，不需要个人 token 或 npm secret；不会发布到 npm（保留 `private: true` 防止误发布）。首次发布前的操作见[发布清单](./RELEASING.md)。工作流配置不代表云端验证或发布已经完成。

```sh
npm ci --prefer-offline --no-audit --no-fund
npm run typecheck
npm run build
npm test
npm run check:package
npm run check:clean
npm run check:compat
```

- 业务源码使用 strict TypeScript：入口为 `src/backend_index.ts` 和 `src/frontend_index.ts`，实现分别放在 `src/backend/` 与 `src/frontend/`，`src/shared/` 只放两端共用的协议、RPC 契约和边界校验。手写构建与测试脚本保留 JavaScript。
- `npm run build` 先类型检查，再清理并重建被忽略的 `lib/`；前端由 esbuild 按依赖图生成 ModuleLoader bundle，RPC 描述符引用实际产物。`lib/` 不提交、不手改；本地链接安装前先构建，包入口不需要 TS 加载器。
- 测试辅助脚本放在 `test/tools/`。`check:clean` 从独立源码副本执行锁文件安装、类型检查、完整构建、全部测试和实际 tgz 检查；`check:compat` 对两个受支持的 DSH 版本各执行一次，替代版本只在副本中生成锁文件后继续用 `npm ci`。检查依赖必须来自副本本地，缺失时失败，不回退全局安装；不使用 `--force` 或 `--legacy-peer-deps`。
- 发布包只含 `lib/`、`bundles/plugin-logs.patch.yml`、`icon.svg`、两份 README、发布清单、MIT `LICENSE` 和 `package.json`；`prepack` 会自动构建。Bundle 配置由 `dsh.bundle.patch` 显式引用。
- 槽位、Remote、Worker、定时器和事件监听都随插件或组件销毁清理；插件重载后 Host 缓冲清空，需要刷新页面重新建立 tail。涉及 Host 入口或 Remote 标识的更新通常要重载后端，不能只依赖 HMR。审查和测试覆盖了生命周期清理，但没有完成真实浏览器交互或跨平台验收。
