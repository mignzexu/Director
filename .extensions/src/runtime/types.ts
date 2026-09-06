// DPN-AOR Phase 1 — Event Runtime 契约。
// 事件日志是权威事实源；RuntimeState 永远是归约事件的结果，
// 任何组件不得绕过事件直接修改状态。

export const RUNTIME_EVENT_TYPES = [
  "goal.set",
  "task.created",
  "task.updated",
  "action.executed",
  "observation.recorded",
  "note.added",
  // Phase 2 —— World State & Evidence
  "fact.unknown",
  "fact.observed",
  "fact.verified",
  "fact.invalidated",
  "fact.staled",
  // Phase 4 —— DPN 基础模型
  "plan.node.created",
  "plan.node.updated",
  "plan.node.started",
  "plan.node.completed",
  "plan.node.failed",
  "plan.node.cancelled",
  // Phase 5 —— Solver Runtime
  "solver.spawned",
  "solver.progress",
  "solver.blocked",
  "solver.resumed",
  "solver.reported",
  "solver.stopped",
  // Phase 6 —— Director 控制循环
  "director.reviewed",
  // Phase 8 —— Memory 系统
  "memory.lesson.recorded",
  "memory.lesson.retired",
  // Phase 9 —— Failure Recovery
  "plan.node.reopened",
  // Phase 10 —— Research Solver
  "research.question.raised",
  "research.question.resolved",
  "research.hypothesis.proposed",
  "research.hypothesis.belief.updated",
  "research.hypothesis.evaluated",
] as const

export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number]

export function isRuntimeEventType(value: string): value is RuntimeEventType {
  return (RUNTIME_EVENT_TYPES as readonly string[]).includes(value)
}

// ── Phase 2：World State & Evidence ──
// Fact ≠ Agent 的口头声称：事实状态与置信度均由 reducer 依代码规则推导，
// agent 只能提交事件与选择证据类型，不能自报可靠度或置信度。

export const SCHEMA_VERSION = 10

// ── Phase 10：Research Solver（认知对象层）──
// Epistemic State 的落地：Question/Hypothesis 与 World State 分离
// （Fact ≠ Hypothesis）。信念是引出而非计算（智能侧自报 + rationale），
// verdict 是阈值制度转换（supported ≥ 0.8、refuted ≤ 0.2）。
// 实验 = 计划节点（可选 tests 声明）+ verify-run 亲证，不建新对象。

export const SUPPORTED_THRESHOLD = 0.8
export const REFUTED_THRESHOLD = 0.2

export const HYPOTHESIS_VERDICTS = ["supported", "refuted", "dormant"] as const
export type HypothesisVerdict = (typeof HYPOTHESIS_VERDICTS)[number]

export const LINEAGE_MECHANISMS = ["de-novo", "inspired-by", "refine"] as const
export type LineageMechanism = (typeof LINEAGE_MECHANISMS)[number]

// ── Phase 9：Failure Recovery ──
// 分层恢复（Local Repair → Subgraph Replan → Global Replan → Reframe）中，
// Runtime 只管四个数据面：重启（reopened）、重试上限（circuit breaker）、
// 失败分类（枚举校验）、替代链（supersedes）；Replan/Reframe 是现有图操作
// 序列，失败清理配方（stop → invalidate → cancel）归教义。

// 失败分类（路线图六类）——归类是智能判断，枚举校验是制度
export const FAILURE_CLASSES = ["tool", "environment", "permission", "logic", "knowledge", "goal"] as const
export type FailureClass = (typeof FAILURE_CLASSES)[number]

// circuit breaker：同一节点重试上限（Temporal max attempts 启发）。
// 超限后拒绝 reopen，恢复路径升级为 Subgraph Replan。
export const MAX_NODE_RETRIES = 3

export const FACT_STATUSES = ["UNKNOWN", "OBSERVED", "VERIFIED", "STALE", "INVALID"] as const
export type FactStatus = (typeof FACT_STATUSES)[number]

// 证据类型 → 可靠度对照表（代码定死；agent 只能选类型，不能自报分数）
export const EVIDENCE_RELIABILITY = {
  human: 1.0,
  test: 0.9,
  external: 0.8,
  tool_output: 0.7,
  agent_claim: 0.3,
} as const

export type EvidenceType = keyof typeof EVIDENCE_RELIABILITY

// Object.hasOwn 而非 in：避免原型链键（toString 等）被误判为证据类型
export function isEvidenceType(value: string): value is EvidenceType {
  return Object.hasOwn(EVIDENCE_RELIABILITY, value)
}

