# archive/sandbox — 已归档的沙箱实现（2026-09-05）

## 归档决定

Agent Extensions 的增强插件①「SandBox」（Windows AppContainer 沙箱执行，`platform-exec` 工具）
自 **2026-09-05** 起暂停开发，实现整体移出运行时，归档于本目录。

- **原因**：沙箱/OS 级隔离属于宿主管理层的职责，未来由 OpenChamber 逐步提供类似
  sandbox 的能力；本项目重心转向插件框架本身的模块化与后续增强插件。
- **性质**：归档而非删除。代码完整保留、可随时恢复；不参与运行时、不参与 typecheck
  （`tsconfig.json` 仅 include `src/`、`test/`、`.opencode/`）。

## 内容清单

```
archive/sandbox/
├── src/plugins/sandbox/index.ts            增强插件①本体（platform-exec 工具 + 会话钩子）
├── src/bootstrap.ts                        沙箱装配点（kernel + backend + capability 组装）
├── src/capabilities/sandbox/               错误码体系（SandboxError）、shell 规范化
├── src/capabilities/shell-exec.ts          shell.exec capability 包装
├── src/execution/                          执行内核：kernel / policy / process / environment /
│                                           sandbox-backend 接口 / windows-appcontainer-backend
├── src/config/sandbox-config.ts            配置加载与校验
├── config/sandbox.json                     沙箱运行配置（workspace RW / .git RO / 网络 deny 等）
├── runtime/                                Windows AppContainer OS 边界：
│                                           启动器（PowerShell）、原生辅助（C#，CreateProcessW
│                                           AppContainer + Job Object）、ACL 库、遗留清理脚本、
│                                           README（执行链、请求 schema、保护模型——设计对齐
│                                           anthropics/sandbox-runtime，借鉴不依赖）
└── test/                                   沙箱单元/集成测试 + host 侧测试助手
```

配套改动（在归档之外）：

- `.opencode/agents/private.md` 权限回归 `bash: allow`，移除 `platform-exec` 强制路由
- `src/adapters/opencode/index.ts` 注册表置空（插件以一行登记方式接入）
- 定位修订记录见 `../../agent-platform-plan.md` §0.5

## 如何恢复

1. 将本目录内容按原相对路径移回 `.extensions/` 对应位置；
2. `src/adapters/opencode/index.ts` 注册表登记 `sandboxExtension`；
3. `.opencode/agents/private.md` 恢复 `bash: deny` + `platform-exec: allow`；
4. `package.json` 恢复沙箱测试链（可参考 git 历史或本 README 内容清单）；
5. `npm run gate` 全绿后回归。

> 注意：`.extensions/runtime/README.md`（现位于 `runtime/README.md`）是沙箱运行时的
> 权威设计文档，未来 OpenChamber 沙箱设计时建议直接参考。
