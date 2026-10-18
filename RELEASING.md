# 发布清单 / Release checklist

## 仓库设置 / Repository setup

- 仓库 `lemonel/dsh-plugin-logs`，默认分支 `main`，源码采用 MIT 许可证，作者 `lemonel <49467404+lemonel@users.noreply.github.com>`。
- 在 Settings → Actions 中允许 GitHub Actions 运行。发布只用内置 `GITHUB_TOKEN`，不需要 PAT 或 npm token；仓库/组织策略必须允许发布 job 请求 `contents: write`。
- 给 `main` 配置分支 ruleset，要求 PR 和实际出现的 CI 状态检查；为 `v*` 配置标签 ruleset，限制创建者并禁止更新、删除。
- 推荐添加 GitHub topic `dsh-plugin`。发布前检查源码和 `docs/` 截图不含密钥、个人路径或其他敏感数据。

Repository `lemonel/dsh-plugin-logs`, default branch `main`, MIT license. Enable Actions and allow the release job its scoped `contents: write` permission. The release uses the built-in token, not a PAT or npm token. Protect `main` with PR/CI rules and protect `v*` tags against updates and deletion. Add the `dsh-plugin` topic and check source and screenshots for secrets or personal paths.

## 每次发布 / Each release

1. 完成真实 DSH 界面的主要操作验收，包括中英文、筛选、暂停/继续、Tools 作用域及重载；未覆盖的平台保持标注“未实测”。界面或文案变化后更新 `docs/panel-zh.png`、`docs/panel-en.png` 和 `screenshots.json`。
2. 确认发布渠道为 **GitHub Release**。npm 发布尚未授权，保留 `private: true`；不要使用 `npm publish`。
3. 用 `npm version <version> --no-git-tag-version` 同步 `package.json` 与锁文件版本，提交变更。已发布版本不移动标签。
4. 运行以下命令，推送 `main`，等待 GitHub 两个 DSH 版本的 CI 均通过：

```sh
npm ci --prefer-offline --no-audit --no-fund
npm test
npm run check:compat
npm run check:package
git status --short
git diff --check
```

5. **明确确认发版后**，给已验证提交创建新标签并推送（示例中的版本必须与包和锁文件一致）：

```sh
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

6. Actions 的 Release 流程会检查标签、包版本及锁文件根版本一致，复用完整 CI，锁文件安装后通过 `prepack` 构建，再检查真实 tgz 的内容、入口及运行加载。独立只读打包任务上传已验证 tgz 与校验文件；写权限任务不安装依赖、不构建，只校验附件、远端标签仍指向已测提交，再创建 Release。预发布版本标记为 Pre-release；已存在 Release 时拒绝覆盖，失败需人工检查，禁止移动标签或静默替换附件。
7. 分别确认标签已推送、云端测试通过、Release 已创建、tgz 与校验文件可公开下载。附件使用固定标签下载地址，不承诺 `latest/download/` 的版本化文件名长期可用。
8. 下载附件完成一次实际安装验证后，再确认两份 README 的安装地址与当前版本一致；只更新文档时使用独立的 `docs:` 提交，不移动已发布标签。

After explicit approval, tag the tested commit with a version matching both manifests and push that tag. Release reuses full CI and publishes only the checked tgz plus checksum. Prereleases are marked accordingly; existing releases are never overwritten. Verify tag push, cloud tests, release creation, downloads, and installation separately. Update docs in a separate `docs:` commit without moving a published tag.

## 安装发布附件 / Install the release asset

v1.0.0 附件已发布，可直接安装；新版本替换地址中的标签和文件名：

```sh
dsh plugin --profile web add https://github.com/lemonel/dsh-plugin-logs/releases/download/v1.0.0/lemonel-dsh-plugin-logs-1.0.0.tgz
```

将 `web` 替换为实际 profile；确认 `@lemonel/dsh-plugin-logs` 已作为 bundle 启用，并按 DSH 提示重载后端、刷新页面。不要直接安装未构建的 GitHub 源码归档。Replace the profile; confirm the bundle is enabled, reload the backend, and refresh the page. Do not install an unbuilt GitHub source archive.