// 铁律：agent_claim 不是验证 —— 执行者不能证明自己成功
export function canVerify(type: EvidenceType): boolean {
  return type !== "agent_claim"
}

export type FactValue = string | number | boolean

// 证据机制（Phase 7：证据从申报制到产出制）
// - verify-run：系统亲证（verify-run 工具真实执行命令后自动落账）
// - declared：申报制（human / external 等转述通道）
// - declared-downgraded：申报的 test/tool_output 被制度裁定降级为 external
export type EvidenceMechanism = "verify-run" | "declared" | "declared-downgraded"

// 机器可复现的证据类型：只能由 verify-run 产出，申报一律被制度降级
export const PRODUCED_EVIDENCE_TYPES = ["test", "tool_output"] as const

// 认知对象（Phase 10）
export interface QuestionEntry {
  id: string // 确定性派生：`q:${event.id}`
  question: string
  subject?: string
  motivation?: string
  resolved?: boolean
  resolution?: string
  resolvedAt?: string
  createdAt: string
}

export interface HypothesisLineage {
  mechanism: LineageMechanism
  // refine/inspired-by 的父假设
  parentId?: string
}

export interface HypothesisEntry {
  id: string // 确定性派生：`h:${event.id}`
  questionId: string
  statement: string
  // 信念：引出而非计算（智能侧自报，制度侧保管与阈值校验）
  belief: number
  rationale: string
  lineage: HypothesisLineage
  verdict?: HypothesisVerdict
  verdictReasoning?: string
  // 触发信念移动与 verdict 的证据（validation gate 的留痕）
  evidenceIds: string[]
  createdAt: string
  updatedAt: string
}

// 申报制证据类型（转述通道）：human / external / agent_claim
export const DECLARED_EVIDENCE_TYPES = ["human", "external", "agent_claim"] as const
export type DeclaredEvidenceType = (typeof DECLARED_EVIDENCE_TYPES)[number]

export function isProducedEvidenceType(type: EvidenceType): boolean {
  return (PRODUCED_EVIDENCE_TYPES as readonly string[]).includes(type)
}

export interface EvidenceEntry {
  id: string // 确定性派生：`ev:${event.id}`，非 agent 可控
  type: EvidenceType
  reliability: number // 查 EVIDENCE_RELIABILITY 表得出（裁定后可能变化）
  source: string // 记账方（事件 source）
  at: string
  // Phase 7 机制标记：缺失视为 declared（历史事件重放时按裁定规则降级）
  mechanism?: EvidenceMechanism
  // verify-run 亲证指纹
  command?: string
  exitCode?: number
  timedOut?: boolean
  outputTail?: string
}

export interface FactEntry {
  key: string // `${entity}::${property}`
  entity: string
  property: string
  value: FactValue | null // UNKNOWN 时为 null
  status: FactStatus
  confidence: number // reducer 从 status+证据推导，非申报值
  evidenceIds: string[] // 支撑当前状态/取值的证据；历史证据永久保留在 state.evidence
  updatedAt: string
  note?: string
}

// id / seq / timestamp 由 EventStore 在 append 时分配，调用方不提供。
export interface RuntimeEventInput {
  type: RuntimeEventType
  source: string
  payload?: Record<string, unknown>
}

export interface RuntimeEvent {
  id: string
  seq: number
  type: RuntimeEventType
  source: string
  payload: Record<string, unknown>
  timestamp: string
}

export interface GoalEntry {
  goal: string
  source: string
  setAt: string
}

export interface TaskEntry {
  id: string
  title: string
  status: "open" | "done" | "cancelled"
  source: string
  createdAt: string
  updatedAt: string
}

export interface ObservationEntry {
  content: string
  source: string
  at: string
}

export interface ActionEntry {
  name: string
  outcome: string
  ok: boolean
  source: string
  at: string
}

export interface NoteEntry {
  content: string
  source: string
  at: string
}

export interface RuntimeState {
  // 状态结构版本；快照与它不一致时视为缓存未命中，触发事件日志全量重放
  schemaVersion: number
  // 已应用的最后一个事件的 seq；0 = 空状态
  revision: number
  goals: GoalEntry[]
  tasks: Record<string, TaskEntry>
  observations: ObservationEntry[]
  actions: ActionEntry[]
  notes: NoteEntry[]
  facts: Record<string, FactEntry>
  evidence: Record<string, EvidenceEntry>
  plan: PlanState
  solvers: Record<string, SolverEntry>
  memory: { lessons: Record<string, LessonEntry> }
  research: { questions: Record<string, QuestionEntry>; hypotheses: Record<string, HypothesisEntry> }
}

