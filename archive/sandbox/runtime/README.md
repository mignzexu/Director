# Windows Sandbox Runtime（Agent Extensions 的 OS 边界）

本目录是 Agent Extensions（opencode 增强层）的安全边界实现。设计借鉴 `anthropics/sandbox-runtime`（Claude Code 同款引擎）的核心思想，但**不依赖其 npm 包**——引擎为项目自有，运行时零外部依赖（Windows 自带的 PowerShell 5.1 + .NET Framework csc.exe）。

## 定位：增强，而非寄生

- opencode 侧只有一个入口文件 `.opencode/plugins/agent-extensions.ts`（L1）
- 所有增强能力是 `.extensions/src/plugins/<id>/` 下的**自包含增强插件**（L2），经 `src/adapters/opencode/index.ts` 的静态注册表聚合路由
- 平台执行工具名为 **`platform-exec`**（附加式、可选启用），**不覆盖**内置 bash —— 只有 `private` agent 启用它；其他 agent（如 build）走 opencode 原生 shell，**结构上不受本扩展故障影响**

## 与 Anthropic sandbox-runtime 的设计对齐

| 借鉴的设计 | 本实现 | 位置 |
|---|---|---|
| 稳定错误码枚举（`WindowsSandboxErrorCode` 模式） | `SandboxErrorCode` 联合类型 + 双通道输出（legacy 前缀行 + JSON 行） | `src/capabilities/sandbox/errors.ts` |
| **无标记文件，状态来自活体枚举**（"no marker file"） | 每次执行对全部期望规则做 `Get-Acl` 活体验证，只修复缺失项；`provision.json` 标志已废除 | launcher `Invoke-LiveProvision` + `_acl-lib.ps1 Test-SandboxRule` |
| **行为级自检 fail-closed**（`verifyWindowsWfpEgress` 模式） | 任何修复发生后，在沙箱内真实探测：workspace 可写 / 保护路径拒写 / 网络拒连；任一矛盾→拒绝执行用户命令 | launcher `Invoke-BehavioralVerify` |
| Shell 唯一规范化入口，不静默降级（`parseWindowsBinShell` 模式） | `parseBinShell` / `resolveCommandShell`（TS）+ `Test-LauncherShell`（PS 双重校验）；comspec 必须是绝对路径 cmd.exe | `src/capabilities/sandbox/shell.ts` |
| 结构化错误通道（stderr JSON `{code,message}` + 退出码契约） | kernel 解析 JSON 行 → `result.error_code` → audit 记录 | errors.ts + kernel.ts |
| **纯授权缺失模型**（专用用户 + additive grants 的本地方言） | 保护路径**不依赖 deny ACE 求值顺序**：继承隔离（`SetAccessRuleProtection`）+ 剥除沙箱 SID 的一切 ACE——无授权 = AppContainer 默认拒绝 | `_acl-lib.ps1 Set/Test-SandboxPathPolicy` |

**有意不采用**：专用沙箱用户 + WFP 防火墙（需 UAC 管理员安装与 Rust 二进制，违反项目零外部依赖原则）；MITM 域名白名单代理（网络保持二值 deny，Phase 2 再评估）；bash.exe 内层 shell（命令契约是 cmd 风格 `&` 链）。

### 关键教训（写进设计的实证）

1. **deny ACE 对 AppContainer token 不可依赖**：实测"全控制显式 deny + SID 精确匹配 + ACE 首位"仍被容器内写入穿透。因此保护一律走**授权缺失**（无授权 = AppContainer 默认拒绝，与 ACE 求值顺序无关），deny 只作为冗余残留。
2. **权限读写必须容忍 SYNCHRONIZE 位**：Windows 会把写入的 rights 自动加上 `0x100000`（我们写 `0x301BF`，读回 `0x1301BF`）。精确数值比较会永久失配 → 无限修复循环 + ACE 重复累积。`Find-SandboxRule` 用 `-bor 0x100000` 双侧归一。
3. **.NET FileSystemSecurity 的 Remove* 不可靠**：对继承型、甚至刚物化的规则都会静默无效。**ACL 变更一律走系统自带 `icacls`**（/inheritance:d → /remove:g|d → /grant，/T 子树传播），.NET 仅用于只读验证（Get-Acl 枚举是可靠的）。
4. **容器 token 的 SID 求值语义**（实证）：包 SID 的 deny/allow 均不可依赖；AU(Authenticated Users) 组授权对容器**读取**可见、**写入**不可见（疑与完整性级别策略有关，机理未完全定位）。**因此行为探针一律以宿主侧文件系统真相为准**（Test-Path），绝不信任容器内退出码/`if exist`。
5. **对被占用目录改名会失败**：exec 临时目录在改名目标树内时，cmd 持有 command.cmd/stdout 句柄。

## 执行链路

```
LLM 调用 platform-exec
  → .opencode/plugins/agent-extensions.ts   （L1 唯一入口，薄路由）
  → src/adapters/opencode/index.ts          （L2 聚合器：静态注册表）
  → src/plugins/sandbox/index.ts            （增强插件：platform-exec 工具定义）
  → src/bootstrap.ts                        （平台获取：项目根解析 + 能力执行入口）
  → src/execution/kernel.ts                （解析输入 / 策略 / 审计 + error_code 解码）
  → src/execution/windows-appcontainer-backend.ts
      comspec 规范化（capabilities/sandbox/shell.ts）→ 写 request JSON → 启动 launcher
  → runtime/windows-appcontainer-launcher.ps1
      活体验证 + 修复 + 行为自检（_acl-lib.ps1）
  → runtime/windows-appcontainer-native.cs（csc 预编译 dll，哈希缓存）
      CreateProcessW(AppContainer SID) + Job Object(KillOnJobClose)
  → cmd.exe 运行 command.cmd，stdout/stderr 重定向到临时文件
```

