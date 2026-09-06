// runtime-ledger 私有模块：Director 工具（director-tick / director-review）。
// Director 是认领 outcome 节点的 solver（role="director"）——不建新对象。
// 制度边界：tick 是纯观察（零事件），review 只强制"结论必须留痕+说理"；
// "计划好不好、要不要 reframe"的判断全部外置给 Director 的教义（skill）。
// 风险等级：low（只写 .extensions/state/ 下平台数据）。
import { z } from "zod"
import { planHealth } from "../../runtime/reducer.ts"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"
import { REVIEW_ASSESSMENTS } from "../../runtime/types.ts"

const tickArgs = {
  directorId: z.string().min(1).describe("The director's solver id (must hold an outcome node)"),
}
const tickSchema = z.object(tickArgs)
type TickArgs = z.infer<typeof tickSchema>

const reviewArgs = {
  directorId: z.string().min(1).describe("The director's solver id"),
  assessment: z.enum(REVIEW_ASSESSMENTS).describe("on-track | needs-replan | needs-reframe"),
  reasoning: z.string().min(1).describe("Why this assessment — required (decisions must leave a trace)"),
  nextActions: z.array(z.string().min(1)).optional().describe("Concrete next actions decided by this review"),
}
const reviewSchema = z.object(reviewArgs)
type ReviewArgs = z.infer<typeof reviewSchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

export function buildDirectorTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  return {
    "director-tick": {
      description:
        "One control-loop tick (pure observation, no events written): returns plan health — completion ratio, " +
        "ready queue (dispatchable now), blocked nodes with precise gaps, active work, stuck solvers, failures, " +
        "unknown facts and plan churn. Deciding what to do with this data is the director's doctrine (skill), " +
        "not this tool's job. Action through plan-node / solver-spawn / fact-record / director-review.",
      args: tickArgs,
      execute: async (rawArgs, port) => {
        const args: TickArgs = tickSchema.parse(rawArgs)
        const state = getRuntime().getState()
        const director = state.solvers[args.directorId]
        if (!director || director.status !== "active") {
          return rejection(`unknown or inactive director: ${args.directorId} (spawn a solver on the outcome node first)`)
        }
        const health = planHealth(state)
        return jsonResult(`health ${health.doneNodes}/${health.totalNodes} · ready ${health.readyQueue.length}`, {
          ok: true,
          tickedBy: port.agent,
          director: { id: director.id, node: director.nodeId },
          health: {
            ...health,
            readyQueue: health.readyQueue.map((n) => ({ id: n.id, type: n.type, title: n.title, parent: n.parent })),
            blockedNodes: health.blockedNodes.map(({ node, readiness }) => ({
              id: node.id,
              title: node.title,
              unmetDependencies: readiness.unmetDependencies,
              unmetFacts: readiness.unmetFacts,
            })),
            activeWork: health.activeWork.map(({ node, owner }) => ({ id: node.id, title: node.title, owner })),
            failedNodes: health.failedNodes.map((n) => ({ id: n.id, note: n.note })),
            attestedDone: health.attestedDone.map((n) => ({
              id: n.id,
              trailCount: n.executionTrail?.count ?? 0,
              note: n.note,
            })),
            witnessedDoneCount: health.witnessedDone.length,
            stuckSolvers: health.stuckSolvers.map((s) => ({ id: s.id, node: s.nodeId, note: s.note })),
            failedSolvers: health.failedSolvers.map((s) => ({ id: s.id, node: s.nodeId, note: s.note })),
          },
          recentReviews: state.plan.reviews.slice(-5),
        })
      },
    },
    "director-review": {
      description:
        "Record a control-loop verdict into the ledger (auditable decision archive): assessment + mandatory " +
        "reasoning + optional next actions. The runtime enforces that the verdict leaves a trace; it does not " +
        "judge whether the verdict is right — that is doctrine (skill) territory.",
      args: reviewArgs,
      execute: async (rawArgs, port) => {
        const args: ReviewArgs = reviewSchema.parse(rawArgs)
        const director = getRuntime().getState().solvers[args.directorId]
        if (!director) {
          return rejection(`unknown director: ${args.directorId}`)
        }
        try {
          const event = await getRuntime().dispatch({
            type: "director.reviewed",
            source: port.agent,
            payload: {
              directorId: args.directorId,
              nodeId: director.nodeId,
              assessment: args.assessment,
              reasoning: args.reasoning,
              ...(args.nextActions !== undefined ? { nextActions: args.nextActions } : {}),
            },
          })
          const reviews = getRuntime().getState().plan.reviews
          return jsonResult(`review #${reviews.length}: ${args.assessment}`, {
            ok: true,
            seq: event.seq,
            review: reviews.at(-1),
          })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
  }
}
