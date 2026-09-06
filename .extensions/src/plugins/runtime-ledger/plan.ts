// runtime-ledger 私有模块：计划工具（plan-node / plan-query）。
// DPN 基础模型的事件映射层：节点生命周期、就绪度推导全部由 Runtime 强制，
// 本模块只做参数装配与结果格式化。
// 风险等级：low（只写 .extensions/state/ 下平台数据）。
import { z } from "zod"
import { nodeReadiness } from "../../runtime/reducer.ts"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"
import {
  DECLARED_EVIDENCE_TYPES,
  FAILURE_CLASSES,
  PLAN_NODE_TYPES,
  UNCERTAINTY_LEVELS,
} from "../../runtime/types.ts"

const NODE_ACTIONS = ["created", "updated", "started", "completed", "failed", "cancelled", "reopened"] as const

const nodeArgs = {
  action: z.enum(NODE_ACTIONS).describe("Lifecycle action on a plan node"),
  nodeId: z.string().min(1).describe("Node id, e.g. 't3'"),
  type: z.enum(PLAN_NODE_TYPES).optional().describe("created only: outcome | milestone | task | verification | recovery"),
  title: z.string().optional().describe("created/updated: what this node achieves"),
  intent: z.string().optional().describe("created/updated: why this node exists (decision context)"),
  parent: z.string().optional().describe("created only: container node (outcome → milestone → task)"),
  dependsOn: z.array(z.string()).optional().describe("Execution prerequisites: node ids that must be done first"),
  preconditionFacts: z
    .array(z.string())
    .optional()
    .describe("World-state gates: fact keys ('entity::property') that must be VERIFIED first"),
  verifier: z.string().optional().describe("created/updated: what would prove completion"),
  uncertainty: z.enum(UNCERTAINTY_LEVELS).optional().describe("E0 deterministic … E4 open discovery"),
  owner: z.string().optional().describe("created/updated/started: owning solver (defaults to caller)"),
  evidenceType: z
    .enum(DECLARED_EVIDENCE_TYPES)
    .optional()
    .describe("completed only: declared evidence (human/external); for test/tool_output use verify-run first"),
  evidenceId: z.string().optional().describe("completed only: cite an existing witnessed evidence (e.g. from verify-run)"),
  failureClass: z
    .enum(FAILURE_CLASSES)
    .optional()
    .describe("failed only: tool | environment | permission | logic | knowledge | goal"),
  supersedes: z.string().optional().describe("created only: failed node this replacement supersedes"),
  tests: z.string().optional().describe("created only: hypothesis id this experiment tests (research)"),
  reason: z.string().optional().describe("failed/reopened (required) / cancelled: why"),
  summary: z.string().optional().describe("completed: what was achieved"),
}
const nodeSchema = z.object(nodeArgs)
type NodeArgs = z.infer<typeof nodeSchema>

const queryArgs = {
  nodeId: z.string().optional().describe("Filter by exact node id"),
  status: z.enum(["pending", "active", "done", "failed", "cancelled"]).optional(),
  type: z.enum(PLAN_NODE_TYPES).optional(),
}
const querySchema = z.object(queryArgs)
type QueryArgs = z.infer<typeof querySchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

function defined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

