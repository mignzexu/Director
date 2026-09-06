# DPN-AOR Agent Runtime 构建路线图

## 总体战略判断

当前阶段不应该继续深入设计更多 Agent Persona、Prompt 或复杂多 Agent
协作逻辑。

优先目标应该从：

> 设计智能体

转向：

> 构建承载智能体的 Autonomous Runtime Framework。

OpenChamber 私有 Agent 插件槽应作为扩展入口，而不是直接承载所有智能。

核心路线：

    OpenChamber Plugin
            |
            v
    Private Agent Runtime Layer
            |
            v
    DPN-AOR Core Runtime
            |
            v
    Agent / Solver / Tools

最终目标：

构建一个由 Runtime 管理状态、计划、证据、能力和 Agent
生命周期的自主问题求解系统。

------------------------------------------------------------------------

# Phase 0：确定系统边界

## 目标

不要立即实现 Agent。

首先明确：

系统中哪些属于 Runtime，哪些属于 Agent。

## 架构：

    Runtime
     |
     +-- State Management
     +-- Event System
     +-- Task Management
     +-- Capability Gateway
     +-- Verification
     |
    Agent
     |
     +-- Reasoning
     +-- Planning
     +-- Execution

## 交付物

-   系统架构文档
-   模块边界定义
-   数据流设计

## 能力提升

从：

单 Agent 插件

升级为：

Agent Runtime 平台。

------------------------------------------------------------------------

# Phase 1：构建 Event Runtime（第一核心）

## 目标

建立系统事实流。

不要让 Agent 直接修改状态。

设计：

    Agent Action

          |

          v

    Event

          |

          v

    Reducer

          |

          v

    Runtime State

## 核心对象

Event:

``` json
{
 id:"",
 type:"",
 source:"",
 payload:"",
 timestamp:""
}
```

## 实现：

-   Event Store
-   Reducer
-   State Snapshot

> **状态（2026-09-05）：已完成。** 实现位于 `.extensions/src/runtime/`：
> `types.ts` 事件契约（RuntimeEvent / RuntimeState）、`event-store.ts`
> 追加只写 JSONL 事件日志（权威事实源）、`reducer.ts` 纯归约器（fail-loud）、
> `snapshot.ts` 状态快照（缓存，可随时从日志重放重建）、`index.ts`
> `createRuntime()` 门面（`dispatch()` 为唯一状态变更入口，坏 payload
> 在落日志前被拒绝）。已接入 `core/platform.ts` 的 `runtime` 槽位；
> 测试 `test/runtime-events.test.ts`（16 项，`npm run gate` 全绿）。
> 运行数据默认位于 `.extensions/state/runtime/`（已 gitignore）。

## 能力提升

从：

Agent 输出文本

升级为：

系统拥有可追踪状态。

------------------------------------------------------------------------

# Phase 2：构建 World State 与 Evidence 系统

## 目标

解决 Agent 最大问题：

不知道什么是真的。

实现：

    World State

    +
    Evidence

## State:

``` json
{
 entity:"",
 property:"",
 value:"",
 confidence:"",
 status:""
}
```

状态：

-   UNKNOWN
-   OBSERVED
-   VERIFIED
-   STALE
-   INVALID

## Evidence:

``` json
{
 source:"",
 type:"",
 reliability:"",
 timestamp:""
}
```

> **状态（2026-09-05）：已完成。** 实现位于 `.extensions/src/runtime/`：
> `types.ts` 新增 FactStatus（UNKNOWN/OBSERVED/VERIFIED/STALE/INVALID）、
> 证据类型→可靠度代码对照表（human 1.0 / test 0.9 / external 0.8 /
> tool_output 0.7 / agent_claim 0.3）与铁律 `canVerify`（agent_claim
> 永远不足以 VERIFIED——执行者不能证明自己成功）；`reducer.ts` 新增 5 种
> 事实事件（fact.unknown/observed/verified/invalidated/staled），状态迁移
> 合法性矩阵与置信度推导（status+证据可靠度的纯函数）由代码强制；
> 证据 ID 确定性派生自事件 ID（`ev:${event.id}`），历史证据永久保留于
> `state.evidence`；快照引入 `schemaVersion`（旧快照自动作废、从日志
> 全量重放）。测试 `test/world-state.test.ts`（17 项）+ Phase 1 回归
> 16 项，`npm run gate` 全绿。决策记录：蓝图 §2 的 PARTIAL 状态暂缓
> （暂无触发语义，待 Phase 10 研究型 Solver 出现时按需添加）。