## Request Schema（version 2，launcher 拒绝其他版本）

```jsonc
{
  "version": 2,
  "workspace": "D:\\proj",            // 沙箱根；读写
  "cwd": "D:\\proj",                  // 必须位于 workspace 内
  "command": "npm test",
  "comspec": "C:\\…\\cmd.exe",        // 必须为绝对路径 cmd.exe（双重校验）
  "environment": { "PATH": "…", … },  // kernel 已 sanitize（白名单 + 密钥 drop + 沙箱标记）
  "protected_paths": [".git", ".extensions/config", …],  // workspace 相对路径
  "profile": "agent-platform-main",   // 固定 AppContainer profile 名（config.profile）
  "launcher_timeout_ms": 117500       // kernel timeout - 2500 余量；launcher 自超时返回 124
}
```

每次调用的临时目录由 launcher 固定创建在 `<workspace>/.extensions/tmp/exec-*`（request 中没有该字段），finally 块中自删；kernel 侧 `sweepStaleTmpDirs` 兜底清 24h 前残留。

## 退出码与错误契约

| 退出码 | 含义 |
|---|---|
| `0..` | 命令自身退出码 |
| `124` | launcher 内部超时击杀（kernel 映射为 `timed_out: true`） |
| `125` | 沙箱错误（stderr 有结构化错误行） |

错误码全表见 `src/capabilities/sandbox/errors.ts`（`request_unsupported` / `profile_invalid` / `shell_invalid` / `workspace_invalid` / `cwd_invalid` / `native_unavailable` / `provision_failed` / `verify_failed` / `verify_network_open` / `protected_probe_violation` / `internal_error`）。

## 保护路径模型（授权缺失，policy v3+）

| 路径 | 模式 | 容器内效果 |
|---|---|---|
| `.git` | ReadOnly | 可读+执行，不可写（隔离 + 单一 RX 授权） |
| `.opencode` | Blocked | 完全不可访问 |
| `.extensions/config` `.extensions/state` | Blocked | 完全不可访问 |
| 过渡期 `.agent-platform/config|state`（junction） | Blocked | 同上（与 .extensions 指向同一目录） |

- 实现：`icacls /inheritance:d`（切断继承、物化副本）→ `icacls /remove:g|d *SID /T`（剥除沙箱 SID 全部 ACE，含子树）→（ReadOnly 时）`icacls /grant *SID:(OI)(CI)RX /T` 回加唯一 RX。**变更走 icacls，验证走 .NET 只读枚举，裁决走宿主侧行为探针——三者互不信任。**
- 活体验证：`Test-SandboxPathPolicy` 检查 DACL protected + SID 授权形态精确匹配；不匹配 → 修复 → 行为探针 fail-closed（宿主侧 Test-Path 判定）。
- 子树传播依赖 `Set-Acl` 的自动继承重算；修复后由行为探针兜底证实。

## 超时契约

kernel timeout（默认 120s，请求可覆盖）→ launcher 收到 `timeout - 2500ms` 余量。正常路径下 launcher 内部 `WaitForSingleObject` 超时 → `TerminateJobObject` → 退出 124，不依赖外层 taskkill；外层强杀只是兜底（Job 的 KillOnJobClose 保证容器进程树必死）。

## 嵌套沙箱限制（重要）

沙箱内的进程**不能再创建沙箱**（同 profile 嵌套 CreateProcess 会死锁；容器内 libuv spawn 也不可用）。因此：

- 容器内 `TEMP/TMP` 被 Windows 虚拟化为 `%LOCALAPPDATA%\Packages\<profile>\AC\Temp`
- `npm test` 在容器内运行时，process/kernel/sandbox.integration 三个套件自动 SKIP（`AGENT_PLATFORM_SANDBOXED=1` 或 AC 路径特征检测）
- **这三个套件必须在宿主机跑**：`npm run test:host`（改动 launcher / native / process.ts 后必跑）

## 修改协议（防止破坏运行中的宿主）

1. **TS 层改动**（kernel/backend/模块）是"重启后生效"——运行中进程持有旧模块，磁盘改动不影响当前会话
2. **launcher / native / _acl-lib 改动立即生效**（每次调用重新加载）——必须保持 request v2 契约与退出码不变；错误输出只增不改
3. 任何 runtime 改动后的四关门禁：`npm run gate`（typecheck + test）+ PS 语法解析 + 活体探针（echo / 保护路径拒写 / 超时击杀）
4. 破坏性删除（如请求版本下线）只能在做完 1-3 并经重启验证后的**下一个会话**执行

## 一次性维护脚本

- `cleanup-legacy-acl.ps1`：清理 v1 随机 profile 时代泄漏的孤儿 AppContainer profile 与死 SID ACE。`-IncludeDriveRoots` 做全盘去污（极慢，非必需——死 SID ACE 是惰性污染）。

## 修改本目录的检查清单

1. 改 `.cs` → dll 缓存自动失效重编译（哈希校验），无需手工清理
2. 改 ACL 模型 → 递增 launcher 的 `$policyVersion`（仅影响日志标注；活体验证天然自愈）
3. 改 request schema / 错误码 → 同步 `windows-appcontainer-backend.ts`、`capabilities/sandbox/errors.ts` 与本 README
4. 任何修改后：容器内 `npm run gate`，宿主机 `npm run test:host`