export function buildPlanTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  return {
    "plan-node": {
      description:
        "Drive the dynamic plan network (DPN): declare outcome/milestone/task/verification/recovery nodes, " +
        "link execution prerequisites (dependsOn) and world-state gates (preconditionFacts), then start and " +
        "complete them. The runtime enforces readiness: a node starts only when all dependencies are done and " +
        "all precondition facts are VERIFIED, and agent_claim evidence can never complete a node.",
      args: nodeArgs,
      execute: async (rawArgs, port) => {
        const args: NodeArgs = nodeSchema.parse(rawArgs)
        const base: Record<string, unknown> = { nodeId: args.nodeId }
        let type: `plan.node.${(typeof NODE_ACTIONS)[number]}`
        let payload: Record<string, unknown>
        switch (args.action) {
          case "created":
            type = "plan.node.created"
            payload = {
              ...base,
              ...defined({
                type: args.type,
                title: args.title,
                intent: args.intent,
                parent: args.parent,
                dependsOn: args.dependsOn,
                preconditionFacts: args.preconditionFacts,
                verifier: args.verifier,
                uncertainty: args.uncertainty,
                owner: args.owner,
                supersedes: args.supersedes,
                tests: args.tests,
              }),
            }
            break
          case "updated":
            type = "plan.node.updated"
            payload = {
              ...base,
              ...defined({
                title: args.title,
                intent: args.intent,
                owner: args.owner,
                verifier: args.verifier,
                uncertainty: args.uncertainty,
                dependsOn: args.dependsOn,
                preconditionFacts: args.preconditionFacts,
              }),
            }
            break
          case "started":
            type = "plan.node.started"
            payload = { ...base, ...defined({ owner: args.owner }) }
            break
          case "completed": {
            if (args.evidenceId !== undefined) {
              type = "plan.node.completed"
              payload = { ...base, evidence: { evidenceId: args.evidenceId }, ...defined({ summary: args.summary }) }
              break
            }
            if (args.evidenceType === undefined) {
              return rejection("action 'completed' requires an evidenceType or an evidenceId (agent_claim is not accepted)")
            }
            type = "plan.node.completed"
            payload = { ...base, evidence: { type: args.evidenceType }, ...defined({ summary: args.summary }) }
            break
          }
          case "failed":
            if (args.reason === undefined) {
              return rejection("action 'failed' requires a reason")
            }
            type = "plan.node.failed"
            payload = { ...base, reason: args.reason, ...(args.failureClass !== undefined ? { failureClass: args.failureClass } : {}) }
            break
          case "reopened":
            if (args.reason === undefined) {
              return rejection("action 'reopened' requires a reason (what changed since the failure)")
            }
            type = "plan.node.reopened"
            payload = { ...base, reason: args.reason }
            break
          case "cancelled":
            type = "plan.node.cancelled"
            payload = { ...base, ...defined({ reason: args.reason }) }
            break
        }
        try {
          const event = await getRuntime().dispatch({ type, source: port.agent, payload })
          const node = getRuntime().getState().plan.nodes[args.nodeId]
          return jsonResult(`${args.nodeId} → ${node?.status ?? "?"}`, { ok: true, seq: event.seq, node })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "plan-query": {
      description:
        "Query the dynamic plan network: nodes with lifecycle status and derived readiness " +
        "(what still blocks each pending node — dependencies or unverified world facts).",
      args: queryArgs,
      execute: async (rawArgs) => {
        const args: QueryArgs = querySchema.parse(rawArgs)
        const state = getRuntime().getState()
        const nodes = Object.values(state.plan.nodes).filter(
          (n) =>
            (!args.nodeId || n.id === args.nodeId) &&
            (!args.status || n.status === args.status) &&
            (!args.type || n.type === args.type),
        )
        return jsonResult(`${nodes.length} node(s)`, {
          ok: true,
          revision: state.revision,
          nodes: nodes.map((n) => ({
            id: n.id,
            type: n.type,
            title: n.title,
            status: n.status,
            readiness: nodeReadiness(state, n),
            parent: n.parent,
            dependsOn: n.dependsOn,
            preconditionFacts: n.preconditionFacts,
            verifier: n.verifier,
            uncertainty: n.uncertainty,
            owner: n.owner,
            retryCount: n.retryCount,
            supersedes: n.supersedes,
            tests: n.tests,
            startedAt: n.startedAt,
            completionKind: n.completionKind,
            executionTrail: n.executionTrail,
            failureClass: n.failureClass,
            intent: n.intent,
            note: n.note,
            updatedAt: n.updatedAt,
          })),
        })
      },
    },
  }
}