## 能力提升

从：

Agent 相信自己

升级为：

Runtime 管理事实。

> **Phase 2.5 集成验证（2026-09-05）：已完成。** 增强插件
> `runtime-ledger`（`.extensions/src/plugins/runtime-ledger/`）注册进
> L2 注册表——管道里第一次有了真实的水。工具 `fact-record` / `fact-query`
> 打通 opencode → L1 → L2 → DPN Runtime 全链路：agent 记账带调用方身份
> 落盘（source 取自工具上下文）、铁律违规在账本外被拒（ok:false 且零
> 污染）、缺参在工具层返回结构化错误、重新组合（重启语义）从账本完整
> 恢复历史。集成测试 `test/runtime-ledger.test.ts`（7 项，含真实注册表
> 组合断言）。系统现在可由任意 agent 实测：在 opencode 中让 private
> agent 调 `fact-record`，即可在 `.extensions/state/runtime/events.jsonl`
> 看到事件。

------------------------------------------------------------------------

# Phase 3：构建 Capability Gateway

## 目标

不要让 Agent 直接拥有工具。

建立能力层。

架构：

    Agent

     |

    Capability Gateway

     |

    Tool

Capability 示例：

``` json
{
 name:"run_test",
 scope:"workspace",
 risk:"medium",
 approval:true
}
```

负责：

-   权限
-   审批
-   风险控制
-   后续 Sandbox 接入

## 能力提升

从：

Agent = 权限拥有者

升级为：

Agent = 能力请求者。

------------------------------------------------------------------------

# Phase 4：构建 DPN 基础模型

## 目标

把计划从文本变成 Runtime 对象。

Node:

``` json
{
 id:"",
 type:"",
 goal:"",
 owner:"",
 precondition:"",
 action:"",
 expected_state:"",
 verifier:"",
 status:""
}
```

Node 类型：

-   Outcome
-   Milestone
-   Task
-   Verification
-   Recovery

## 能力提升

从：

LLM 生成计划

升级为：

Runtime 管理动态计划图。

> **状态（2026-09-05）：已完成。** 实现位于 `.extensions/src/runtime/`：
> `types.ts` 新增 PlanNode/五类型/SCHEMA_VERSION 3；`reducer.ts` 新增 6 种
> plan.node.* 事件 + 生命周期状态机 + `nodeReadiness()` 就绪度推导 + 依赖
> 环检测。设计要点：节点图通过事件演化、走 Phase 1 账本；`parent` 表达
> outcome→milestone→task 分解层次（容器须先声明），`dependsOn` 表达执行
> 前提（须已存在），`preconditionFacts` 把 Phase 2 世界状态变成计划门控
> （全部 VERIFIED 才可能就绪）；就绪度是查询时现算的纯函数（不存储 ready
> 标志，取消/失败依赖自动阻塞下游）；完成必须挂证据且 agent_claim 无效
> （铁律贯通到计划层）；owner 挂钩 Phase 5 Solver；uncertainty E0–E4 仅
> 声明留位。工具层：runtime-ledger 拆分为 facts.ts + plan.ts 私有模块，
> 新增 `plan-node` / `plan-query` 工具，private.md 显式授权四工具。测试
> `test/plan-model.test.ts`（15 项）+ 插件 E2E（9 项）+ 既有回归 54 项，
> `npm run gate` 全绿。
>
> **Phase 3 决策记录（2026-09-05）：撤销。** 沙箱已归 openchamber
> （Phase 11 同步作废），基础权限归宿主原生权限键（工具 id 即权限键）；
> 风险分级约定（low/medium/high）作为登记义务写入 `.extensions/src/
> plugins/README.md`，Capability Gateway 触发条件：出现首个 medium 以上
> 风险工具时再建（用 `ToolContext.ask()` 审批 + 审计）。

------------------------------------------------------------------------

# Phase 5：构建 Solver Runtime

## 目标

定义 Solver，而不是定义 Agent Prompt。

Solver:

    Solver

    =
    Agent Instance
    +
    Context
    +
    Memory
    +
    Capability
    +
    Local State

负责：

-   局部规划
-   执行
-   反馈
-   修正

## 能力提升

从：

聊天机器人

升级为：

任务执行单元。

