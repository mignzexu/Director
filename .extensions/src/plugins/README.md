# Enhancement Plugins（增强插件）开发约定

每个增强插件 = `src/plugins/<id>/` 下一个**自包含文件夹**。本文件是硬约束：不符约定的插件不进注册表。

## 文件夹布局

```
src/plugins/<id>/
├── index.ts        ← 唯一出口：组装并导出 ExtensionPlugin（tools + hooks）
├── <feature>.ts    ← 插件私有实现（随规模拆分；index.ts 超 ~150 行时必须拆）
└── …               ← 插件私有模块
```

- `index.ts` 是插件的**唯一公共出口**，聚合器（`src/adapters/opencode/index.ts`）只 import 各文件夹的 `index.ts`
- 插件内部文件不得被其他插件或聚合器直接引用（文件夹即边界）

## 允许的依赖（白名单）

| 可引用 | 说明 |
|---|---|
| `../types.ts` | 共享契约（ExtensionPlugin / Context） |
| `../../state/*`、`../../core/*` | 平台共享设施（审计 / 状态存储 / Capability Registry / AgentPlatform） |
| `../../runtime/*` | DPN-AOR Core Runtime（事件存储 / Reducer / 状态快照 / World State / 记忆 / 研究，Phase 1–10） |
| `zod` | 工具 args schema 校验（通用库，非宿主依赖） |

> **宿主无关契约（Phase 12 独立性收口）**：插件层零宿主 SDK 引用——工具通过
> 自有 `ExtensionTool` 契约声明（args 为 zod shape），宿主耦合收口在
> `ToolPort` 三字段（agent / sessionID / directory，见 `plugins/types.ts`）。
> opencode 的 ToolContext 映射发生在 L2 适配器；换 coding CLI = 写一个新
> 适配器，插件与 Runtime 零改动。边界由 `test/boundary.test.ts` 锁定。

新增平台级共享模块（如 `capabilities/`、`execution/`）时，先在本表登记再引用。
（沙箱时代的 `execution/`、`bootstrap.ts`、`capabilities/sandbox/` 已归档至 `archive/sandbox/`，插件不得引用。）

**禁止**：插件之间互相引用；引用其他插件的私有模块；绕过聚合器直接向宿主贡献 hooks 或工具。

## 注册（一行）

```ts
// src/adapters/opencode/index.ts
export const extensionRegistry: readonly ExtensionPlugin[] = [
  <new>Extension,   ← 新插件在此登记（当前注册表为空）
]
```

## 工具命名

- 工具 id = 贡献时的 key（如 `"verify-run"`），同时是 agent 权限键（agent 定义里的 `<tool-id>: allow`）
- 命名模式：`<域>-<动作>`，域前缀区分插件，避免与 opencode 内置工具（bash/read/edit…）重名

## 风险声明（Phase 3 原则种子，登记义务）

每个工具贡献时必须在插件 README 或工具 description 中声明风险等级：

- **low**：仅读写 `.extensions/state/` 下平台数据（如 runtime-ledger 的 fact/plan/solver/director 工具）
- **medium**：触发本地进程执行、工作区文件写入、网络访问
- **high**：不可逆变更（git mutation、外部系统写入、删除操作）

声明不是运行时门禁。触发条件：出现第一个 medium 以上工具时，以其为元数据建立 Capability Gateway（准入 + `ToolContext.ask()` 审批 + 审计）；此前宿主原生权限键即门禁。

> **状态（2026-09-06）：条件已触发。** 首个 medium 工具 = `verify-run`
> （runtime-ledger，本地进程执行）。Gateway 最小化已启用：medium 登记 +
> JsonlAuditLogger 审计（`.extensions/state/runtime/audit.jsonl`）+ 宿主
> 权限键（private.md `verify-run: allow`）。`ToolContext.ask()` 审批为
> Gateway 第二步（待宿主审批行为验证后接入）。

## 故障与隔离规则（聚合器语义，勿在插件内重复实现）

- `setup` 失败 → 记日志、不致命、不阻断其他插件
- `onEvent` 抛错 → 记日志、不影响其他插件
- 工具 id 冲突 → **启动即抛错**（配置错误必须响亮）
- 超时/中止遵循 opencode 原生契约；涉及本地进程/网络执行的插件须自带隔离与清理策略，并在插件 README 登记威胁模型（OS 级沙箱已随 archive/sandbox/ 移出本项目范围）

## 上线前检查清单

1. `npm run typecheck` 通过
2. `test/extensions-routing.test.ts` 补充该插件的聚合断言（工具 id、事件行为）
3. 涉及本地进程/网络执行的插件：登记隔离、超时与清理策略（原 `npm run test:host` 已随沙箱归档移除）
4. README（本目录或插件内）登记用途与依赖