// ── Phase 4：DPN 基础模型 ──
// 计划是 Runtime 对象：节点图通过事件演化，就绪度由代码在查询时推导
// （依赖全 done 且前提事实全 VERIFIED），铁律同样适用——执行者不能证明
// 自己完成（agent_claim 证据不能完成节点）。

export const PLAN_NODE_TYPES = ["outcome", "milestone", "task", "verification", "recovery"] as const
export type PlanNodeType = (typeof PLAN_NODE_TYPES)[number]

export const PLAN_NODE_STATUSES = ["pending", "active", "done", "failed", "cancelled"] as const
export type PlanNodeStatus = (typeof PLAN_NODE_STATUSES)[number]

export const UNCERTAINTY_LEVELS = ["E0", "E1", "E2", "E3", "E4"] as const
export type UncertaintyLevel = (typeof UNCERTAINTY_LEVELS)[number]

// ── Phase 6：Director 控制循环（制度层）──
// Runtime 只提供三样：观察数据（planHealth 推导）、决策留痕（reviewed 事件）、
// 合同纪律（Director 就是一个认领 outcome 的 solver，role="director"）。
// "计划好不好、要不要 reframe"的判断全部外置给 Director 的教义（skill）。

export const REVIEW_ASSESSMENTS = ["on-track", "needs-replan", "needs-reframe"] as const
export type ReviewAssessment = (typeof REVIEW_ASSESSMENTS)[number]

export interface DirectorReviewEntry {
  directorId: string
  nodeId: string // outcome 节点（director 的合同）
  assessment: ReviewAssessment
  reasoning: string
  nextActions?: string[]
  at: string
}

export interface PlanChurn {
  created: number
  cancelled: number
}

export interface PlanState {
  nodes: Record<string, PlanNode>
  // Director 决策档案（追加只读）：每次控制循环的结论与说理
  reviews: DirectorReviewEntry[]
  // 图翻新计数：created/cancelled 累计——churn 过高是问题模型可能错误的信号
  churn: PlanChurn
}

// planHealth 的返回：控制循环一次节拍的全部观察数据（纯推导，无存储）
export interface PlanHealth {
  totalNodes: number // 排除 cancelled
  doneNodes: number
  completionRatio: number
  readyQueue: PlanNode[] // pending 且就绪——可立即派工
  blockedNodes: { node: PlanNode; readiness: NodeReadiness }[] // pending 未就绪 + 缺口
  activeWork: { node: PlanNode; owner: string }[] // 进行中 + 认领者
  failedNodes: PlanNode[]
  // Phase 9：circuit breaker 区分——还能重试的失败 vs 重试耗尽（须 Replan）
  retryableFailures: PlanNode[]
  exhaustedFailures: PlanNode[]
  // Phase 12 门禁强化：完成分级——亲证完成 vs 声称完成（发癫显形，不拦截）
  witnessedDone: PlanNode[]
  attestedDone: PlanNode[]
  stuckSolvers: SolverEntry[] // blocked 的执行者
  failedSolvers: SolverEntry[]
  unknownFacts: string[] // 知识边界：所有非 VERIFIED 的事实键（含未观测的）
  churn: PlanChurn
  churnRate: number | null // cancelled/created；无节点时 null
}

export interface PlanNode {
  id: string
  type: PlanNodeType
  title: string
  // 为什么存在这个节点（决策上下文；Plan Ownership 的认知锚点）
  intent?: string
  // 归属容器（必须已存在）：outcome → milestone → task 的分解层次（子图）
  parent?: string
  // 执行前提（必须已存在）：这些节点全部 done 后本节点才可能就绪
  dependsOn: string[]
  // 世界状态门控：这些事实键（entity::property）全部 VERIFIED 后才可能就绪
  preconditionFacts: string[]
  // 凭什么算完的声明（Phase 7 Verification 的挂钩）
  verifier?: string
  // 蓝图 §15 不确定性等级（E0 确定 → E4 开放探索；当前仅声明，逻辑归 Director）
  uncertainty?: UncertaintyLevel
  // 认领者（plan.node.started 时默认取事件 source；Phase 5 Solver 的挂钩）
  owner?: string
  status: PlanNodeStatus
  // 完成时挂的支撑证据（ev:${event.id}，登记于 state.evidence）
  evidenceIds: string[]
  // Phase 9：失败分类（失败事件的可选声明；归类归智能，枚举校验归制度）
  failureClass?: FailureClass
  // Phase 9：重试计数（plan.node.reopened 累加；达 MAX_NODE_RETRIES 后拒绝再开）
  retryCount?: number
  // Phase 9：替代声明——本节点替代哪个失败节点（Subgraph Replan 的结构表达）
  supersedes?: string
  // Phase 10：实验节点声明测哪个假设（认知层与计划层的关联）
  tests?: string
  // Phase 12 门禁强化：开工时刻（完成窗口起点；完成时定格执行档案用）
  startedAt?: string
  // Phase 12：完成分级——witnessed（亲证完成）| attested（声称完成）。
  // attested 合法存在（文档类/人审类任务），但在 planHealth 中显形供智能判定
  completionKind?: "witnessed" | "attested"
  // Phase 12：完成时刻的执行定格——active 窗口内黑匣子记录的宿主工具执行
  // 统计（count=0 的 attested 完成即"零动作交卷"，自动在 Director 视野显形）
  executionTrail?: { count: number; tools: string[] }
  createdAt: string
  updatedAt: string
  note?: string
}