> **状态（2026-09-05）：已完成。** 实现位于 `.extensions/src/runtime/`：
> `types.ts` 新增 SolverEntry/SCHEMA_VERSION 4；`reducer.ts` 新增 6 种
> solver.* 事件 + `solverContract()` 合同推导 + MAX_ACTIVE_SOLVERS=4
> 并发铁律。**概念定位（实现前与用户澄清确认）**：Solver 是执行者的
> 工牌（合同+履历），不是变形金刚——本体（智能/人格/工具）在宿主侧
> opencode agent，专业化由宿主 persona/模型选择承担（"不定义 Agent
> Prompt"），Director（Phase 6）是未来的项目经理。解决的问题：P1 执行
> 归属（spawn 原子交接：节点须 pending+就绪 → active + owner=solverId）、
> P2 执行履历（progress 逐条入账，重启可重放）、P3 结果责任（交卷双侧
> 联动：success 须非 agent_claim 证据 → solver finished + 节点自动
> completed 同证据登记；failure → 双双 failed）、P4 卡顿显式化
> （active⇄blocked）、P5 并发上限（第 5 个活跃拒绝）、P6 为 Director
> 预备名册。stopped 释放节点回 pending（清 owner 可重新认领）。实现
> 细节：solverId 由 reducer 强制显式给出，自动编号在工具层基于状态
> 生成（事件日志完全自描述）。**已知身份缺口**：工具调用按 agent 名
> 归因，solverId 为自报，密码学绑定待宿主 session 映射。工具层：
> runtime-ledger 新增 `solvers.ts` 私有模块与 `solver-spawn` /
> `solver-report` / `solver-query`（含 shieldContract 视图）三工具
> （共 7 个）。测试 `test/solver-model.test.ts`（15 项）+ 插件 E2E
> （11 项）+ 既有回归 78 项，`npm run gate` 全绿。

------------------------------------------------------------------------

# Phase 6：构建 Director 控制循环

## 目标

实现全局控制。

循环：

    Observe

    ↓

    Compare Goal

    ↓

    Calculate Gap

    ↓

    Select Plan

    ↓

    Delegate

    ↓

    Observe

实现：

-   Global Goal
-   Global DPN
-   Replan

## 能力提升

从：

任务执行

升级为：

自主问题求解。

> **状态（2026-09-05）：已完成（制度层）。形态决策（与用户两轮讨论收束）**：
> 制度进 Runtime，教义进 skill——三层分工：本体（宿主模型，通才引擎）←
> 教义（用户渐进式 skill，私有规划逻辑）← 制度（Runtime）。Runtime 只供
> 三样：观察数据、决策留痕、合同纪律。**Director 不建新对象**：=
> solver-spawn 认领 outcome 节点 + role="director"（蓝图 Primary Solver
> 原则）。实现：`types.ts` 新增 PlanHealth/DirectorReviewEntry/PlanState
> （reviews+churn）/SCHEMA_VERSION 5；`reducer.ts` 新增 `planHealth()`
> 纯函数（完成度/可派队列/阻塞面+精确缺口/活跃工作/卡住名册/失败面/
> 已知未知/churn 率，全部推导非存储、比率两位舍入）+ churn 由 reducer
> 独占维护 + `director.reviewed` 分支（五类校验：未知 director/非
> active/节点不匹配/合同非 outcome/缺 reasoning；nextActions 格式强制）。
> Replan/Reframe 不需要新事件：= Director 的判断 + 现有图操作事件序列，
> 账本天然记录每次 replan/reframe 链条。插件新增 `director.ts`：
> `director-tick`（纯观察零事件）+ `director-review`（结论落账），共
> 9 工具；private.md 补齐全部工具显式权限（含 Phase 5 遗漏的三个
> solver 权限）。教义骨架 `skills/director-doctrine/SKILL.md`（七章节
> 留白 + reference/ 渐进层，内容由所有者填充）。不做：永动循环、自动
> 决策、模型路由、reframe 判据入代码。测试 `test/director-model.test.ts`
> （10 项）+ 插件 E2E 完整导演一轮（13 项）+ 既有回归 92 项，
> `npm run gate` 全绿。

------------------------------------------------------------------------

# Phase 7：构建 Verification Runtime

## 目标

执行者不能证明自己成功。

流程：

    Execution Result

    ↓

    Verifier

    ↓

    Evidence

    ↓

    State Update

实现：

Verifier:

-   Test verifier
-   Code verifier
-   Human verifier
-   External verifier

## 能力提升

从：

完成声明

升级为：

证据驱动完成。

