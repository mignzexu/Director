// 纯归约器：(state, event) => state。无副作用、无 IO，输入不被修改。
// 未知事件类型 / 缺失 payload 字段 / seq 不连续 / 非法事实状态迁移一律 fail-loud，
// 与聚合器「配置错误必须响亮」的约定一致。
import {
  EVIDENCE_RELIABILITY,
  FAILURE_CLASSES,
  HYPOTHESIS_VERDICTS,
  LINEAGE_MECHANISMS,
  MAX_NODE_RETRIES,
  PLAN_NODE_TYPES,
  REFUTED_THRESHOLD,
  REVIEW_ASSESSMENTS,
  SCHEMA_VERSION,
  SUPPORTED_THRESHOLD,
  UNCERTAINTY_LEVELS,
  canVerify,
  isEvidenceType,
  isProducedEvidenceType,
  type DirectorReviewEntry,
  type EvidenceEntry,
  type EvidenceMechanism,
  type EvidenceType,
  type FailureClass,
  type FactEntry,
  type FactStatus,
  type FactValue,
  type HypothesisEntry,
  type LineageMechanism,
  type LessonEntry,
  type MemoryRecall,
  type MemoryRecallFilter,
  type NodeReadiness,
  type PlanHealth,
  type PlanNode,
  type PlanNodeType,
  type ReviewAssessment,
  type RuntimeEvent,
  type RuntimeState,
  type SolverContract,
  type SolverEntry,
  type SolverProgressEntry,
  type SolverStatus,
  type UncertaintyLevel,
  type QuestionEntry,
} from "./types.ts"

export const OBSERVED_CONFIDENCE_CAP = 0.6
export const STALE_CONFIDENCE_FACTOR = 0.5
// 活跃 solver 上限（平台方案 §25 建议值）——reducer 铁律，第 N+1 个 spawn 直接拒绝
export const MAX_ACTIVE_SOLVERS = 4

export function initialState(): RuntimeState {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: 0,
    goals: [],
    tasks: {},
    observations: [],
    actions: [],
    notes: [],
    facts: {},
    evidence: {},
    plan: { nodes: {}, reviews: [], churn: { created: 0, cancelled: 0 } },
    solvers: {},
    memory: { lessons: {} },
    research: { questions: {}, hypotheses: {} },
  }
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`event payload field '${field}' must be a non-empty string`)
  }
  return value
}

function optionalString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`event payload field '${field}' must be a non-empty string when present`)
  }
  return value
}

// ── 事实（Phase 2）──

// 置信度是 (status, 证据可靠度) 的纯函数：任何事实的 confidence 都可以由代码重算验证。
export function deriveConfidence(status: FactStatus, bestReliability: number): number {
  switch (status) {
    case "UNKNOWN":
    case "INVALID":
      return 0
    case "OBSERVED":
      return round2(Math.min(bestReliability, OBSERVED_CONFIDENCE_CAP))
    case "VERIFIED":
      return round2(bestReliability)
    case "STALE":
      return round2(bestReliability * STALE_CONFIDENCE_FACTOR)
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function requireFactKey(payload: Record<string, unknown>): { key: string; entity: string; property: string } {
  const entity = requireString(payload, "entity")
  const property = requireString(payload, "property")
  return { entity, property, key: `${entity}::${property}` }
}

// 事实取值只允许原始类型；复杂结构应拆成多个事实。"不知道"必须用 fact.unknown 显式声明。
function requireFactValue(payload: Record<string, unknown>, field: string): FactValue {
  const value = payload[field]
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new Error(`event payload field '${field}' must be a string, number or boolean (use fact.unknown for unknown values)`)
  }
  return value
}

function requireEvidence(
  state: RuntimeState,
  payload: Record<string, unknown>,
  event: RuntimeEvent,
): { id: string; entry: EvidenceEntry; referenced: boolean } {
  const raw = payload.evidence
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("event payload field 'evidence' must be an object")
  }
  const spec = raw as Record<string, unknown>

  // 引用已有证据（observed → verified 共享亲证凭证）
  const evidenceId = spec.evidenceId
  if (evidenceId !== undefined) {
    if (typeof evidenceId !== "string" || evidenceId.length === 0) {
      throw new Error("event payload field 'evidence.evidenceId' must be a non-empty string")
    }
    const existing = state.evidence[evidenceId]
    if (!existing) {
      throw new Error(`unknown evidence reference: ${evidenceId}`)
    }
    return { id: existing.id, entry: existing, referenced: true }
  }

  const type = spec.type
  if (typeof type !== "string" || !isEvidenceType(type)) {
    throw new Error(`evidence type must be one of: ${Object.keys(EVIDENCE_RELIABILITY).join(", ")}`)
  }

  // 制度裁定（Phase 7）：机器可复现类型（test/tool_output）必须由 verify-run
  // 亲证；申报的此类证据被裁定降级为 external（转述通道），指纹字段不可信、
  // 一律丢弃。裁定而非拒绝——历史事件重放同样适用本规则（与 dispatch 同构）。
  let effectiveType: EvidenceType = type
  let mechanism: EvidenceMechanism = "declared"
  if (isProducedEvidenceType(type)) {
    if (spec.mechanism === "verify-run") {
      if (typeof spec.command !== "string" || spec.command.length === 0) {
        throw new Error("verify-run evidence requires a command fingerprint")
      }
      mechanism = "verify-run"
    } else {
      effectiveType = "external"
      mechanism = "declared-downgraded"
    }
  }

  const id = `ev:${event.id}`
  const entry: EvidenceEntry = {
    id,
    type: effectiveType,
    reliability: EVIDENCE_RELIABILITY[effectiveType],
    source: event.source,
    at: event.timestamp,
    mechanism,
    ...(mechanism === "verify-run"
      ? {
          command: spec.command as string,
          ...(typeof spec.exitCode === "number" ? { exitCode: spec.exitCode } : {}),
          ...(spec.timedOut === true ? { timedOut: true } : {}),
          ...(typeof spec.outputTail === "string" && spec.outputTail.length > 0
            ? { outputTail: spec.outputTail }
            : {}),
        }
      : {}),
  }
  return { id, entry, referenced: false }
}

// ── run: 完成门禁（Phase 7）──
// verifier 以 "run: " 开头 = 机器可读的验证声明：完成（或交卷联动完成）时，
// 所挂证据必须是 mechanism="verify-run" 且 command 与声明一致的亲证。
const RUN_VERIFIER_PREFIX = "run: "