// 就绪度是 (节点, 状态) 的纯函数，每次查询现算——避免存储的 ready 标志腐烂
export interface NodeReadiness {
  ready: boolean
  unmetDependencies: string[]
  unmetFacts: string[]
}

// ── Phase 5：Solver Runtime ──
// Solver 是执行者的工牌（合同+履历），不是本体：智能/人格/工具在宿主侧。
// 三层分工：本体（宿主 agent）← Solver 对象（本文件）← Director（Phase 6 派工）。

export const SOLVER_STATUSES = ["active", "blocked", "finished", "failed", "stopped"] as const
export type SolverStatus = (typeof SOLVER_STATUSES)[number]

export interface SolverProgressEntry {
  at: string
  summary: string
  detail?: string
}

export interface SolverEntry {
  id: string
  // 合同：负责的计划节点
  nodeId: string
  // 本体声明：哪个宿主 agent 承诺来干（与 solverId 合同号分离；当前自报，身份缺口见路线图 Phase 5 记录）
  executor: string
  role?: string
  brief?: string
  parentSolver?: string
  // 派工者（spawn 事件 source）
  spawnedBy: string
  status: SolverStatus
  // 局部记忆：执行履历（progress 逐条追加，账本可追溯）
  progress: SolverProgressEntry[]
  // 最近一条关键信息（progress 摘要 / blocked 原因 / 交卷结论）
  note?: string
  createdAt: string
  updatedAt: string
}

// Task Contract 是推导视图：合同节点 + 祖先链（为什么做）+ 依赖产出（前面交了什么）
// + 门控事实（世界现在什么样）——上下文从账本算出，不是存储的 prompt。
export interface SolverContract {
  solver: SolverEntry
  node: PlanNode
  ancestors: PlanNode[]
  prerequisiteOutputs: PlanNode[]
  gateFacts: FactEntry[]
}

// ── Phase 8：Memory 系统（经验卡片）──
// 四类记忆三类是推导视图（Execution=账本 / Decision=reviews / Failure=failed
// 聚合 / Problem=goals+intents+未知），唯一的新存储原语是 lesson——泛化经验。
// 锚定强制：每条 lesson 必须引用真账（evidenceId / 节点 id / 事件 seq），
// 把 Phase 7 的产出制哲学延伸到记忆——经验不许编造。

export interface LessonEntry {
  id: string // 确定性派生：`ls:${event.id}`
  subject: string // 经验主题（如 "verify-runs" / "db-migrations"）
  lesson: string // 泛化经验本身
  anchorIds: string[] // 锚点：ev:* / 节点 id / "seq:N"
  scope?: string // 作用域留位（跨项目记忆第一版不做）
  retired?: boolean
  retireReason?: string
  retiredAt?: string
  createdAt: string
  updatedAt: string
}

export interface MemoryRecallFilter {
  scope?: string
  subject?: string
  include?: "lessons" | "failures" | "decisions" | "problems" | "all"
  showRetired?: boolean
}

// 全景记忆视图：四类记忆的推导聚合。lessons 是唯一存储部分，
// 其余三类从账本推导（Execution=账本本身不在此列）。
export interface MemoryRecall {
  lessons: LessonEntry[]
  failures: {
    nodes: { id: string; note?: string; updatedAt: string }[]
    solvers: { id: string; nodeId: string; note?: string }[]
  }
  decisions: DirectorReviewEntry[]
  problems: {
    goals: string[]
    outcomes: { id: string; title: string; intent?: string; status: PlanNodeStatus }[]
    unknownFacts: string[]
  }
}