> **状态（2026-09-06）：已完成。核心洞察**：Phase 2 的可靠度表存在后门
> ——证据类型由 agent 自选（谎报 test 即得 0.9）。Phase 7 的真正使命是
> **让证据从申报制变成产出制**：机器可复现的验证必须机器亲证。实现：
> **零新事件类型**（制度表面积不变，变的是证据质量）。
> ① **制度裁定规则**：evidence type ∈ {test, tool_output} 且无
> mechanism="verify-run" → 裁定降级 external（0.8，declared-downgraded，
> 指纹丢弃）——裁定而非拒绝，历史事件重放与 dispatch 同构（旧账自动
> 诚实降级，无断代）；② **verify-run 工具**（verifiers.ts，medium 风险
> ——首个本地进程执行工具）：spawn 真实命令（超时进程树强杀 taskkill
> /T /F、输出上限 64KB、outputTail 400 字符）→ exit code 决定
> pass/fail → 自动 dispatch fact.observed（mechanism=verify-run +
> command/exitCode/timedOut/outputTail 指纹），depth=verified 引用同一
> evidenceId 连发升格 VERIFIED 0.9；③ **evidence 引用机制**：
> observed/verified/completed 可引用已有证据（{evidenceId}），亲证凭证
> 不重复生成；④ **run: 完成门禁**：verifier 以 "run: " 开头 = 机器可读
> 验证声明，completed（含 solver success 联动）要求 mechanism=verify-run
> 且 command 严格匹配；⑤ **申报收窄**：fact-record/plan-node/
> solver-report 的 evidenceType 枚举收窄为 DECLARED_EVIDENCE_TYPES
> （human/external/agent_claim）；⑥ **Gateway 最小化触发**：README 约定
> 首个 medium 工具到齐——JsonlAuditLogger 审计设施首次真实启用
> （audit.jsonl）+ 权限键 + 登记，ask() 审批留待 Gateway 第二步。
> SCHEMA_VERSION 6（存量证据强制重裁）。不做：飞行记录仪（调试阶段
> 清单第 1 项）、human/external 独立通道、CI 集成、ask() 审批。测试
> `test/verification-model.test.ts`（17 项）+ 插件 E2E 扩至 16 项
> （verify-run 真执行/审计/超时/run: 门禁全流程）+ 既有回归 105 项，
> `npm run gate` 全绿（10 文件 138 项）。

------------------------------------------------------------------------

# Phase 8：构建 Memory 系统

## 目标

支持长期认知。

拆分：

## Problem Memory

问题理解。

## Decision Memory

为什么这样决策。

## Execution Memory

执行历史。

## Failure Memory

失败经验。

## 能力提升

从：

短上下文 Agent

升级为：

持续学习系统。

> **状态（2026-09-06）：已完成（融合外部研究修订）。设计研究**：调研五大
> 流派——Mem0（LLM 写时管线 ADD/UPDATE/DELETE/NOOP）、Letta/MemGPT（OS
> 三层 + agent 自编辑，业界点名 "self-editing reliability gap"）、
> Zep/Graphiti（双时态知识图谱 + 边失效而非删除）、Claude memory tool
> （Anthropic 刻意避开向量库选文件）、遗忘研究（decay 是搜索时重排非
> 物理删除）。**结论：拒绝向量 RAG**（本系统记忆天然结构化；embedding
> 属可吞区）；我们的账本/World State 与 Zep 的 episodic/semantic 子图
> 同构，锚定制是对 self-editing gap 的制度解法。**实现——"3 推导 +
> 1 原语"**：四类记忆三类为推导视图（Execution=账本 / Decision=reviews /
> Failure=failed 聚合 / Problem=goals+intents+未知，memoryRecall 纯函数），
> 唯一新存储原语 = lesson（泛化经验卡片）。**锚定强制**：lesson 必须引用
> 真账（evidenceId/节点 id 精确校验、seq ∈ 1..revision 范围校验）——
> 经验不许编造（Phase 7 产出制哲学延伸到记忆）。**退休语义**（Mem0 decay
> 启发）：retired 只在 recall 重排中沉底隐藏，从不删除；排序分组优先于
> 时间。**relatedExisting**：memory-record 返回同主题已有经验（Mem0 写时
> 合并决策变为 agent 显式决策——分工不变）。**asOf 点时间查询**（Zep
> 双时态启发）：memory-recall 按指定 seq 重放账本后推导——事件溯源免费
> 获得的时间点记忆。2 个新事件（memory.lesson.recorded/retired）、
> LessonEntry（id 派生 `ls:${event.id}`）、SCHEMA_VERSION 7。工具
> memory-record / memory-recall（共 12 个，全 low）。**E2E 抓出并修复
> 一个 run: 门禁漏洞**：失败的 witness（exit≠0）原先也能完成节点——
> 门禁补上 exitCode===0 检查（"失败的运行不能完成节点"）。不做：向量库、
> 跨项目记忆（scope 留位）、compaction、graph/实体抽取、project memory
> 进 Runtime、使用频率强化追踪（留位）。测试 `test/memory-model.test.ts`
> （18 项）+ 插件 E2E 扩至 18 项 + 既有回归 106 项，`npm run gate`
> 全绿（11 文件 142 项）。

