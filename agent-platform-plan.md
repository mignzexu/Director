# OpenChamber + OpenCode 最先进 Agent Platform 与 Private Agent 架构方案

> 目标：不是在 OpenCode 中复刻一个 Codex，而是把 OpenCode 强化成一个 **Agent Platform / Agent OS**。
>
> Codex、OpenCode 以及未来其他先进 Agent 系统，只作为能力来源和参考实现。
>
> 在这个强化后的平台上，再注册并构建一个项目级 Private Agent，作为第一个高级 Agent。

---

# 0. 定位修订（2026-09-03）：Agent Platform → Agent Extensions

> 2026-09-03 起本节为最新定位；**2026-09-05 起以 §0.5 为准（Sandbox 暂停移交）**。

## 0.1 关系姿态：增强，而非寄生

OpenCode 是**主体**；本项目（原 Agent Platform，现名 **Agent Extensions**）是 opencode 的**增强扩展层**：

- 自定义 agent 以 opencode 为主（原生注册、原生工具优先）
- opencode 缺失的能力（安全执行、未来的验证/记忆/编排）由 Extension 的**增强插件**补齐
- **增强插件一律附加式、可选启用**——绝不覆盖内置工具。实证教训：早期的 bash 项目级覆盖使所有 agent（含 build）被迫依赖平台沙箱，平台故障曾导致 build agent 不可用

## 0.2 二级路由架构

```
opencode（宿主）
   │  唯一接口：.opencode/plugins/agent-extensions.ts        ← L1 Extension 入口（永不膨胀）
   ▼
.extensions/src/adapters/opencode/index.ts                   ← L2 聚合器（静态注册表）
   ├── src/plugins/sandbox/       增强插件①：安全执行（已归档 → archive/sandbox/，见 §0.5）
   ├── src/plugins/opensandbox/   增强插件②：Linux 沙箱/代码解释器（随沙箱方向一并暂停，见 §0.5）
   └── src/plugins/…              增强插件③④…：verification / memory（Phase 4/6）
```

- 私有 agent 权限：`bash: deny` + `platform-exec: allow` —— 执行强制走沙箱，安全模型不降级（**2026-09-05 起失效**：沙箱归档，回归原生 `bash: allow`，见 §0.5）
- 其他 agent 零依赖扩展

## 0.3 增强插件②预留：OpenSandbox（alibaba/OpenSandbox，Apache 2.0）

Docker/K8s Linux 容器沙箱平台（多语言 SDK 含 TypeScript + 官方 MCP Server）。定位：为智能体提供 **Linux 执行环境 / Code Interpreter / 并行隔离执行** 能力（本机 AppContainer 沙箱保护工作区，两者互补）。集成方式：L1 薄插件（TS SDK）→ L2 注册表注册。**前置条件：宿主机 Docker Desktop（WSL2）。当前环境暂缓，仅设计预留。**

## 0.4 沙箱引擎设计对齐（anthropics/sandbox-runtime，借鉴不依赖）

稳定错误码体系、无标记文件的活体 ACL 验证、行为级自检 fail-closed、shell 唯一规范化、结构化错误通道、**纯授权缺失保护模型**（deny ACE 对 AppContainer token 不可依赖——实证）。详见 `.extensions/runtime/README.md`（已随沙箱归档至 `archive/sandbox/runtime/README.md`）。

## 0.5 定位修订（2026-09-05）：Sandbox 暂停移交，重心转向插件框架

> **本节为最新定位，与前文（含 §0–§0.4）冲突时以本节为准。**

**决定**：沙箱（OS 级隔离执行）开发就此**暂停**，实现整体归档至 `archive/sandbox/`（保留完整可恢复的 Windows AppContainer 实现；不参与运行时与 typecheck）。私有 agent 回归 opencode 原生 `bash` 执行，`platform-exec` 工具与 `bash: deny` 强制路由一并移除。

**原因**：沙箱/OS 级隔离是宿主管理层的职责，未来由 **OpenChamber** 逐步提供类似 sandbox 的能力，本项目不再投入该方向。（旁证：同类 coding agent 如 ZCode 亦未提供 OS 级强制沙箱——仅在协议层预留沙箱语义与审批模式，官方建议用户自行套 VM/沙箱运行。）

**影响范围**：

- §0.2 路由树中 `plugins/sandbox/`（已归档）与 §0.3 OpenSandbox 预留（随沙箱方向一并暂停）
- §15 默认 Sandbox Policy、§16 Sandbox Backend、§17 Capability Escalation、§32/§40 的 remote sandbox、§42 Security Principles、§46 原则第 7 条「Execution 必须经过 Sandbox」→ 保留为**历史设计记录**，不再是本项目路线图；未来 OpenChamber 沙箱设计可直接参考 `archive/sandbox/`（`runtime/README.md` 含完整执行链与保护模型）
- §33 Phase 1 清单中的沙箱条目（OS sandbox backend、network denied 等）→ 已完成，随归档封存
- `.opencode/agents/private.md`：权限回归 `bash: allow`