function requireVerifierSatisfied(node: PlanNode, evidence: EvidenceEntry): void {
  const verifier = node.verifier
  if (verifier === undefined || !verifier.startsWith(RUN_VERIFIER_PREFIX)) {
    return
  }
  const expected = verifier.slice(RUN_VERIFIER_PREFIX.length).trim()
  if (expected.length === 0) {
    throw new Error(`plan node '${node.id}' declares an empty run: verifier command`)
  }
  if (evidence.mechanism !== "verify-run" || evidence.command !== expected) {
    throw new Error(
      `plan node '${node.id}' verifier requires a verify-run execution of '${expected}' before completion (declared evidence does not satisfy it)`,
    )
  }
  if (evidence.exitCode !== 0) {
    throw new Error(
      `plan node '${node.id}' verifier run of '${expected}' did not pass (exit code ${evidence.exitCode ?? "unknown"}): a failing run cannot complete a node`,
    )
  }
}

// 完成档案（Phase 12 门禁强化）：active 窗口（startedAt → 完成时刻）内
// 黑匣子记录的宿主工具执行定格——零动作交卷在此自证其伪。
function executionTrailFor(state: RuntimeState, startedAt: string | undefined, until: string): { count: number; tools: string[] } {
  if (startedAt === undefined) {
    return { count: 0, tools: [] }
  }
  const toolCounts = new Map<string, number>()
  let count = 0
  for (const action of state.actions) {
    if (action.at >= startedAt && action.at <= until) {
      count += 1
      toolCounts.set(action.name, (toolCounts.get(action.name) ?? 0) + 1)
    }
  }
  const tools = [...toolCounts.entries()].map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
  return { count, tools }
}

// 完成分级（Phase 12）：亲证完成（witnessed）vs 声称完成（attested）——
// 由完成证据的机制推导，不拦截 attested（合法场景存在），但 planHealth 显形
function completionKindFor(evidence: EvidenceEntry): "witnessed" | "attested" {
  return evidence.mechanism === "verify-run" ? "witnessed" : "attested"
}

function bestReliability(state: RuntimeState, evidenceIds: readonly string[]): number {
  let best = 0
  for (const id of evidenceIds) {
    best = Math.max(best, state.evidence[id]?.reliability ?? 0)
  }
  return best
}

function withEvidence(state: RuntimeState, entry: EvidenceEntry): RuntimeState {
  return { ...state, evidence: { ...state.evidence, [entry.id]: entry } }
}

function withFact(state: RuntimeState, fact: FactEntry, evidence?: EvidenceEntry): RuntimeState {
  const next: RuntimeState = { ...state, facts: { ...state.facts, [fact.key]: fact } }
  return evidence ? withEvidence(next, evidence) : next
}

function withPlanNode(state: RuntimeState, node: PlanNode): RuntimeState {
  return { ...state, plan: { ...state.plan, nodes: { ...state.plan.nodes, [node.id]: node } } }
}

// 图翻新计数（churn）由 reducer 独占维护——不是申报值
function withChurn(state: RuntimeState, delta: { created?: number; cancelled?: number }): RuntimeState {
  return {
    ...state,
    plan: {
      ...state.plan,
      churn: {
        created: state.plan.churn.created + (delta.created ?? 0),
        cancelled: state.plan.churn.cancelled + (delta.cancelled ?? 0),
      },
    },
  }
}

function withSolver(state: RuntimeState, solver: SolverEntry): RuntimeState {
  return { ...state, solvers: { ...state.solvers, [solver.id]: solver } }
}

// 去掉值为 undefined 的键：保证内存态与 JSON 持久化形态一致（undefined 键不落盘）
function omitUndefined<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out as T
}

// ── 计划节点（Phase 4）──

// 就绪度是 (节点, 状态) 的纯函数：依赖全 done 且前提事实全 VERIFIED。
// 每次查询现算，避免存储的 ready 标志腐烂。
export function nodeReadiness(state: RuntimeState, node: PlanNode): NodeReadiness {
  const unmetDependencies = node.dependsOn.filter((id) => state.plan.nodes[id]?.status !== "done")
  const unmetFacts = node.preconditionFacts.filter((key) => state.facts[key]?.status !== "VERIFIED")
  return {
    ready: unmetDependencies.length === 0 && unmetFacts.length === 0,
    unmetDependencies,
    unmetFacts,
  }
}

function requireReady(state: RuntimeState, node: PlanNode): void {
  const readiness = nodeReadiness(state, node)
  if (readiness.ready) {
    return
  }
  const parts: string[] = []
  if (readiness.unmetDependencies.length > 0) {
    parts.push(`unmet dependencies: ${readiness.unmetDependencies.join(", ")}`)
  }
  if (readiness.unmetFacts.length > 0) {
    parts.push(`unmet facts: ${readiness.unmetFacts.join(", ")}`)
  }
  throw new Error(`node '${node.id}' is not ready (${parts.join("; ")})`)
}

function requirePlanNodeType(payload: Record<string, unknown>): PlanNodeType {
  const value = payload.type
  if (typeof value !== "string" || !(PLAN_NODE_TYPES as readonly string[]).includes(value)) {
    throw new Error(`event payload field 'type' must be one of: ${PLAN_NODE_TYPES.join(", ")}`)
  }
  return value as PlanNodeType
}

function optionalUncertainty(payload: Record<string, unknown>): UncertaintyLevel | undefined {
  const value = payload.uncertainty
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || !(UNCERTAINTY_LEVELS as readonly string[]).includes(value)) {
    throw new Error(`event payload field 'uncertainty' must be one of: ${UNCERTAINTY_LEVELS.join(", ")}`)
  }
  return value as UncertaintyLevel
}

// 失败分类（Phase 9）：可选声明，归类归智能、枚举校验归制度
function optionalFailureClass(payload: Record<string, unknown>): FailureClass | undefined {
  const value = payload.failureClass
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || !(FAILURE_CLASSES as readonly string[]).includes(value)) {
    throw new Error(`event payload field 'failureClass' must be one of: ${FAILURE_CLASSES.join(", ")}`)
  }
  return value as FailureClass
}

// 事实键格式：'entity::property'（不要求事实已存在——可以先立门控再补观测）
function parseFactKeys(payload: Record<string, unknown>, field: string): string[] {
  const raw = payload[field]
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new Error(`event payload field '${field}' must be an array of fact keys ('entity::property')`)
  }
  const keys: string[] = []
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new Error(`event payload field '${field}' must contain only strings`)
    }
    const sep = item.indexOf("::")
    if (sep <= 0 || sep === item.length - 2 || item.includes("::", sep + 2)) {
      throw new Error(`invalid fact key '${item}': expected 'entity::property'`)
    }
    if (!keys.includes(item)) {
      keys.push(item)
    }
  }
  return keys
}