------------------------------------------------------------------------

# Phase 9：构建 Failure Recovery

## 目标

让系统面对失败继续工作。

失败分类：

    Failure

    ├── Tool Failure
    ├── Environment Failure
    ├── Permission Failure
    ├── Logic Failure
    ├── Knowledge Failure
    └── Goal Failure

恢复：

    Local Repair

    ↓

    Subgraph Replan

    ↓

    Global Replan

    ↓

    Reframe

## 能力提升

从：

失败停止

升级为：

自主恢复。

> **状态（2026-09-06）：已完成（融合外部研究修订）。设计研究**：三大流派
> ——① LLM agent 自纠错（分层恢复 retries→fallbacks→circuit breakers→
> re-planning 与蓝图四级同构；Reflexion"言语强化"= 我们 Phase 8 lesson
> 已实现；Aider 结构化错误反馈重试；Google ADK reflect-and-retry）；
> ② 工作流引擎（Temporal：Retry Policy 显式化 max attempts +
> nonRetryableErrorTypes、无界重试危害、Saga 补偿）；③ MAST 失败分类学
> （NeurIPS 2025，14 模式三阶段）。**实现——只补四个数据面**（Replan/
> Reframe 是现有图操作序列、Reflexion 已有，照搬路线图建恢复子系统是
> 重复建设）：① **plan.node.reopened**（failed → pending、retryCount+1、
> 清 owner——Local Repair 的重启原语；cancelled 不可复活，走 replan
> 新建）；② **circuit breaker 是制度**：MAX_NODE_RETRIES=3 写死 reducer，
> 超限拒绝并指向 Subgraph Replan（cancel + supersedes 新建）；③ **失败
> 分类数据面**：failureClass 六类枚举（tool/environment/permission/
> logic/knowledge/goal）——归类归智能、枚举校验归制度，solver failure
> 传播到合同节点；④ **supersedes 替代链**：created 声明替代哪个失败节点
> （校验目标必须 failed），Subgraph Replan 在图上可见可审计。
> planHealth 透出 retryableFailures/exhaustedFailures 区分；reopen 后
> 下游阻塞自动解除（推导涌现）。**Saga 补偿** = 失败清理配方
> （stop solver → invalidate 受污染事实 → cancel 下游）记入教义章节
> 提示，不建子系统。**不做**：指数退避/自动重试执行（Runtime 无头）、
> MAST 14 类全收、自动 re-planning（归 Director）。工具零新增（融入
> plan-node/solver-report）。测试 `test/recovery-model.test.ts`（14 项）
> + 插件 E2E 双流对照 19 项（tool 失败重试成功 vs logic 失败超限走
> 替代）+ 既有回归 124 项，`npm run gate` 全绿（12 文件 157 项）。

------------------------------------------------------------------------

# Phase 10：构建 Research Solver

## 目标

把未知问题纳入统一系统。

流程：

    Unknown

    ↓

    Question

    ↓

    Hypothesis

    ↓

    Experiment

    ↓

    Evidence

    ↓

    Resolution

## 能力提升

从：

工程 Agent

升级为：

研究型 Agent。