**新重心**：增强插件框架本身的**模块化与易接入性**——L1 唯一入口 → L2 静态注册表一行登记 → 自包含插件文件夹（约定见 `.extensions/src/plugins/README.md`）。后续插件（候选：verification / memory 等，待定）按约定实现并登记。

---

# 1. 核心结论

本项目应该分成两个层次：

```text
第一层：Agent Platform
第二层：Private Agent
```

Private Agent 不自己实现基础设施。

Agent Platform 负责：

```text
execution
sandbox
permissions
memory
context
orchestration
task graph
verification
model routing
capabilities
state
audit
```

Private Agent 负责：

```text
identity
behavior
goals
delegation strategy
tool usage strategy
task completion policy
```

最终结构：

```text
OpenChamber
    │
    ▼
OpenCode
    │
    ├── Agent Registry
    ├── Session / Conversation
    ├── Provider / Model Layer
    ├── Native Tools
    └── Plugin / Tool Extension APIs
             │
             ▼
       Agent Platform
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
 execution context orchestration
     │       │        │
     └───────┼────────┘
             ▼
        Private Agent
```

---

# 2. 首先确认：Private Agent 能否注册进 OpenCode

答案：

> 可以。

Private Agent 可以成为 OpenCode 原生 Agent Registry 中的正式 Agent。

例如：

```text
build
plan
general
explore
private
```

Private Agent 可以：

```text
- 作为 primary agent
- 被用户直接选择
- 被设为 default_agent
- 根据 mode 配置作为 subagent
```

推荐注册方式：

```text
.opencode/agents/private.md
```

或：

```text
opencode.json / opencode.jsonc
```

示例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",

  "default_agent": "private",

  "agents": {
    "private": {
      "description": "My private autonomous engineering agent",
      "mode": "primary"
    }
  }
}
```

这意味着：

```text
OpenCode
├── build
├── plan
├── private
├── explore
└── general
```

`private` 是 OpenCode 原生认识的 Agent ID，而不是外部旁路服务。

---

# 3. 必须区分：注册 Agent 与实现 Agent

OpenCode 当前 Agent Registry 注册的是：

```text
Agent Definition
├── id
├── description
├── mode
├── model
├── prompt/system
├── permissions
└── metadata
```

它不是：

```ts
class MyAgent extends Agent {
  async think() {}
  async act() {}
  async fork() {}
  async recover() {}
}
```

因此：

> Private Agent 可以原生注册。
>
> 但 OpenCode 当前稳定扩展接口并不是通过注册一个自定义 Agent class 来替换主 Agent Loop。

所以我们采用：

```text
Declaratively Registered
+
Programmatically Implemented
```

也就是：

```text
OpenCode Agent Registry
        ↓
注册 private 的身份

OpenCode Plugin / Tool API
        ↓
接入 Agent Platform

Agent Platform
        ↓
实现真正高级能力

Private Agent
        ↓
组合这些能力
```

---

# 4. 不建议依赖动态 Plugin 注册 Agent

技术上 Plugin 可以修改配置。

但不建议把 Private Agent 是否存在完全依赖 Plugin 初始化时动态注入。

原因：

```text
Agent Registry 初始化
和
Plugin config hook
```

可能存在初始化时序问题。

因此第一阶段使用：

```text
.opencode/agents/private.md
```

或：

```text
opencode.jsonc
```

做稳定的 Agent Identity 注册。

平台逻辑使用代码实现。

原则：

> Agent 注册使用 OpenCode 原生机制。
>
> Agent 能力使用代码扩展。

---

# 5. 新的顶层目标：Agent Platform Kernel

旧方向：

```text
Private Agent Runtime
    ↓
补 Codex 能力
```

新的方向：

```text
Agent Platform Kernel
    ↓
吸收所有先进 Agent 系统的优秀能力
    ↓