// 执行前提必须已声明（自底向上声明执行依赖；父子包含关系用 parent，必须先声明父节点）
function parseDependencies(state: RuntimeState, payload: Record<string, unknown>, selfId: string): string[] {
  const raw = payload.dependsOn
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    throw new Error("event payload field 'dependsOn' must be an array of node ids")
  }
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("event payload field 'dependsOn' must contain only non-empty node ids")
    }
    if (item === selfId) {
      throw new Error(`node '${item}' cannot depend on itself`)
    }
    if (!state.plan.nodes[item]) {
      throw new Error(`unknown dependency node: ${item} (declare nodes before depending on them)`)
    }
    if (!ids.includes(item)) {
      ids.push(item)
    }
  }
  return ids
}

// 新增依赖只可能由 updated 引入（created 的依赖必须已存在且图无环），DFS 沿依赖边检查
function wouldCycle(state: RuntimeState, nodeId: string, dependsOn: readonly string[]): boolean {
  const stack = [...dependsOn]
  const seen = new Set<string>()
  while (stack.length > 0) {
    const id = stack.pop()!
    if (id === nodeId) {
      return true
    }
    if (seen.has(id)) {
      continue
    }
    seen.add(id)
    stack.push(...(state.plan.nodes[id]?.dependsOn ?? []))
  }
  return false
}

// ── Solver（Phase 5）──

function requireSolverIn(state: RuntimeState, payload: Record<string, unknown>, allowed: readonly SolverStatus[]): SolverEntry {
  const id = requireString(payload, "solverId")
  const solver = state.solvers[id]
  if (!solver) {
    throw new Error(`unknown solver: ${id}`)
  }
  if (!allowed.includes(solver.status)) {
    throw new Error(`not allowed in solver status ${solver.status}: ${id} (allowed: ${allowed.join(", ")})`)
  }
  return solver
}

function requireHeldBy(state: RuntimeState, solver: SolverEntry): PlanNode {
  const node = state.plan.nodes[solver.nodeId]
  if (!node || node.status !== "active" || node.owner !== solver.id) {
    throw new Error(`plan node '${solver.nodeId}' is no longer held by solver '${solver.id}'`)
  }
  return node
}

// Task Contract 推导：上下文从账本现算——合同节点、祖先链（为什么做）、
// 依赖产出（前面交了什么）、门控事实（世界现在什么样）。
export function solverContract(state: RuntimeState, solverId: string): SolverContract {
  const solver = state.solvers[solverId]
  if (!solver) {
    throw new Error(`unknown solver: ${solverId}`)
  }
  const node = state.plan.nodes[solver.nodeId]
  if (!node) {
    throw new Error(`contract node missing for solver '${solverId}': ${solver.nodeId}`)
  }
  const ancestors: PlanNode[] = []
  const seen = new Set<string>([node.id])
  let cursor = node.parent !== undefined ? state.plan.nodes[node.parent] : undefined
  while (cursor && !seen.has(cursor.id)) {
    ancestors.push(cursor)
    seen.add(cursor.id)
    cursor = cursor.parent !== undefined ? state.plan.nodes[cursor.parent] : undefined
  }
  return {
    solver,
    node,
    ancestors,
    prerequisiteOutputs: node.dependsOn
      .map((id) => state.plan.nodes[id])
      .filter((n): n is PlanNode => n !== undefined && n.status === "done"),
    gateFacts: node.preconditionFacts
      .map((key) => state.facts[key])
      .filter((f): f is FactEntry => f !== undefined),
  }
}

// ── Director（Phase 6）──

// 全局健康度：控制循环的"观察"步骤——全部由推导得出，不存储、不申报。
// 能算的是制度（本函数）；怎么判断是教义（Director 的 skill）。
export function planHealth(state: RuntimeState): PlanHealth {
  const nodes = Object.values(state.plan.nodes)
  const active = nodes.filter((n) => n.status !== "cancelled")
  const readyQueue: PlanNode[] = []
  const blockedNodes: { node: PlanNode; readiness: NodeReadiness }[] = []
  const activeWork: { node: PlanNode; owner: string }[] = []
  const failedNodes: PlanNode[] = []
  const unknownFactKeys = new Set<string>()
  for (const fact of Object.values(state.facts)) {
    if (fact.status !== "VERIFIED") {
      unknownFactKeys.add(fact.key)
    }
  }
  for (const node of active) {
    if (node.status === "pending") {
      const readiness = nodeReadiness(state, node)
      if (readiness.ready) {
        readyQueue.push(node)
      } else {
        blockedNodes.push({ node, readiness })
      }
    } else if (node.status === "active") {
      activeWork.push({ node, owner: node.owner ?? "?" })
    } else if (node.status === "failed") {
      failedNodes.push(node)
    }
    if (node.status !== "done") {
      for (const key of node.preconditionFacts) {
        if (state.facts[key]?.status !== "VERIFIED") {
          unknownFactKeys.add(key)
        }
      }
    }
  }
  const solvers = Object.values(state.solvers)
  const churn = state.plan.churn
  return {
    totalNodes: active.length,
    doneNodes: active.filter((n) => n.status === "done").length,
    completionRatio: active.length > 0 ? round2(active.filter((n) => n.status === "done").length / active.length) : 0,
    readyQueue,
    blockedNodes,
    activeWork,
    failedNodes,
    retryableFailures: failedNodes.filter((n) => (n.retryCount ?? 0) < MAX_NODE_RETRIES),
    exhaustedFailures: failedNodes.filter((n) => (n.retryCount ?? 0) >= MAX_NODE_RETRIES),
    witnessedDone: nodes.filter((n) => n.status === "done" && n.completionKind === "witnessed"),
    attestedDone: nodes.filter((n) => n.status === "done" && n.completionKind === "attested"),
    stuckSolvers: solvers.filter((s) => s.status === "blocked"),
    failedSolvers: solvers.filter((s) => s.status === "failed"),
    unknownFacts: [...unknownFactKeys],
    churn: { ...churn },
    churnRate: churn.created > 0 ? round2(churn.cancelled / churn.created) : null,
  }
}

// ── Memory（Phase 8）──

// 锚定校验：每条经验必须引用真账。锚点三形态：
//   "ev:<id>"    → evidenceId，必须已存在
//   "seq:<n>"    → 事件流水号，必须 ∈ [1, revision]（该事件必然存在）
//   其他字符串    → 计划节点 id，必须已存在
function resolveAnchors(state: RuntimeState, payload: Record<string, unknown>): string[] {
  const raw = payload.anchors
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("event payload field 'anchors' must be a non-empty array (lessons must be anchored to real ledger entries)")
  }
  const ids: string[] = []
  for (const item of raw) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error("event payload field 'anchors' must contain only non-empty strings")
    }
    if (item.startsWith("ev:")) {
      if (!state.evidence[item]) {
        throw new Error(`unknown evidence anchor: ${item}`)
      }
    } else if (item.startsWith("seq:")) {
      const n = Number(item.slice(4))
      if (!Number.isInteger(n) || n < 1 || n > state.revision) {
        throw new Error(`event seq anchor out of range: ${item} (ledger is at revision ${state.revision})`)
      }
    } else if (!state.plan.nodes[item]) {
      throw new Error(`unknown node anchor: ${item}`)
    }
    if (!ids.includes(item)) {
      ids.push(item)
    }
  }
  return ids
}