> **状态（2026-09-06）：已完成（融合外部研究修订）。设计研究**：① 自主
> 科学研究派（Sakana AI Scientist-v2 全自动循环、Agent Laboratory co-pilot
> 定位、以及"自主性海市蜃楼"的批评——与宪法"两端留人"一致）；② **HEP
> 假设演化协议（arXiv 2607.09195）——与我们架构双胞胎**：其注册表就是
> "append-only 事件溯源 + 重放派生"（= Phase 1 账本），它多出的认知对象
> 层即本 Phase 增量（hypothesis 五态、信念引出、阈值 verdict、lineage）；
> ③ AGM 信念修正/认知完整性（矛盾是要修复的失败而非容忍的常态）；
> ④ 实验设计理论（MAB/探索利用归智能侧）。**HEP 三失败模式的现成解药**：
> 弱模型"跑实验不挂结果"→ verify-run 亲证 + belief 强制引用 evidenceId；
> 高先验锚定（P>0.7 从未翻转）→ 阈值门禁 + 教义严峻测试纪律；证据自报
> → 证据分级与亲证机制。**实现——五个新事件**（research.question.raised/
> resolved、hypothesis.proposed/belief.updated/evaluated）：
> **Question**（主动化的 unknown，状态 open/resolved）；**Hypothesis**
> （belief 引出而非计算 + rationale 必填 + lineage 三机制 de-novo/
> inspired-by/refine + **防泡沫规则**：refine 未检验 parent 拒绝）；
> **belief.updated 的 validation gate**：必须引用真账 evidenceId（产出制
> 延伸到认知层）；**verdict 是阈值制度转换**：supported 需 belief ≥ 0.8、
> refuted 需 ≤ 0.2、dormant 需 reasoning，终态冻结信念；**Resolution 桥**：
> supported 后 agent 显式落 fact.verified——世界状态永远由证据产出。
> **实验不建新对象**：= 计划节点（可选 tests 声明，校验 hypothesisId
> 存在）+ verify-run 亲证（Phase 7 已备）。Lazy Epistemic Expansion
> （蓝图 §14）全链闭环：UNKNOWN 门控 → raise → propose → 实验 → belief
> → verdict → fact.verified → 门开 → 任务完成。SCHEMA_VERSION 9。
> 工具 research-question / research-hypothesis / research-query（共 15 个，
> 全 low）。**不做**：贝叶斯自动计算（引出而非计算）、自动矛盾检测
> （Contradiction/Anomaly 归智能）、merge lineage（留位）、文献检索
> （第一版内部实验循环）、PARTIAL 事实状态（假设层已表达部分结论，
> 维持 Phase 2 暂缓）。测试 `test/research-model.test.ts`（15 项）+
> 插件 E2E 完整认知循环 20 项 + 既有回归 138 项，`npm run gate` 全绿
> （13 文件 173 项）。

------------------------------------------------------------------------

# Phase 11：接入 Sandbox Runtime

## 目标

最终安全边界。

架构：

    Capability Gateway

            |

    Sandbox

            |

    Tool Execution

支持：

-   Container
-   VM
-   OS Sandbox

## 能力提升

从：

权限控制

升级为：

安全自治。

------------------------------------------------------------------------

# Phase 12：形成完整 DPN-AOR Runtime

最终：

    USER GOAL

       |

    Director

       |

    Global DPN

       |

    Solver Network

       |

    Capability Gateway

       |

    Tools

       |

    Evidence

       |

    Runtime State

       |

    Replan

系统具备：

-   状态管理
-   动态规划
-   自主执行
-   事实验证
-   错误恢复
-   长期记忆
-   安全隔离

