# 发布清单 / Release checklist

## 首次接入 GitHub / First-time setup

- 目标仓库：`lemonel/dsh-plugin-logs`，本地实体保持在当前插件目录。先在 GitHub 创建空仓库，不自动生成 README、LICENSE 或 gitignore，避免首次推送产生不同历史。
- 作者：`lemonel <49467404+lemonel@users.noreply.github.com>`；使用 MIT 许可证。仅配置本仓库，不修改全局 Git 身份。
- 默认分支为 `main`。确认本机 SSH 公钥已添加到 GitHub，并能访问目标仓库，然后推送：

```sh
git remote -v
git push -u origin main
```

- 在 Settings → Actions 中允许 GitHub Actions 运行。发布使用内置 `GITHUB_TOKEN`；不需要添加 PAT 或 npm token。仓库/组织策略必须允许发布 job 请求 `contents: write`。
- 给 `main` 配置分支 ruleset，要求 PR 和实际出现的 CI 状态检查；为 `v*` 配置标签 ruleset，限制创建者并禁止更新、删除。注意规则不要阻止授权维护者创建首个标签。
- 推荐添加 GitHub topic `dsh-plugin`。公开前检查源码不含密钥或私人数据；当前没有真实浏览器验收截图，不能把组件测试当作 GUI 验收。

Create an empty `lemonel/dsh-plugin-logs` repository, authorize your SSH key, push `main`, enable Actions, and configure branch/tag rulesets. The release job uses the built-in token, not a PAT or npm token. Repository policy must allow its scoped write permission. GitHub repository creation and cloud CI must be verified separately from local setup.

## 每次发布 / Each release

1. 完成真实 DSH 界面的主要操作验收，包括中英文、筛选、暂停/继续、Tools 作用域及重载；未覆盖的平台保持标注“未实测”。
2. 确认发布渠道为 **GitHub Release**。npm 发布尚未授权，保留 `private: true`；不要使用 `npm publish`。
3. 检查版本及锁文件。首版当前为 `0.1.0`；若调整版本，用 `npm version <version> --no-git-tag-version` 同步两者，再提交。不要移动已发布标签。
4. 运行以下命令并提交预期变更，推送 `main`，等待 GitHub 两个 DSH 版本的 CI 均通过：

```sh
npm ci --prefer-offline --no-audit --no-fund
npm test
npm run check:compat
npm run check:package
git status --short
git diff --check
```

5. **明确确认发版后**，给已验证提交创建新标签。首次发布示例（仅供手动执行）：

```sh
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

6. Actions 的 Release 流程会检查标签、包版本及锁文件根版本一致，复用完整 CI，锁文件安装后通过 `prepack` 构建，再检查真实 tgz 的内容、入口及运行加载。独立只读打包任务上传已验证 tgz 与校验文件；写权限任务不安装依赖、不构建，只校验附件、远端标签仍指向已测提交，再创建 Release。预发布版本标记为 Pre-release；已存在 Release 时拒绝覆盖，失败需人工检查，禁止移动标签或静默替换附件。
7. 分别确认标签已推送、云端测试通过、Release 已创建、tgz 与校验文件可公开下载。首版附件名为 `lemonel-dsh-plugin-logs-0.1.0.tgz`，使用固定标签下载地址；不承诺 `latest/download/` 的版本化文件名长期可用。
8. 只有附件真实可下载并完成安装验证后，才把两份 README 的源码安装入口改为预构建包优先（单独 `docs:` 提交，不移动已发布标签）。

After explicit approval, tag the tested commit with a version matching both manifests and push that tag. Release reuses full CI and publishes only the checked tgz plus checksum. Prereleases are marked accordingly; existing releases are never overwritten. Verify cloud tests, release creation, downloads, and installation separately, then update both READMEs to prefer the actual release asset. npm publication is not enabled.

## 安装发布附件 / Install the release asset

以下地址只有首版 Release 成功且可公开下载后才有效；目前不是已发布声明：

```sh
dsh plugin --profile web add https://github.com/lemonel/dsh-plugin-logs/releases/download/v0.1.0/lemonel-dsh-plugin-logs-0.1.0.tgz
```

将 `web` 替换为实际 profile；确认 bundle 已启用，并按 DSH 提示重载后端、刷新页面。不要直接安装未构建的 GitHub 源码归档。The URL becomes valid only after publication; replace the profile, enable the bundle, reload the backend, and refresh the page.