// 全景记忆视图：四类记忆的推导聚合（lessons 为唯一存储部分）。
export function memoryRecall(state: RuntimeState, filter: MemoryRecallFilter = {}): MemoryRecall {
  const include = filter.include ?? "all"
  const wantLessons = include === "all" || include === "lessons"
  const wantFailures = include === "all" || include === "failures"
  const wantDecisions = include === "all" || include === "decisions"
  const wantProblems = include === "all" || include === "problems"

  let lessons = Object.values(state.memory.lessons)
  if (filter.scope !== undefined) {
    lessons = lessons.filter((l) => l.scope === filter.scope)
  }
  if (filter.subject !== undefined) {
    lessons = lessons.filter((l) => l.subject === filter.subject)
  }
  if (!filter.showRetired) {
    lessons = lessons.filter((l) => !l.retired)
  }
  // 分组优先于时间：active 组内按更新时间降序，retired 组沉底（重排而非删除）
  const byRecency = (a: LessonEntry, b: LessonEntry): number => b.updatedAt.localeCompare(a.updatedAt)
  const active = lessons.filter((l) => !l.retired).sort(byRecency)
  const retiredList = lessons.filter((l) => l.retired).sort(byRecency)
  lessons = [...active, ...retiredList]

  const nodes = Object.values(state.plan.nodes)
  return {
    lessons: wantLessons ? lessons : [],
    failures: wantFailures
      ? {
          nodes: nodes
            .filter((n) => n.status === "failed")
            .map((n) => ({ id: n.id, note: n.note, updatedAt: n.updatedAt })),
          solvers: Object.values(state.solvers)
            .filter((s) => s.status === "failed")
            .map((s) => ({ id: s.id, nodeId: s.nodeId, note: s.note })),
        }
      : { nodes: [], solvers: [] },
    decisions: wantDecisions ? state.plan.reviews.slice(-10) : [],
    problems: wantProblems
      ? {
          goals: state.goals.map((g) => g.goal),
          outcomes: nodes
            .filter((n) => n.type === "outcome")
            .map((n) => ({ id: n.id, title: n.title, intent: n.intent, status: n.status })),
          unknownFacts: planHealth(state).unknownFacts,
        }
      : { goals: [], outcomes: [], unknownFacts: [] },
  }
}

// ── Research（Phase 10）──

// 认知全景：开放问题优先 + 假设树（信念/verdict/lineage）。
export function researchQuery(
  state: RuntimeState,
  filter: { subject?: string; questionId?: string } = {},
): { questions: QuestionEntry[]; hypotheses: HypothesisEntry[] } {
  let questions = Object.values(state.research.questions)
  if (filter.subject !== undefined) {
    questions = questions.filter((q) => q.subject === filter.subject)
  }
  questions = [...questions.filter((q) => !q.resolved), ...questions.filter((q) => q.resolved)]
  let hypotheses = Object.values(state.research.hypotheses)
  if (filter.questionId !== undefined) {
    hypotheses = hypotheses.filter((h) => h.questionId === filter.questionId)
  }
  if (filter.subject !== undefined) {
    const subjectIds = new Set(questions.map((q) => q.id))
    hypotheses = hypotheses.filter((h) => subjectIds.has(h.questionId))
  }
  return { questions, hypotheses }
}