> **状态（2026-09-06）：已完成 —— 装备阶段收官。**
>
> **调试阶段进度（2026-09-07）：计划图 schema 升至 v2.3——演化式网络
> 构建（统一方法论落地）。** 所有者方向纠正：四象限不对立映射——四象限
> 是**未知密度谱**，Director 执行同一个演化循环不判象限（骨架先立 →
> 未知显式 → 发现驱动 → 持续演化；象限 1 转零轮、象限 4 转到认知收敛）。
> 格式优化三处（全部零 Runtime 改动）：① **占位节点 provisional 一等化**
> （intent 前缀 [pending] + E3/E4 + verifier 缺省合法——verifier 义务时点
> 从 created 修订为 started 前，Runtime 现状已支持）；② **演化操作词汇表**
> （refine/supersede/derive/retire 与 Runtime 原语一一对应 + 适用条件 +
> 反例——动态构建零新机制只有纪律）；③ **unknown 闭环规则**（每个 unknown
> 必须对应 discovery 节点或门控——未知不许悬空）。PLANNING 完成判据重
> 定义：已知范围内结构完整 + 占位显式（非"无占位"）。SKILL.md 常驻原则
> 增补第 8 条（网络是演化的）。
>
> **调试阶段进度（2026-09-07）：计划图 schema 升至 v2.2——复合 id +
> stage 封装。** 所有者设计定稿：nodes 物理封装于 stages 内（组织视图），
> **复合 id `{stage}-{step}-{serial}`** 身份内嵌位置（跨阶段引用自携带
> 来源、多会话协作人人可定位）；step = 阶段内批次软分组（step 间顺序仍
> 由 dependsOn 声明——依赖是唯一顺序约束）；serial = 节点序号（串行 1 /
> 并行 2,3,4）；parallelGroup 字段废弃（语义由 step/serial 承载）；
> stage.milestone 字段移除（翻译器以 stage.id 自动合成 milestone）；
> outcome 根级声明。mission 身份包与多态字段保留。网状展开不受封装限制
> （dependsOn 复合 id 引用可跨阶段）——"一个 stage 节点的产物是其他
> stage 的前置"正是复合 id 的设计理由。
>
> **调试阶段进度（2026-09-07）：计划图 schema 升级 v2——网状结构。**
> 依所有者修正："计划是网状的不是线性的"——三组概念各司其职：stages
> 阶段主干（串行监督视图，每阶段锚定 milestone）、nodes 工作网（dependsOn
> 任意连接、可跨阶段——依赖是唯一顺序约束）、parallelGroup 并行组（调度
> 提示不进 Runtime，同组无写冲突可同时派工）。翻译规则同步（stage→
> milestone 映射、outcome 无 stage、跨阶段依赖直接声明）+ 网状专项自查
> （阶段出口闭合/跨阶段方向/并行组内无依赖边）。双示例升级 v2 并过 JSON
> 校验。v1 的"并行组"概念回归（此前 v2 schema 遗漏）。
>
> **调试阶段进度（2026-09-06）：第 3 项 Director 教义（PLANNING 部分）完成，
> 并按所有者要求重构为渐进披露多文件架构**（SKILL.md 路由器 → planning.md
> 阶段路由器 → references/plan-graph-schema.md（格式化规范）+ references/
> plan-translation.md（机械翻译）+ examples/（minimal/DAG 兜底）——对齐
> v1 M-System 的隔离护栏与 token 纪律；计划图 schema 去编码化为通用型，
> kind 六性质路由键（engineering 只是六分之一）。**第 3 项 Director 教义（PLANNING 部分）完成。**
> 依据：v1 M-System 研读（M-Main 状态机/fingerprint strike/完成门禁、M-Plan
> 五不变量与两停止门禁、M-Code 失败路由、M-Review 四步流水线 + 评测实证
> "多 agent 制度防假完成"）× 用户三主张（决策总控/端到端一次性网络/
> 与 Runtime 机制结合）× 两决策（Director 全流程监督+executor 簇执行、
> criticality 硬拒暂缓——硬编码已完备）。产出：**SKILL.md 重组为阶段式
> 路由器**（入口过滤 Fast Path + PLANNING/SUPERVISING/RECOVERING/
> LEARNING 四阶段索引 + 常驻微原则七条）+ **planning.md**（规划前读取
> "现实先于设计" + **通用型计划图 schema**（dpn-plan-graph v2（网状）：去编码化
> ——kind 工作性质六分类为教义路由键，engineering 只是六分之一；字段与
> plan-node 参数面逐一对齐；v1 有效性规则继承：依赖无环/自顶向下/单一
> 职责/verifier 义务/unknown 显式/无空占位）+ 翻译规则（计划图→Runtime
> 声明序列的机械映射）+ 规划自查清单）。**分解判据留白**（颗粒度判据待
> 与所有者讨论）。executor 弱执行暂不配 skill。gate 全绿（195 项）。
>
> **调试阶段进度（2026-09-06）：第 2 项完成门禁强化已落地——装灯不装锁。**
> 设计哲学：结构性发癫已被现有门禁拦截；本次消灭幻觉式交卷的藏身之处。
> 三件事：① **完成档案 executionTrail**（active 窗口内黑匣子定格——零动作
> 交卷自证其伪）；② **完成分级 witnessed/attested**（attested 合法但
> planHealth 显形；PlanNode 新增 startedAt）；③ **Director 仪表盘**带出
> attestedDone 清单（trailCount 零值发光）。判定与处理归教义。飞行记录仪
> 配套修正：verify-run 移出黑匣子过滤列表（验证发生的核心执行证据）。
> E2E 双流验证（witnessed 流档案有定格 vs attested 零动作显形）+ 重启恢复。
> SCHEMA_VERSION 10。测试 completion-gate.test.ts（8 项）。gate 全绿
> （17 文件 195 项）。剩余：dogfooding → 教义填充 → 两级舰队。
>
> **调试阶段进度（2026-09-06）：第 1 项飞行记录仪已完成。** 新插件
> flight-recorder（自包含文件夹，L2 第二行注册）——宿主 event 流
> （message.part.updated 的 tool part，completed/error）防御式解析后自动
> dispatch action.executed（source=flight-recorder）：**黑匣子不是事实机**
> ——只记"发生过什么"不下结论，事实空间保持严格；过滤自有域工具防刷屏；
> 形状不对静默跳过（宿主细节版本敏感）。L2 首次双插件运行（事件扇出故障
> 隔离真实生效）。宿主实证：deepseek flash 只被要求跑 bash → 账本自动
> 出现 action.executed——"记账是自愿的"破局。测试 flight-recorder.test.ts
> （3 项：completed/error 采集、过滤、双插件扇出）。gate 全绿（16 文件
> 186 项）。剩余：完成门禁强化 → dogfooding → 教义填充 → 两级舰队。
>
> **调试预备项（2026-09-06 追加）：多会话并发写入已修复。** opencode 多
> 会话/多进程 = 多 runtime 实例（各自内存账本缓存）——seq 撞车导致后写
> 会话被制度锁死。修复三层：文件锁互斥（陈旧锁自动打破）+ 锁内乐观校验
> （磁盘为权威）+ dispatch 增量收敛（活性语义：每次工具调用自动同步，
> refresh() 显式全量）。读取路径改磁盘权威。真实宿主双会话验证通过
> （deepseek flash 并行 fact-record 双双落账、seq 连续）；附带验证证据
> 收窄制度在真实并发下的行为（违规被拒零污染、弱模型合规诊断）。
> 测试 concurrent-write.test.ts（先红后绿，4 项）。 四项交付：
> ① **AgentPlatform 接口诚实化**：8 个 NotImplemented 假占位全部移除，
> 接口对齐真实形态（capabilities / runtime / state / audit 四槽），让渡项
> （execution→openchamber、permissions→宿主权限键、agents→宿主 Registry、
> context→会话+shieldContract、models→调试阶段候选）写入接口文档；
> ② **Grand Tour 整合测试**（test/grand-tour.test.ts）：一个完整项目生命
> 的五幕单测故事（立 → 败与修 → 认知插曲 → 收官与学习 → 时间旅行），
> 全部走 15 工具的宿主视角——USER GOAL → Director → DPN → Solver →
> Evidence → Runtime State → Replan 全链一次性贯通，并验证重启恢复、
> asOf 点时间查询、经验沉淀；③ **宿主冒烟 v2**（deepseek v4 flash 弱模型
> 三轮系统性测试，用户指令"注重系统协调性与完整性而非模型不确定性"）：
> 轮 1 计划+验证门禁流——**指令漏 started 被制度拒绝（账本零污染），弱
> 模型准确诊断缺失步骤并拒绝擅自越权补做**，补正后 started→done 证据
> 正确关联；轮 2 研究循环五步全 ok（question→hypothesis→实验→belief
> 0.5→0.85→supported）；轮 3 memory 记录+recall（relatedExisting=0）。
> 账本 16 事件无断号、跨冒烟状态共享（Phase 2.5 事实仍可查）。**结论：
> 制度在弱模型压力下保持完整——宪法"弱模型喂纪律"得到实战验证**；
> ④ 文档收官（本块 + 架构.md 终态）。`npm run gate` 全绿（14 文件
> 174 项）。**按《初衷.md》交付策略，装备阶段结束，正式进入调试阶段**
> （入口清单：飞行记录仪 → 完成门禁 → dogfooding → 判断性教义填充 →
> 两级舰队实验）。