Private Agent
```

Codex 只是参考实现之一。

如果：

```text
Codex sandbox 更好
```

就吸收它。

如果：

```text
OpenCode provider abstraction 更好
```

就保留 OpenCode。

如果：

```text
其他 Agent 有更先进 memory / planning / task graph
```

就在平台层加入。

目标不是追随单个 Agent 产品，而是建立可持续进化的 Agent Platform。

---

# 6. 推荐项目结构

```text
your-project/
│
├── .opencode/
│   │
│   ├── agents/
│   │   ├── private.md
│   │   ├── researcher.md
│   │   ├── reviewer.md
│   │   └── planner.md
│   │
│   ├── tools/
│   │   ├── bash.ts
│   │   ├── fork_agent.ts
│   │   ├── send_agent.ts
│   │   ├── wait_agent.ts
│   │   ├── list_agents.ts
│   │   └── close_agent.ts
│   │
│   └── plugins/
│       └── agent-platform.ts
│
├── .agent-platform/
│   │
│   ├── src/
│   │   │
│   │   ├── core/
│   │   │   ├── platform.ts
│   │   │   ├── capability-registry.ts
│   │   │   ├── event-bus.ts
│   │   │   └── types.ts
│   │   │
│   │   ├── execution/
│   │   │   ├── sandbox.ts
│   │   │   ├── process.ts
│   │   │   ├── filesystem.ts
│   │   │   ├── network.ts
│   │   │   └── workspace.ts
│   │   │
│   │   ├── orchestration/
│   │   │   ├── supervisor.ts
│   │   │   ├── scheduler.ts
│   │   │   ├── task-graph.ts
│   │   │   └── delegation.ts
│   │   │
│   │   ├── context/
│   │   │   ├── context-engine.ts
│   │   │   ├── working-memory.ts
│   │   │   ├── episodic-memory.ts
│   │   │   ├── semantic-memory.ts
│   │   │   └── compaction.ts
│   │   │
│   │   ├── verification/
│   │   │   ├── verifier.ts
│   │   │   ├── evaluator.ts
│   │   │   ├── critic.ts
│   │   │   └── evidence.ts
│   │   │
│   │   ├── models/
│   │   │   ├── router.ts
│   │   │   ├── registry.ts
│   │   │   └── policy.ts
│   │   │
│   │   ├── policy/
│   │   │   ├── permission.ts
│   │   │   ├── capability.ts
│   │   │   └── policy-engine.ts
│   │   │
│   │   ├── state/
│   │   │   ├── state-store.ts
│   │   │   ├── audit.ts
│   │   │   └── telemetry.ts
│   │   │
│   │   └── adapters/
│   │       └── opencode/
│   │           ├── plugin.ts
│   │           ├── tools.ts
│   │           ├── session.ts
│   │           └── agent.ts
│   │
│   ├── state/
│   │
│   ├── policy.json
│   └── package.json
│
├── opencode.json
│
└── ...
```

核心原则：

```text
.opencode/*
    =
thin OpenCode adapters

.agent-platform/*
    =
platform implementation
```

OpenCode API 将来变化时，只修改：

```text
.agent-platform/src/adapters/opencode/
```

不修改平台核心。

---

# 7. OpenCode 在整个架构中的职责

保留 OpenCode 已经做得好的部分。

OpenCode 负责：

```text
LLM provider integration
multi-model support
session / conversation
UI protocol
OpenChamber integration
native agent registry
basic tool dispatch
config
model-specific baseline prompts
```

不重复实现这些。

---

# 8. Agent Platform 的职责

Agent Platform 负责 OpenCode 当前不足、且高级 Agent 长期需要的能力。

包括：

```text
Capability Kernel
Execution Kernel
Context Engine
Memory
Agent Supervisor
Task Graph
Scheduler
Verification
Model Router
Permission / Capability Policy
Persistent State
Audit
Telemetry
Transactional Workspace
```

---

# 9. Capability Kernel

未来所有高级能力都通过统一 Capability Registry 暴露。

例如：

```ts
interface Capability {
  id: string

  description: string

  execute(
    input: unknown,
    context: CapabilityContext
  ): Promise<unknown>
}
```

Registry：

```ts
interface CapabilityRegistry {
  register(
    capability: Capability
  ): void

  get(
    id: string
  ): Capability

  list(): Capability[]
}
```

未来 capability 可以包括：

```text
shell.exec
filesystem.read
filesystem.write
git.inspect
git.mutate
browser.navigate
browser.extract
research.search
memory.read
memory.write
agent.fork
agent.send
agent.wait
workspace.create
workspace.merge
verify.tests
verify.diff
```

Agent 不直接依赖底层实现。

Agent 只依赖 capability。

---

# 10. OpenCode Plugin 作为 Platform Adapter

建议：

```text
.opencode/plugins/agent-platform.ts
```

成为 OpenCode 与 Agent Platform 之间的主要接口。

它负责：

```text
OpenCode
    │
    ▼
AgentPlatformPlugin
    │
    ├── Tool Adapter
    ├── Session Adapter
    ├── Context Adapter
    ├── Permission Adapter
    ├── Agent Adapter
    └── Event Adapter
            │
            ▼
       Agent Platform
```

不要把业务逻辑塞进 Plugin 文件。

Plugin 只负责翻译：

```text
OpenCode API
    ↕
Agent Platform API
```

---

# 11. Prompt 设计必须谨慎

Private Agent 不应该一开始就使用一个巨型自定义 system prompt。

原因：

OpenCode 的 Agent system/prompt 配置可能替换 provider-specific baseline prompt，而不是简单追加。

因此第一阶段建议：

```jsonc
{
  "agents": {
    "private": {
      "description": "Private autonomous engineering agent",
      "mode": "primary"
    }
  }
}
```

尽量保留 OpenCode 针对不同模型提供的 baseline。

Private Agent 的额外行为策略以后应该通过：

```text
Base Prompt
+
Agent Policy
+
Dynamic Context
+
Memory
+
Task State
```

进行可控 assembly。

不要简单：

```text
system = 一个几千字超级 Prompt
```

---

# 12. Execution Kernel

Execution Kernel 是第一批必须构建的基础能力。

组成：

```text
Execution Kernel
├── sandbox
├── process lifecycle
├── filesystem policy
├── network policy
├── environment policy
└── workspace manager
```

这部分可以吸收 Codex 的精华。

---

# 13. 第一项实现：覆盖原生 Bash

OpenCode 原生 shell 权限接近宿主用户。

因此第一阶段应该优先覆盖：

```text
bash
```

执行路径：

```text
LLM
 ↓
OpenCode tool dispatch
 ↓
project-local bash tool
 ↓
Agent Platform
 ↓
Execution Kernel
 ↓
OS sandbox
 ↓
real command
```

模型仍然调用：

```ts
bash({
  command: "npm test"
})
```

但实际已经经过平台控制。

---

# 14. Bash Capability 接口

建议：

```ts
type ShellExecInput = {
  command: string

  cwd?: string

  timeout_ms?: number

  permissions?: {
    network?: boolean

    read?: string[]

    write?: string[]
  }

  justification?: string
}
```

返回：

```ts
type ShellExecResult = {
  exit_code: number

  stdout: string

  stderr: string

  duration_ms: number

  timed_out: boolean

  sandbox: {
    network: boolean

    read_roots: string[]

    write_roots: string[]
  }
}
```

---

# 15. 默认 Sandbox Policy

默认：

```text
workspace:
  read: allow
  write: allow

.git:
  read: allow
  write: deny

outside workspace:
  read: deny
  write: deny

network:
  deny

home:
  deny

credentials:
  deny
```

目标：

```text
workspace
├── read: yes
├── write: yes
├── .git: read-only
├── ../: denied
├── ~/.ssh: inaccessible
├── ~/.aws: inaccessible
└── network: off
```

---

# 16. Sandbox Backend

第一版应实现项目自有的 OS sandbox adapter。

Codex、其他 Agent 或系统工具只能作为安全模型的参考，不能成为本项目的运行时依赖。

Phase 1 在 Windows 上使用项目内维护的 AppContainer 启动器和 Windows 原生 API。

所有 profile 参数、权限策略、启动协议和生命周期逻辑都必须保存在本项目中。

定义统一接口：

```ts
interface SandboxBackend {
  exec(
    input: SandboxExecInput
  ): Promise<SandboxExecResult>
}
```

Backend 接口未来可以支持：

```text
WindowsAppContainerBackend
CodexReferenceBackend（仅在未来明确批准时作为独立可选适配）
BubblewrapBackend
SeatbeltBackend
ContainerBackend
RemoteSandboxBackend
```

这意味着：

> 外部 Agent 产品可以提供设计参考，但不能成为本项目的隐含运行时依赖。

---

# 17. Capability Escalation

Agent 不应该为了完成任务直接逃出 sandbox。

正确流程：

```text
command
  ↓
sandbox insufficient
  ↓
identify missing capability
  ↓
request minimum permission
  ↓
human approval
  ↓
temporary scoped capability
  ↓
execute
```

Capability：

```ts
type RequestedCapability = {
  network?: boolean

  read?: string[]

  write?: string[]

  git_write?: boolean

  justification: string
}
```

批准必须：

```text
invocation scoped
```

而不是永久修改全局权限。

---

# 18. Process Lifecycle

高级 Agent Platform 必须正确管理 subprocess。

实现：

```text
timeout
AbortSignal
process group
child process cleanup
SIGTERM
SIGKILL fallback
stdout/stderr streaming
output limits
exit status
```

防止：

```text
agent cancelled
但 npm/python/test 仍后台运行
```

---

# 19. Context Engine

Context 不应该只等于聊天历史。

统一定义：

```text
Agent Context
├── conversation
├── task state
├── current objective
├── workspace state
├── git diff
├── relevant files
├── tool evidence
├── working memory
├── episodic memory
└── constraints
```

Context Engine 负责给不同 Agent 构造最适合的上下文。

---

# 20. Context Fork

参考 Codex 的 context fork，但做成平台级能力。

```ts
fork_agent({
  task: "...",

  context: {
    turns: 6,
    include_git_diff: true,
    include_worktree_state: true,
    include_memory: true
  }
})
```

执行：

```text
parent context
     │
     ▼
Context Engine
     │
     ├── recent conversation
     ├── task state
     ├── git diff
     ├── relevant memory
     └── constraints
     │
     ▼
normalized child context
     │
     ▼
child OpenCode session
```

目标是语义 fork。

不要求完全复制模型隐藏 reasoning state。

---

# 21. Memory Architecture

不要把“conversation history”当成完整 memory。

未来 Private Agent 至少需要：

```text
Working Memory
Episodic Memory
Semantic Memory
Preference Memory
Project Memory
```

建议：

```text
Memory
├── working
│   └── 当前任务短期状态
│
├── episodic
│   └── 过去完成过什么任务
│
├── semantic
│   └── 项目稳定知识
│
├── project
│   └── 架构、约束、习惯
│
└── preference
    └── 用户偏好
```

第一版可以只做：

```text
working memory
project memory
```

其余后续扩展。

---

# 22. Agent Supervisor

Agent Platform 自己提供 Agent 生命周期。

```ts
interface AgentSupervisor {
  fork(input: ForkAgentInput): Promise<AgentHandle>

  send(
    id: string,
    message: string
  ): Promise<void>

  wait(
    ids: string[]
  ): Promise<AgentResult[]>

  list(): Promise<AgentInfo[]>

  close(
    id: string
  ): Promise<void>
}
```

工具：

```text
fork_agent
send_agent
wait_agent
list_agents
close_agent
```

---

# 23. Agent Lifecycle

状态：

```ts
type AgentState =
  | "created"
  | "running"
  | "waiting"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled"
  | "closed"
```

记录：

```ts
type AgentRecord = {
  id: string

  sessionId: string

  parentSessionId?: string

  task: string

  state: AgentState

  createdAt: number

  updatedAt: number

  result?: string

  error?: string
}
```

---

# 24. Task Graph

这是未来超过普通 coding agent 的关键能力之一。

不要只支持：

```text
main agent
  ├── child A
  ├── child B
  └── child C
```

还要支持：

```text
Task Graph
    │
    ├── inspect architecture
    │       ↓
    ├── identify change points
    │       ↓
    ├── implement backend
    │
    ├── implement frontend
    │
    └── run verification
            ↓
         final review
```

节点：

```ts
type TaskNode = {
  id: string

  objective: string

  dependencies: string[]

  status:
    | "pending"
    | "ready"
    | "running"
    | "blocked"
    | "completed"
    | "failed"

  assignedAgent?: string

  result?: unknown
}
```

---

# 25. Scheduler

Scheduler 负责：

```text
parallelism
dependency resolution
priority
retry
resource limit
agent limit
task timeout
```

第一版建议：

```text
max_parallel_agents = 4
max_agent_depth = 2
```

后续 task graph scheduler 可以更高级。

---

# 26. Verification Kernel

先进 Agent 最大的问题之一不是“能不能写代码”。

而是：

> 如何可靠判断自己真的完成了任务。

因此 verification 必须成为平台 primitive。

包括：

```text
tests
lint
typecheck
build
diff review
requirements check
critic agent
evidence collection
confidence
```

建议：

```ts
interface VerificationEngine {
  verify(
    task: TaskState
  ): Promise<VerificationResult>
}
```

返回：

```ts
type VerificationResult = {
  passed: boolean

  evidence: string[]

  failures: string[]

  confidence: number
}
```

---

# 27. Private Agent 完成条件

Private Agent 不应该：

```text
代码写完
    =
任务完成
```

应该：

```text
implementation
    ↓
verification
    ↓
evidence
    ↓
remaining uncertainty
    ↓
completion
```

完成条件由平台统一定义。

---

# 28. Model Router

OpenCode 已经有很强的 provider/model abstraction。

不要重新实现 provider integration。

Agent Platform 只做智能路由。

例如：

```text
planning
    → strongest reasoning model

cheap exploration
    → fast model

code review
    → another strong model

large context analysis
    → long-context model
```

接口：

```ts
interface ModelRouter {
  select(
    task: ModelTaskProfile
  ): Promise<ModelSelection>
}
```

Model Router 不是第一阶段 MVP。

但架构必须预留。

---

# 29. Agent Capability Registry

未来 Agent 应该声明自己擅长什么，而不仅仅是一个名字。

例如：

```ts
type AgentCapabilityProfile = {
  planning: number
  coding: number
  review: number
  research: number
  debugging: number
  browser: number
}
```

Supervisor 可以据此选择：

```text
哪个 Agent
+
哪个模型
+
哪个能力组合
```

执行任务。

这比固定：

```text
general
explore
reviewer
```

更容易扩展。

---

# 30. Persistent State

Agent Platform 状态不能完全依赖 OpenCode conversation。

建议：

```text
.agent-platform/state/
├── agents.json
├── tasks.json
├── memory/
├── processes.json
├── audit.jsonl
└── telemetry.jsonl
```

加入：

```gitignore
.agent-platform/state/
```

---

# 31. Audit

所有高风险能力都必须 audit。

例如：

```json
{
  "timestamp": "2026-09-02T12:00:00Z",

  "session_id": "...",

  "agent": "private",

  "capability": "shell.exec",

  "command": "npm install",

  "permissions": {
    "network": true
  },

  "approved": true,

  "exit_code": 0,

  "duration_ms": 4132
}
```

未来不仅 shell。

还包括：

```text
network
browser
filesystem
git mutation
external APIs
agent delegation
memory mutation
```

---

# 32. Transactional Workspace

高级 coding agent 很适合用 transaction 思维。

```text
main workspace
       │
       ▼
temporary task workspace
       │
       ├── edits
       ├── tests
       ├── lint
       ├── verification
       │
       ▼
      pass?
     /    \
   yes     no
    │       │
  merge   discard
```

可以用：

```text
git worktree
snapshot
container workspace
remote sandbox
```

实现。

这是第二阶段以后值得加入的高级能力。

---

# 33. 第一阶段真正应该实现什么

新的 Phase 1 不再叫：

```text
Private Bash Runtime
```

而应该叫：

# Phase 1 — Agent Platform Foundation

目标：

```text
建立平台边界
+
注册 Private Agent
+
完成 Execution Kernel 第一版
```

必须完成：

```text
[x] private Agent 原生注册
[x] Agent Platform 目录与核心接口
[x] OpenCode Adapter / Plugin
[x] Capability Registry
[x] shell.exec capability
[x] 覆盖 built-in bash
[x] OS sandbox backend
[x] workspace RW
[x] .git RO
[x] outside workspace denied
[x] network denied
[x] sanitized environment
[x] timeout
[x] AbortSignal
[x] process tree cleanup
[x] structured result
[x] audit
```

这时我们得到：

```text
OpenCode
   +
Agent Platform Skeleton
   +
Private Agent
   +
Secure Execution
```

---

# 34. Phase 2 — Capability & Permission Kernel

实现：

```text
[x] capability request
[x] network escalation
[x] external read escalation
[x] external write escalation
[x] git mutation capability
[x] justification
[x] human approval
[x] invocation-scoped permission
[x] audit
```

目标：

```text
Agent 不再拥有“全权限工具”。

Agent 拥有：
capabilities
+
scoped permissions
```

---

# 35. Phase 3 — Context & Agent Orchestration

实现：

```text
[x] Agent Supervisor
[x] fork_agent
[x] send_agent
[x] wait_agent
[x] list_agents
[x] close_agent
[x] semantic context fork
[x] working memory
[x] git diff context
[x] worktree context
[x] max parallel
[x] max depth
```

---

# 36. Phase 4 — Verification Kernel

实现：

```text
[x] task verification API
[x] tests
[x] lint
[x] typecheck
[x] build verification
[x] diff verification
[x] evidence collection
[x] completion policy
```

这一步非常重要。

Agent 完成任务必须有 evidence。

---

# 37. Phase 5 — Task Graph & Scheduler

实现：

```text
[x] task DAG
[x] dependencies
[x] parallel scheduling
[x] assignment
[x] retry
[x] blocked tasks
[x] task state persistence
```

这一步开始后，Private Agent 从：

```text
coding assistant
```

开始变成：

```text
autonomous engineering agent
```

---

# 38. Phase 6 — Memory

建议顺序：

```text
working memory
    ↓
project memory
    ↓
episodic memory
    ↓
semantic memory
    ↓
preference memory
```

不要一开始就引入复杂 vector database。

先确保 memory schema 和 retrieval policy 正确。

---

# 39. Phase 7 — Model Routing

在前面的 runtime 已稳定后，再做：

```text
task profile
    ↓
model router
    ↓
provider/model selection
```

目标：

```text
不同工作用最合适的模型
```

而不是始终把所有任务交给一个最贵模型。

---

# 40. Phase 8 — Transactional / Remote Execution

后续：

```text
temporary worktree
remote sandbox
parallel isolated workspaces
long-running tasks
durable jobs
resume
checkpoint
```

这时平台能力会超过普通本地 coding agent。

---

# 41. 第一版不要做的事情

不要一开始做：

```text
重新实现 OpenCode Agent Loop
fork OpenCode
fork OpenChamber
完整长期记忆系统
复杂 workflow DSL
分布式 scheduler
自研 container runtime
全自动 self-improvement
巨型 system prompt
```

首先建立：

```text
正确平台边界
+
Capability Kernel
+
Execution Kernel
+
Private Agent 注册
```

---

# 42. Security Principles

## 42.1 Prompt 不是安全边界

错误：

```text
“不要访问 ~/.ssh”
```

正确：

```text
OS sandbox 无法访问 ~/.ssh
```

---

## 42.2 Agent 不直接获得 Host Shell

所有 shell execution：

```text
Agent
 ↓
Capability Kernel
 ↓
Execution Kernel
 ↓
Sandbox
```

---

## 42.3 Capability 最小化

不要：

```text
allow all
```

应该：

```text
request minimum capability
```

---

## 42.4 Approval 必须 scoped

不要：

```text
用户批准一次网络
→ 永久网络打开
```

应该：

```text
仅当前 invocation
```

---

## 42.5 Secrets 默认不可见

不要默认传：

```text
SSH
AWS
GCP
Azure
GitHub Token
Docker socket
Kubernetes config
LLM API keys
```

---

# 43. Agent Platform 核心接口建议

```ts
export interface AgentPlatform {
  capabilities: CapabilityRegistry

  execution: ExecutionKernel

  permissions: PermissionKernel

  agents: AgentSupervisor

  context: ContextEngine

  memory: MemoryEngine

  verification: VerificationEngine

  tasks: TaskGraph

  models: ModelRouter

  state: StateStore

  audit: AuditLogger
}
```

第一阶段可以部分实现。

未实现部分用：

```ts
NotImplemented
```

或 feature flag。

不要因为未来模块多，就在 MVP 中全部完成。

---

# 44. Private Agent 应该非常薄

`.opencode/agents/private.md` 不承担平台逻辑。

例如：

```md
You are the primary private engineering agent for this repository.

Use platform capabilities rather than bypassing the platform.

Delegate independent work when useful.

Before declaring a task complete, obtain verification evidence.

Prefer reversible and verifiable changes.

Surface uncertainty when verification is incomplete.
```

未来可以更丰富。

但不要把：

```text
sandbox
memory
task graph
verification
permissions
```

规则只写在 prompt。

它们应该存在于代码。

---

# 45. 最终目标架构

```text
                    OpenChamber
                         │
                         ▼
                ┌─────────────────┐
                │    OpenCode     │
                │                 │
                │ Session / LLM   │
                │ Agent Registry  │
                │ Provider Layer  │
                │ UI Protocol     │
                └────────┬────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ OpenCode Adapter    │
              │ AgentPlatformPlugin │
              └──────────┬──────────┘
                         │
                         ▼
                ┌─────────────────┐
                │ Agent Platform  │
                └────────┬────────┘
                         │
        ┌────────────────┼─────────────────────┐
        │                │                     │
        ▼                ▼                     ▼
 Capability Kernel  Context Engine       Orchestration
        │                │                     │
        │          ┌─────┼─────┐         ┌────┼─────┐
        │          ▼     ▼     ▼         ▼    ▼     ▼
        │        work  memory state   agent task scheduler
        │
        ▼
 Execution Kernel
        │
 ┌──────┼──────────┐
 ▼      ▼          ▼
sandbox process workspace
 │
 ▼
Host / Remote Runtime

        ┌────────────────────────┐
        │ Verification Kernel    │
        │ tests / eval / critic  │
        │ evidence / confidence  │
        └──────────┬─────────────┘
                   │
                   ▼
              Private Agent
```

Private Agent 是：

```text
OpenCode 原生注册身份
+
Agent Platform 能力组合
```

而不是一个塞满所有 infrastructure 的大 class。

---

# 46. 设计原则总结

整个项目遵守以下原则：

```text
1. OpenCode 是宿主平台，不重复实现其优势。
2. Private Agent 必须原生注册进 OpenCode。
3. Agent 注册与 Agent 实现分离。
4. Agent Platform 使用代码实现。
5. Plugin 只做 Adapter。
6. Capability 是主要抽象。
7. Execution 必须经过 Sandbox。
8. Permission 必须最小化且 scoped。
9. Context 不等于聊天历史。
10. Memory 是独立平台能力。
11. Verification 是任务完成条件的一部分。
12. Multi-agent 应由 Supervisor 管理。
13. Task Graph 应成为长期核心能力。
14. Model Router 使用 OpenCode Provider 层，不重新造 Provider。
15. Codex 是能力来源之一，不是最终目标。
16. 架构必须允许未来吸收新的先进 Agent 能力。
```

---

# 47. 当前可行性判断

| 能力 | 可行性 |
|---|---:|
| Private Agent 原生注册 | 10/10 |
| Private Agent 作为 primary | 10/10 |
| Private Agent 设置 default | 10/10 |
| Private Agent 使用自定义 tools | 10/10 |
| OpenCode Plugin 接 Agent Platform | 9/10 |
| 项目级代码实现 Platform | 10/10 |
| Capability Registry | 10/10 |
| 覆盖原生 Bash | 10/10 |
| OS Sandbox | 9/10 |
| Scoped Permission | 9/10 |
| Agent Supervisor | 9/10 |
| Semantic Context Fork | 8/10 |
| Verification Kernel | 10/10 |
| Task Graph | 10/10 |
| Persistent Memory | 10/10 |
| Intelligent Model Router | 9/10 |
| Transactional Workspace | 9/10 |
| 完全替换 OpenCode 内部 Agent Loop | 不建议 |
| 精确复制任意模型隐藏 reasoning state | 不可依赖 |

总体：

> 构建一个长期可扩展的高级 Agent Platform，并在其中运行一个原生注册到 OpenCode 的 Private Agent，具有很高可行性。

---

# 48. 给 OpenCode 的第一条实现任务

建议先只完成 Phase 1。

```text
Implement Phase 1 of the Agent Platform architecture described in this document.

The objective is NOT to recreate Codex.

The objective is to establish a reusable Agent Platform layer inside this project, integrated with OpenCode, and register the first native Private Agent on top of that platform.

Phase 1 scope:

1. Register a native OpenCode agent named `private`.
   - It must be selectable as a primary agent.
   - Prefer project-local `.opencode/agents/private.md` or stable project config.
   - Do not depend on plugin initialization order for the existence of the agent.

2. Create the initial `.agent-platform/` architecture.
   - Add a small core `AgentPlatform` interface.
   - Add a `CapabilityRegistry`.
   - Add an initial `ExecutionKernel`.
   - Add state and audit interfaces.
   - Keep unimplemented future subsystems as clean interfaces or placeholders only when useful.

3. Create the OpenCode adapter.
   - Add `.opencode/plugins/agent-platform.ts` or the appropriate project-local plugin integration supported by the installed OpenCode version.
   - Keep this adapter thin.
   - Runtime logic must remain under `.agent-platform/`.

4. Implement the first platform capability: `shell.exec`.
   - Override the built-in OpenCode `bash` tool using a project-local custom tool if supported by the installed OpenCode version.
   - Route shell execution into the Agent Platform Execution Kernel.

5. Implement secure execution.
   Default sandbox policy:
   - project/worktree readable and writable
   - `.git` readable but not writable
   - filesystem outside workspace not writable
   - common credential locations inaccessible
   - network disabled by default
   - sanitized environment
   - timeout support
   - AbortSignal support
   - process-group cleanup
   - stdout/stderr output limits
   - structured execution result

6. Use a backend abstraction for sandboxing.
   - Do not depend on any external agent runtime (including Codex) at runtime.
   - Phase 1 implements a project-owned Windows AppContainer backend: profiles, ACL policy, launch protocol, and lifecycle logic live inside this project.
   - External agent systems are reference material only; adopting any of their components requires explicit approval.
   - Define a generic `SandboxBackend` interface so it can later be replaced with Bubblewrap, Seatbelt, containers, remote sandboxes, or another backend.

7. Add audit logging.
   Record:
   - session
   - agent
   - capability
   - command
   - cwd
   - permissions
   - timing
   - exit code
   - timeout/cancellation status

8. Add automated tests for:
   - Private Agent registration
   - workspace write success
   - outside-workspace write denial
   - `.git` write denial
   - credential access denial
   - network denial
   - timeout cleanup
   - AbortSignal cleanup
   - structured result
   - audit output

Constraints:

- Do not fork OpenCode.
- Do not modify OpenCode core unless absolutely necessary and clearly justified.
- Do not implement a custom LLM/provider layer.
- Do not implement multi-agent orchestration yet.
- Do not implement long-term memory yet.
- Do not implement a task graph yet.
- Do not use a giant custom system prompt.
- Do not rely on prompt instructions for security.
- Keep `.opencode/*` as adapters.
- Put reusable platform logic in `.agent-platform/*`.
- Design interfaces so future capabilities can include:
  - agent orchestration
  - context fork
  - memory
  - verification
  - task graph
  - model routing
  - transactional workspaces
  - browser/research capabilities

Before coding:

1. inspect the repository structure
2. detect the exact installed OpenCode version/API surface
3. inspect project-local agent, plugin, and custom-tool support
4. propose the exact file changes
5. implement Phase 1 only
6. run tests
7. show final diff
8. document remaining limitations and the next recommended platform capability
```

---

# 49. 下一阶段

Phase 1 验收后，再进入：

```text
Phase 2
Capability / Permission Kernel

Phase 3
Context Engine + Agent Supervisor

Phase 4
Verification Kernel

Phase 5
Task Graph + Scheduler

Phase 6
Memory

Phase 7
Model Router

Phase 8
Transactional / Remote Execution
```

每完成一层，都应该让 Private Agent 直接获得新增能力。

最终 Private Agent 不应该是一个固定产品。

它应该随着 Agent Platform 能力增长而持续进化。

---

# 50. 最终定义

本项目最终要构建的不是：

```text
一个 Codex clone
```

也不是：

```text
一个更复杂的 OpenCode prompt
```

而是：

```text
OpenCode
    +
Advanced Agent Platform
    +
Native Private Agent
```

其中：

```text
OpenCode
=
模型、会话、UI、Provider、Agent Registry

Agent Platform
=
执行、能力、权限、上下文、记忆、编排、验证、任务图、状态

Private Agent
=
身份、策略、目标、决策与能力组合
```

这是当前最适合长期演进的方向。