export function reduce(state: RuntimeState, event: RuntimeEvent): RuntimeState {
  if (event.seq !== state.revision + 1) {
    throw new Error(`event seq ${event.seq} does not continue revision ${state.revision}`)
  }
  switch (event.type) {
    case "goal.set":
      return {
        ...state,
        revision: event.seq,
        goals: [
          ...state.goals,
          { goal: requireString(event.payload, "goal"), source: event.source, setAt: event.timestamp },
        ],
      }
    case "task.created": {
      const id = requireString(event.payload, "taskId")
      if (state.tasks[id]) {
        throw new Error(`task already exists: ${id}`)
      }
      const title = requireString(event.payload, "title")
      return {
        ...state,
        revision: event.seq,
        tasks: {
          ...state.tasks,
          [id]: {
            id,
            title,
            status: "open",
            source: event.source,
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
          },
        },
      }
    }
    case "task.updated": {
      const id = requireString(event.payload, "taskId")
      const existing = state.tasks[id]
      if (!existing) {
        throw new Error(`unknown task: ${id}`)
      }
      const status = requireString(event.payload, "status")
      if (status !== "open" && status !== "done" && status !== "cancelled") {
        throw new Error(`invalid task status: ${status}`)
      }
      return {
        ...state,
        revision: event.seq,
        tasks: { ...state.tasks, [id]: { ...existing, status, updatedAt: event.timestamp } },
      }
    }
    case "action.executed": {
      const outcome = event.payload.outcome
      return {
        ...state,
        revision: event.seq,
        actions: [
          ...state.actions,
          {
            name: requireString(event.payload, "name"),
            outcome: typeof outcome === "string" ? outcome : "",
            ok: event.payload.ok === true,
            source: event.source,
            at: event.timestamp,
          },
        ],
      }
    }
    case "observation.recorded":
      return {
        ...state,
        revision: event.seq,
        observations: [
          ...state.observations,
          { content: requireString(event.payload, "content"), source: event.source, at: event.timestamp },
        ],
      }
    case "note.added":
      return {
        ...state,
        revision: event.seq,
        notes: [
          ...state.notes,
          { content: requireString(event.payload, "content"), source: event.source, at: event.timestamp },
        ],
      }
    // ── Phase 2：World State & Evidence ──
    case "fact.unknown": {
      const { key, entity, property } = requireFactKey(event.payload)
      return withFact(
        { ...state, revision: event.seq },
        {
          key,
          entity,
          property,
          value: null,
          status: "UNKNOWN",
          confidence: 0,
          evidenceIds: [],
          updatedAt: event.timestamp,
          note: optionalString(event.payload, "note"),
        },
      )
    }
    case "fact.observed": {
      const { key, entity, property } = requireFactKey(event.payload)
      const value = requireFactValue(event.payload, "value")
      const { id, entry } = requireEvidence(state, event.payload, event)
      return withFact(
        { ...state, revision: event.seq },
        {
          key,
          entity,
          property,
          value,
          status: "OBSERVED",
          confidence: deriveConfidence("OBSERVED", entry.reliability),
          evidenceIds: [id],
          updatedAt: event.timestamp,
        },
        entry,
      )
    }
    case "fact.verified": {
      const { key } = requireFactKey(event.payload)
      const existing = state.facts[key]
      if (!existing) {
        throw new Error(`cannot verify unknown fact: ${key} (observe it first)`)
      }
      if (existing.status !== "OBSERVED" && existing.status !== "VERIFIED") {
        throw new Error(`cannot verify fact in status ${existing.status}: ${key} (fresh observation required)`)
      }
      const value = requireFactValue(event.payload, "value")
      if (value !== existing.value) {
        throw new Error(`verified value does not match observed value of ${key}; record a new observation first`)
      }
      const { id, entry } = requireEvidence(state, event.payload, event)
      if (!canVerify(entry.type)) {
        throw new Error(`evidence type '${entry.type}' cannot verify a fact: executors cannot prove their own success`)
      }
      return withFact(
        { ...state, revision: event.seq },
        {
          ...existing,
          status: "VERIFIED",
          confidence: deriveConfidence("VERIFIED", entry.reliability),
          evidenceIds: [id],
          updatedAt: event.timestamp,
        },
        entry,
      )
    }
    case "fact.invalidated": {
      const { key } = requireFactKey(event.payload)
      const existing = state.facts[key]
      if (!existing) {
        throw new Error(`cannot invalidate unknown fact: ${key}`)
      }
      if (existing.status === "UNKNOWN") {
        throw new Error(`cannot invalidate fact in status UNKNOWN: ${key} (nothing claimed to invalidate)`)
      }
      const { id, entry } = requireEvidence(state, event.payload, event)
      return withFact(
        { ...state, revision: event.seq },
        {
          ...existing,
          status: "INVALID",
          confidence: 0,
          evidenceIds: [id],
          updatedAt: event.timestamp,
          note: optionalString(event.payload, "note"),
        },
        entry,
      )
    }
    case "fact.staled": {
      const { key } = requireFactKey(event.payload)
      const existing = state.facts[key]
      if (!existing) {
        throw new Error(`cannot stale unknown fact: ${key}`)
      }
      if (existing.status === "UNKNOWN" || existing.status === "INVALID") {
        throw new Error(`cannot stale fact in status ${existing.status}: ${key}`)
      }
      return withFact(
        { ...state, revision: event.seq },
        {
          ...existing,
          status: "STALE",
          confidence: deriveConfidence("STALE", bestReliability(state, existing.evidenceIds)),
          updatedAt: event.timestamp,
          note: optionalString(event.payload, "note"),
        },
      )
    }
    // ── Phase 4：DPN 基础模型 ──
    case "plan.node.created": {
      const id = requireString(event.payload, "nodeId")
      if (state.plan.nodes[id]) {
        throw new Error(`plan node already exists: ${id}`)
      }
      const parent = event.payload.parent !== undefined ? requireString(event.payload, "parent") : undefined
      if (parent !== undefined && !state.plan.nodes[parent]) {
        throw new Error(`unknown parent node: ${parent} (declare container nodes first)`)
      }
      // 替代声明（Phase 9）：Subgraph Replan 的结构表达——新节点替代某个失败节点
      const supersedes = event.payload.supersedes !== undefined ? requireString(event.payload, "supersedes") : undefined
      if (supersedes !== undefined) {
        const target = state.plan.nodes[supersedes]
        if (!target) {
          throw new Error(`unknown supersedes target: ${supersedes}`)
        }
        if (target.status !== "failed") {
          throw new Error(`supersedes target must be a failed node: ${supersedes} is '${target.status}'`)
        }
      }
      // 实验声明（Phase 10）：本节点测哪个假设
      const tests = event.payload.tests !== undefined ? requireString(event.payload, "tests") : undefined
      if (tests !== undefined && !state.research.hypotheses[tests]) {
        throw new Error(`unknown tests hypothesis: ${tests}`)
      }
      return withChurn(
        withPlanNode(
          { ...state, revision: event.seq },
          omitUndefined({
            id,
            type: requirePlanNodeType(event.payload),
            title: requireString(event.payload, "title"),
            intent: optionalString(event.payload, "intent"),
            parent,
            dependsOn: parseDependencies(state, event.payload, id),
            preconditionFacts: parseFactKeys(event.payload, "preconditionFacts"),
            verifier: optionalString(event.payload, "verifier"),
            uncertainty: optionalUncertainty(event.payload),
            owner: optionalString(event.payload, "owner"),
            supersedes,
            tests,
            status: "pending" as const,
            evidenceIds: [] as string[],
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
          }),
        ),
        { created: 1 },
      )
    }
    case "plan.node.updated": {
      const id = requireString(event.payload, "nodeId")
      const existing = state.plan.nodes[id]
      if (!existing) {
        throw new Error(`unknown plan node: ${id}`)
      }
      if (existing.status !== "pending" && existing.status !== "active") {
        throw new Error(`cannot update plan node in status ${existing.status}: ${id}`)
      }
      if ("type" in event.payload) {
        throw new Error("plan node 'type' is immutable")
      }
      if ("status" in event.payload) {
        throw new Error("plan node status changes only through lifecycle events")
      }
      const dependsOn =
        event.payload.dependsOn !== undefined ? parseDependencies(state, event.payload, id) : existing.dependsOn
      if (wouldCycle(state, id, dependsOn)) {
        throw new Error(`updating dependencies of '${id}' would create a cycle`)
      }
      return withPlanNode(
        { ...state, revision: event.seq },
        omitUndefined({
          ...existing,
          title: event.payload.title !== undefined ? requireString(event.payload, "title") : existing.title,
          intent: event.payload.intent !== undefined ? requireString(event.payload, "intent") : existing.intent,
          owner: event.payload.owner !== undefined ? requireString(event.payload, "owner") : existing.owner,
          verifier: event.payload.verifier !== undefined ? requireString(event.payload, "verifier") : existing.verifier,
          uncertainty:
            event.payload.uncertainty !== undefined ? optionalUncertainty(event.payload) : existing.uncertainty,
          dependsOn,
          preconditionFacts:
            event.payload.preconditionFacts !== undefined
              ? parseFactKeys(event.payload, "preconditionFacts")
              : existing.preconditionFacts,
          note: event.payload.note !== undefined ? requireString(event.payload, "note") : existing.note,
          updatedAt: event.timestamp,
        }),
      )
    }
    case "plan.node.started": {
      const id = requireString(event.payload, "nodeId")
      const existing = state.plan.nodes[id]
      if (!existing) {
        throw new Error(`unknown plan node: ${id}`)
      }
      if (existing.status !== "pending") {
        throw new Error(`cannot start plan node in status ${existing.status}: ${id} (only pending nodes start)`)
      }
      requireReady(state, existing)
      return withPlanNode(
        { ...state, revision: event.seq },
        omitUndefined({
          ...existing,
          status: "active" as const,
          owner: event.payload.owner !== undefined ? requireString(event.payload, "owner") : event.source,
          startedAt: event.timestamp,
          updatedAt: event.timestamp,
        }),
      )
    }
    case "plan.node.completed": {
      const id = requireString(event.payload, "nodeId")
      const existing = state.plan.nodes[id]
      if (!existing) {
        throw new Error(`unknown plan node: ${id}`)
      }
      if (existing.status !== "active") {
        throw new Error(`cannot complete plan node in status ${existing.status}: ${id} (start it first)`)
      }
      const { id: evidenceId, entry } = requireEvidence(state, event.payload, event)
      if (!canVerify(entry.type)) {
        throw new Error(
          `evidence type '${entry.type}' cannot complete a plan node: executors cannot prove their own success`,
        )
      }
      requireVerifierSatisfied(existing, entry)
      return withEvidence(
        withPlanNode(
          { ...state, revision: event.seq },
          omitUndefined({
            ...existing,
            status: "done" as const,
            evidenceIds: [evidenceId],
            completionKind: completionKindFor(entry),
            executionTrail: executionTrailFor(state, existing.startedAt, event.timestamp),
            note: event.payload.summary !== undefined ? requireString(event.payload, "summary") : existing.note,
            updatedAt: event.timestamp,
          }),
        ),
        entry,
      )
    }
    case "plan.node.failed": {
      const id = requireString(event.payload, "nodeId")
      const existing = state.plan.nodes[id]
      if (!existing) {
        throw new Error(`unknown plan node: ${id}`)
      }
      if (existing.status !== "active") {
        throw new Error(`cannot fail plan node in status ${existing.status}: ${id} (only active nodes fail)`)
      }
      const reason = requireString(event.payload, "reason")
      const failureClass = optionalFailureClass(event.payload)
      return withPlanNode(
        { ...state, revision: event.seq },
        omitUndefined({
          ...existing,
          status: "failed" as const,
          note: reason,
          ...(failureClass !== undefined ? { failureClass } : {}),
          updatedAt: event.timestamp,
        }),
      )
    }
    case "plan.node.reopened": {
      const id = requireString(event.payload, "nodeId")
      const existing = state.plan.nodes[id]
      if (!existing) {
        throw new Error(`unknown plan node: ${id}`)
      }
      if (existing.status !== "failed") {
        throw new Error(`cannot reopen plan node in status ${existing.status}: ${id} (only failed nodes reopen)`)
      }
      const retryCount = (existing.retryCount ?? 0) + 1
      if (retryCount > MAX_NODE_RETRIES) {
        throw new Error(
          `node '${id}' exhausted ${MAX_NODE_RETRIES} retries: circuit breaker open — replan instead (cancel it and create a replacement with supersedes)`,
        )
      }
      const reason = requireString(event.payload, "reason")
      return withPlanNode(
        { ...state, revision: event.seq },
        omitUndefined({
          ...existing,
          status: "pending" as const,
          owner: undefined,
          retryCount,
          note: reason,
          updatedAt: event.timestamp,
        }),
      )
    }
    case "plan.node.cancelled": {
      const id = requireString(event.payload, "nodeId")
      const existing = state.plan.nodes[id]
      if (!existing) {
        throw new Error(`unknown plan node: ${id}`)
      }
      if (existing.status === "done") {
        throw new Error(`cannot cancel completed plan node: ${id}`)
      }
      return withChurn(
        withPlanNode(
          { ...state, revision: event.seq },
          omitUndefined({
            ...existing,
            status: "cancelled" as const,
            note: event.payload.reason !== undefined ? requireString(event.payload, "reason") : existing.note,
            updatedAt: event.timestamp,
          }),
        ),
        { cancelled: 1 },
      )
    }
    // ── Phase 5：Solver Runtime ──
    case "solver.spawned": {
      const nodeId = requireString(event.payload, "nodeId")
      const node = state.plan.nodes[nodeId]
      if (!node) {
        throw new Error(`unknown plan node: ${nodeId}`)
      }
      if (node.status !== "pending") {
        throw new Error(`cannot claim plan node in status ${node.status}: ${nodeId} (only pending nodes can be claimed)`)
      }
      requireReady(state, node)
      const activeCount = Object.values(state.solvers).filter((s) => s.status === "active").length
      if (activeCount >= MAX_ACTIVE_SOLVERS) {
        throw new Error(`active solver limit reached (${MAX_ACTIVE_SOLVERS})`)
      }
      // solverId 必须显式给出（自动编号在工具层基于状态生成）——事件日志完全自描述
      const id = requireString(event.payload, "solverId")
      if (state.solvers[id]) {
        throw new Error(`solver already exists: ${id}`)
      }
      const parentSolver =
        event.payload.parentSolver !== undefined ? requireString(event.payload, "parentSolver") : undefined
      if (parentSolver !== undefined && !state.solvers[parentSolver]) {
        throw new Error(`unknown parent solver: ${parentSolver}`)
      }
      const solver: SolverEntry = omitUndefined({
        id,
        nodeId,
        // 本体默认取派工者——自雇模式下二者相同
        executor: event.payload.executor !== undefined ? requireString(event.payload, "executor") : event.source,
        role: optionalString(event.payload, "role"),
        brief: optionalString(event.payload, "brief"),
        parentSolver,
        spawnedBy: event.source,
        status: "active" as const,
        progress: [] as SolverProgressEntry[],
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      })
      // 原子合同交接：节点 active + owner = solverId
      return withPlanNode(
        withSolver({ ...state, revision: event.seq }, solver),
        omitUndefined({ ...node, status: "active" as const, owner: id, updatedAt: event.timestamp }),
      )
    }
    case "solver.progress": {
      const solver = requireSolverIn(state, event.payload, ["active"])
      const summary = requireString(event.payload, "summary")
      const detail = optionalString(event.payload, "detail")
      return withSolver(
        { ...state, revision: event.seq },
        omitUndefined({
          ...solver,
          progress: [...solver.progress, omitUndefined({ at: event.timestamp, summary, detail })],
          note: summary,
          updatedAt: event.timestamp,
        }),
      )
    }
    case "solver.blocked": {
      const solver = requireSolverIn(state, event.payload, ["active"])
      const reason = requireString(event.payload, "reason")
      return withSolver(
        { ...state, revision: event.seq },
        omitUndefined({ ...solver, status: "blocked" as const, note: reason, updatedAt: event.timestamp }),
      )
    }
    case "solver.resumed": {
      const solver = requireSolverIn(state, event.payload, ["blocked"])
      return withSolver(
        { ...state, revision: event.seq },
        omitUndefined({
          ...solver,
          status: "active" as const,
          note: event.payload.note !== undefined ? requireString(event.payload, "note") : solver.note,
          updatedAt: event.timestamp,
        }),
      )
    }
    case "solver.reported": {
      const solver = requireSolverIn(state, event.payload, ["active"])
      const outcome = event.payload.outcome
      if (outcome !== "success" && outcome !== "failure") {
        throw new Error("event payload field 'outcome' must be 'success' or 'failure'")
      }
      const summary = requireString(event.payload, "summary")
      if (outcome === "failure") {
        const reason = requireString(event.payload, "reason")
        const node = requireHeldBy(state, solver)
        const failureClass = optionalFailureClass(event.payload)
        return withPlanNode(
          withSolver({ ...state, revision: event.seq }, omitUndefined({
            ...solver,
            status: "failed" as const,
            note: summary,
            updatedAt: event.timestamp,
          })),
          omitUndefined({
            ...node,
            status: "failed" as const,
            note: reason,
            ...(failureClass !== undefined ? { failureClass } : {}),
            updatedAt: event.timestamp,
          }),
        )
      }
      const { id: evidenceId, entry } = requireEvidence(state, event.payload, event)
      if (!canVerify(entry.type)) {
        throw new Error(
          `evidence type '${entry.type}' cannot close a solver contract: executors cannot prove their own success`,
        )
      }
      const node = requireHeldBy(state, solver)
      requireVerifierSatisfied(node, entry)
      return withEvidence(
        withPlanNode(
          withSolver(
            { ...state, revision: event.seq },
            omitUndefined({ ...solver, status: "finished" as const, note: summary, updatedAt: event.timestamp }),
          ),
          omitUndefined({
            ...node,
            status: "done" as const,
            evidenceIds: [evidenceId],
            completionKind: completionKindFor(entry),
            executionTrail: executionTrailFor(state, node.startedAt ?? node.createdAt, event.timestamp),
            note: summary,
            updatedAt: event.timestamp,
          }),
        ),
        entry,
      )
    }
    case "solver.stopped": {
      const solver = requireSolverIn(state, event.payload, ["active", "blocked"])
      const reason = requireString(event.payload, "reason")
      let next = withSolver(
        { ...state, revision: event.seq },
        omitUndefined({ ...solver, status: "stopped" as const, note: reason, updatedAt: event.timestamp }),
      )
      // 释放合同节点回 pending（清 owner）——换人重新认领无需特殊事件
      const node = state.plan.nodes[solver.nodeId]
      if (node && node.status === "active" && node.owner === solver.id) {
        next = withPlanNode(next, omitUndefined({ ...node, status: "pending" as const, owner: undefined, updatedAt: event.timestamp }))
      }
      return next
    }
    // ── Phase 6：Director 控制循环 ──
    case "director.reviewed": {
      const directorId = requireString(event.payload, "directorId")
      const director = state.solvers[directorId]
      if (!director) {
        throw new Error(`unknown director: ${directorId}`)
      }
      if (director.status !== "active") {
        throw new Error(`director '${directorId}' is not active (status: ${director.status})`)
      }
      const nodeId = requireString(event.payload, "nodeId")
      if (nodeId !== director.nodeId) {
        throw new Error(`review nodeId '${nodeId}' does not match the director's contract node '${director.nodeId}'`)
      }
      const node = state.plan.nodes[nodeId]
      if (!node) {
        throw new Error(`unknown plan node: ${nodeId}`)
      }
      if (node.type !== "outcome") {
        throw new Error(`director contract node must be an outcome node: ${nodeId} is '${node.type}'`)
      }
      const assessment = event.payload.assessment
      if (typeof assessment !== "string" || !(REVIEW_ASSESSMENTS as readonly string[]).includes(assessment)) {
        throw new Error(`event payload field 'assessment' must be one of: ${REVIEW_ASSESSMENTS.join(", ")}`)
      }
      const reasoning = requireString(event.payload, "reasoning")
      const nextActionsRaw = event.payload.nextActions
      const nextActions =
        nextActionsRaw === undefined
          ? undefined
          : (Array.isArray(nextActionsRaw) && nextActionsRaw.every((a) => typeof a === "string" && a.length > 0)
              ? (nextActionsRaw as string[])
              : undefined)
      if (nextActionsRaw !== undefined && nextActions === undefined) {
        throw new Error("event payload field 'nextActions' must be an array of non-empty strings")
      }
      const review: DirectorReviewEntry = omitUndefined({
        directorId,
        nodeId,
        assessment: assessment as ReviewAssessment,
        reasoning,
        nextActions,
        at: event.timestamp,
      })
      return { ...state, revision: event.seq, plan: { ...state.plan, reviews: [...state.plan.reviews, review] } }
    }
    // ── Phase 8：Memory 系统 ──
    case "memory.lesson.recorded": {
      const subject = requireString(event.payload, "subject")
      const lesson = requireString(event.payload, "lesson")
      const anchorIds = resolveAnchors(state, event.payload)
      const id = `ls:${event.id}`
      const scope = event.payload.scope !== undefined ? requireString(event.payload, "scope") : undefined
      const entry: LessonEntry = omitUndefined({
        id,
        subject,
        lesson,
        anchorIds,
        scope,
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      })
      return { ...state, revision: event.seq, memory: { lessons: { ...state.memory.lessons, [id]: entry } } }
    }
    case "memory.lesson.retired": {
      const lessonId = requireString(event.payload, "lessonId")
      const existing = state.memory.lessons[lessonId]
      if (!existing) {
        throw new Error(`unknown lesson: ${lessonId}`)
      }
      if (existing.retired) {
        throw new Error(`lesson already retired: ${lessonId}`)
      }
      const reason = requireString(event.payload, "reason")
      return {
        ...state,
        revision: event.seq,
        memory: {
          lessons: {
            ...state.memory.lessons,
            [lessonId]: { ...existing, retired: true, retireReason: reason, retiredAt: event.timestamp, updatedAt: event.timestamp },
          },
        },
      }
    }
    // ── Phase 10：Research Solver（认知对象层）──
    case "research.question.raised": {
      const question = requireString(event.payload, "question")
      const subject = optionalString(event.payload, "subject")
      const motivation = optionalString(event.payload, "motivation")
      const id = `q:${event.id}`
      const entry: QuestionEntry = omitUndefined({
        id,
        question,
        subject,
        motivation,
        createdAt: event.timestamp,
      })
      return {
        ...state,
        revision: event.seq,
        research: { ...state.research, questions: { ...state.research.questions, [id]: entry } },
      }
    }
    case "research.question.resolved": {
      const questionId = requireString(event.payload, "questionId")
      const existing = state.research.questions[questionId]
      if (!existing) {
        throw new Error(`unknown question: ${questionId}`)
      }
      if (existing.resolved) {
        throw new Error(`question already resolved: ${questionId}`)
      }
      const resolution = requireString(event.payload, "resolution")
      return {
        ...state,
        revision: event.seq,
        research: {
          ...state.research,
          questions: {
            ...state.research.questions,
            [questionId]: { ...existing, resolved: true, resolution, resolvedAt: event.timestamp },
          },
        },
      }
    }
    case "research.hypothesis.proposed": {
      const questionId = requireString(event.payload, "questionId")
      const question = state.research.questions[questionId]
      if (!question) {
        throw new Error(`unknown question: ${questionId}`)
      }
      if (question.resolved) {
        throw new Error(`question already resolved: ${questionId} (raise a new question for further inquiry)`)
      }
      const statement = requireString(event.payload, "statement")
      const belief = event.payload.prior
      if (typeof belief !== "number" || Number.isNaN(belief) || belief < 0 || belief > 1) {
        throw new Error("event payload field 'prior' must be a number in [0, 1]")
      }
      const rationale = requireString(event.payload, "rationale")
      const rawLineage = event.payload.lineage
      if (!rawLineage || typeof rawLineage !== "object" || Array.isArray(rawLineage)) {
        throw new Error("event payload field 'lineage' must be an object")
      }
      const mechanism = (rawLineage as Record<string, unknown>).mechanism
      if (typeof mechanism !== "string" || !(LINEAGE_MECHANISMS as readonly string[]).includes(mechanism)) {
        throw new Error(`lineage mechanism must be one of: ${LINEAGE_MECHANISMS.join(", ")}`)
      }
      const parentIdRaw = (rawLineage as Record<string, unknown>).parentId
      let parentId: string | undefined
      if (mechanism === "de-novo") {
        if (parentIdRaw !== undefined) {
          throw new Error("de-novo hypotheses have no parent")
        }
      } else {
        if (typeof parentIdRaw !== "string" || parentIdRaw.length === 0) {
          throw new Error(`lineage '${mechanism}' requires a parentId`)
        }
        const parent = state.research.hypotheses[parentIdRaw]
        if (!parent) {
          throw new Error(`unknown parent hypothesis: ${parentIdRaw}`)
        }
        // 防泡沫（HEP 规则）：未经检验的假设不能派生 refine 后代
        if (mechanism === "refine" && !parent.verdict && parent.evidenceIds.length === 0) {
          throw new Error(`cannot refine untested hypothesis '${parentIdRaw}': attach evidence or reach a verdict first`)
        }
        parentId = parentIdRaw
      }
      const id = `h:${event.id}`
      const entry: HypothesisEntry = omitUndefined({
        id,
        questionId,
        statement,
        belief,
        rationale,
        lineage: omitUndefined({ mechanism: mechanism as LineageMechanism, parentId }),
        evidenceIds: [] as string[],
        createdAt: event.timestamp,
        updatedAt: event.timestamp,
      })
      return {
        ...state,
        revision: event.seq,
        research: { ...state.research, hypotheses: { ...state.research.hypotheses, [id]: entry } },
      }
    }
    case "research.hypothesis.belief.updated": {
      const hypothesisId = requireString(event.payload, "hypothesisId")
      const existing = state.research.hypotheses[hypothesisId]
      if (!existing) {
        throw new Error(`unknown hypothesis: ${hypothesisId}`)
      }
      if (existing.verdict) {
        throw new Error(`hypothesis '${hypothesisId}' is frozen at verdict '${existing.verdict}' — refine it instead`)
      }
      const belief = event.payload.belief
      if (typeof belief !== "number" || Number.isNaN(belief) || belief < 0 || belief > 1) {
        throw new Error("event payload field 'belief' must be a number in [0, 1]")
      }
      const rationale = requireString(event.payload, "rationale")
      const evidenceId = requireString(event.payload, "evidenceId")
      if (!state.evidence[evidenceId]) {
        throw new Error(`unknown evidence reference: ${evidenceId} (belief moves only on real ledger evidence)`)
      }
      const evidenceIds = existing.evidenceIds.includes(evidenceId) ? existing.evidenceIds : [...existing.evidenceIds, evidenceId]
      return {
        ...state,
        revision: event.seq,
        research: {
          ...state.research,
          hypotheses: {
            ...state.research.hypotheses,
            [hypothesisId]: { ...existing, belief, rationale, evidenceIds, updatedAt: event.timestamp },
          },
        },
      }
    }
    case "research.hypothesis.evaluated": {
      const hypothesisId = requireString(event.payload, "hypothesisId")
      const existing = state.research.hypotheses[hypothesisId]
      if (!existing) {
        throw new Error(`unknown hypothesis: ${hypothesisId}`)
      }
      if (existing.verdict) {
        throw new Error(`hypothesis already evaluated: ${hypothesisId} (${existing.verdict})`)
      }
      const verdict = event.payload.verdict
      if (typeof verdict !== "string" || !(HYPOTHESIS_VERDICTS as readonly string[]).includes(verdict)) {
        throw new Error(`event payload field 'verdict' must be one of: ${HYPOTHESIS_VERDICTS.join(", ")}`)
      }
      const reasoning = requireString(event.payload, "reasoning")
      const evidenceId = requireString(event.payload, "evidenceId")
      if (!state.evidence[evidenceId]) {
        throw new Error(`unknown evidence reference: ${evidenceId}`)
      }
      // verdict 是阈值制度转换，不是宣称
      if (verdict === "supported" && existing.belief < SUPPORTED_THRESHOLD) {
        throw new Error(
          `cannot support hypothesis '${hypothesisId}': belief ${existing.belief} < ${SUPPORTED_THRESHOLD} (update belief with evidence first)`,
        )
      }
      if (verdict === "refuted" && existing.belief > REFUTED_THRESHOLD) {
        throw new Error(
          `cannot refute hypothesis '${hypothesisId}': belief ${existing.belief} > ${REFUTED_THRESHOLD} (update belief with evidence first)`,
        )
      }
      const evidenceIds = existing.evidenceIds.includes(evidenceId) ? existing.evidenceIds : [...existing.evidenceIds, evidenceId]
      return {
        ...state,
        revision: event.seq,
        research: {
          ...state.research,
          hypotheses: {
            ...state.research.hypotheses,
            [hypothesisId]: {
              ...existing,
              verdict: verdict as HypothesisEntry["verdict"],
              verdictReasoning: reasoning,
              evidenceIds,
              updatedAt: event.timestamp,
            },
          },
        },
      }
    }
    default: {
      const exhaustive: never = event.type
      throw new Error(`unknown runtime event type: ${String(exhaustive)}`)
    }
  }
}

export function replay(events: readonly RuntimeEvent[]): RuntimeState {
  return events.reduce(reduce, initialState())
}