------------------------------------------------------------------------

# 方向修订（2026-09-05）

> **正本见《初衷.md》第四部分**（2026-09-06 起合并管理，本文仅保留指针）。
> 要点：① Fast Path 提前激活（利器化）；② 模型路由重新定位为"两级舰队"
> 候选；③ Phase 7 验证器 = 强弱模型共同地基；④ 每阶段交付后强制自问
> "什么时候跑第一次真活"。
>
> **交付策略（2026-09-06）**：先完成所有 Phase 再调试，不半途转移目标
> （半成品 → 逐步优化）。正本见《初衷.md》第二部分。

------------------------------------------------------------------------

# 实施优先级总结

  阶段                 能力跃迁
  -------------------- ----------------
  Event Runtime        拥有系统事实流
  World State          区分事实与认知
  Capability Gateway   建立安全边界
  DPN Model            计划结构化
  Solver Runtime       Agent工程化
  Director Loop        自主控制
  Verification         可信执行
  Memory               长期智能
  Recovery             鲁棒性
  Research             开放问题能力
  Sandbox              安全自治

------------------------------------------------------------------------

# 最重要原则

不要先构建更多 Agent。

先构建：

    Runtime
    State
    Capability
    Evidence
    Plan

Agent 只是运行在这个系统中的智能组件。

这才是从 Agent Demo 到 Autonomous Runtime 的跨越。
