// runtime-ledger 私有模块：Solver 工具（solver-spawn / solver-report / solver-query）。
// Solver 是执行者的工牌（合同+履历）；本体在宿主侧，派工自动化归 Phase 6 Director。
// 本模块只做参数装配与结果格式化，规则全部由 Runtime 强制。
// 风险等级：low（只写 .extensions/state/ 下平台数据）。
import { z } from "zod"
import { nodeReadiness, solverContract } from "../../runtime/reducer.ts"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"
import { DECLARED_EVIDENCE_TYPES, FAILURE_CLASSES, SOLVER_STATUSES, type RuntimeState } from "../../runtime/types.ts"

const spawnArgs = {
  nodeId: z.string().min(1).describe("Plan node to claim (must be pending and ready)"),
  solverId: z.string().optional().describe("Contract id (auto-generated s<n> when omitted)"),
  executor: z.string().optional().describe("Host agent identity taking the contract (defaults to caller)"),
  role: z.string().optional().describe("Role label, e.g. 'backend-builder'"),
  brief: z.string().optional().describe("Short mission brief for the solver"),
  parentSolver: z.string().optional().describe("Supervising solver, for nested delegation"),
}
const spawnSchema = z.object(spawnArgs)
type SpawnArgs = z.infer<typeof spawnSchema>

const REPORT_ACTIONS = ["progress", "blocked", "resumed", "succeeded", "failed", "stopped"] as const

const reportArgs = {
  solverId: z.string().min(1).describe("Contract id (the solver speaking, or the supervisor stopping it)"),
  action: z.enum(REPORT_ACTIONS).describe("progress | blocked | resumed | succeeded | failed | stopped"),
  summary: z.string().optional().describe("progress/succeeded: what happened or was achieved"),
  detail: z.string().optional().describe("progress only: extra detail"),
  evidenceType: z
    .enum(DECLARED_EVIDENCE_TYPES)
    .optional()
    .describe("succeeded only: declared evidence (human/external); for test/tool_output use verify-run first"),
  evidenceId: z.string().optional().describe("succeeded only: cite an existing witnessed evidence (e.g. from verify-run)"),
  failureClass: z
    .enum(FAILURE_CLASSES)
    .optional()
    .describe("failed only: tool | environment | permission | logic | knowledge | goal"),
  reason: z.string().optional().describe("blocked/failed/stopped (required) or resumed note"),
}
const reportSchema = z.object(reportArgs)
type ReportArgs = z.infer<typeof reportSchema>

const queryArgs = {
  solverId: z.string().optional().describe("Filter by exact solver id"),
  status: z.enum(SOLVER_STATUSES).optional(),
}
const querySchema = z.object(queryArgs)
type QueryArgs = z.infer<typeof querySchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

// 自动编号在工具层基于当前状态生成（显式传入 reducer）——事件日志完全自描述
function nextSolverId(state: RuntimeState): string {
  let n = Object.keys(state.solvers).length + 1
  while (state.solvers[`s${n}`]) {
    n += 1
  }
  return `s${n}`
}

export function buildSolverTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  return {
    "solver-spawn": {
      description:
        "Hire a solver for a plan node (supervisor face): atomically claims the node — it must be pending " +
        "and ready (dependencies done, precondition facts VERIFIED) — and binds node.owner to the new solver id. " +
        "Max 4 active solvers.",
      args: spawnArgs,
      execute: async (rawArgs, port) => {
        const args: SpawnArgs = spawnSchema.parse(rawArgs)
        const solverId = args.solverId ?? nextSolverId(getRuntime().getState())
        try {
          const event = await getRuntime().dispatch({
            type: "solver.spawned",
            source: port.agent,
            payload: {
              nodeId: args.nodeId,
              solverId,
              ...(args.executor !== undefined ? { executor: args.executor } : {}),
              ...(args.role !== undefined ? { role: args.role } : {}),
              ...(args.brief !== undefined ? { brief: args.brief } : {}),
              ...(args.parentSolver !== undefined ? { parentSolver: args.parentSolver } : {}),
            },
          })
          const solver = getRuntime().getState().solvers[solverId]
          return jsonResult(`${solverId} hired for ${args.nodeId}`, { ok: true, seq: event.seq, solver })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "solver-report": {
      description:
        "Report as a solver (worker face): append progress, declare blocked/resumed, or deliver the final " +
        "verdict. Succeeding requires real evidence (agent_claim is rejected — executors cannot prove their " +
        "own success) and automatically completes the contracted node; failing fails it.",
      args: reportArgs,
      execute: async (rawArgs, port) => {
        const args: ReportArgs = reportSchema.parse(rawArgs)
        let type:
          | "solver.progress"
          | "solver.blocked"
          | "solver.resumed"
          | "solver.reported"
          | "solver.stopped"
        let payload: Record<string, unknown>
        switch (args.action) {
          case "progress":
            if (args.summary === undefined) {
              return rejection("action 'progress' requires a summary")
            }
            type = "solver.progress"
            payload = {
              solverId: args.solverId,
              summary: args.summary,
              ...(args.detail !== undefined ? { detail: args.detail } : {}),
            }
            break
          case "blocked":
            if (args.reason === undefined) {
              return rejection("action 'blocked' requires a reason")
            }
            type = "solver.blocked"
            payload = { solverId: args.solverId, reason: args.reason }
            break
          case "resumed":
            type = "solver.resumed"
            payload = {
              solverId: args.solverId,
              ...(args.reason !== undefined ? { note: args.reason } : {}),
            }
            break
          case "succeeded": {
            if (args.summary === undefined) {
              return rejection("action 'succeeded' requires a summary")
            }
            if (args.evidenceId === undefined && args.evidenceType === undefined) {
              return rejection("action 'succeeded' requires an evidenceType or an evidenceId (agent_claim is not accepted)")
            }
            type = "solver.reported"
            payload = {
              solverId: args.solverId,
              outcome: "success",
              summary: args.summary,
              evidence: args.evidenceId !== undefined ? { evidenceId: args.evidenceId } : { type: args.evidenceType },
            }
            break
          }
          case "failed":
            if (args.reason === undefined) {
              return rejection("action 'failed' requires a reason")
            }
            type = "solver.reported"
            payload = {
              solverId: args.solverId,
              outcome: "failure",
              summary: args.summary ?? args.reason,
              reason: args.reason,
              ...(args.failureClass !== undefined ? { failureClass: args.failureClass } : {}),
            }
            break
          case "stopped":
            if (args.reason === undefined) {
              return rejection("action 'stopped' requires a reason")
            }
            type = "solver.stopped"
            payload = { solverId: args.solverId, reason: args.reason }
            break
        }
        try {
          const event = await getRuntime().dispatch({ type, source: port.agent, payload })
          const solver = getRuntime().getState().solvers[args.solverId]
          return jsonResult(`${args.solverId} → ${solver?.status ?? "?"}`, { ok: true, seq: event.seq, solver })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "solver-query": {
      description:
        "Query solvers: contract (node + ancestors + prerequisite outputs + gate facts), progress trail and " +
        "derived readiness. Answers 'who is working on what, and who is stuck'.",
      args: queryArgs,
      execute: async (rawArgs) => {
        const args: QueryArgs = querySchema.parse(rawArgs)
        const state = getRuntime().getState()
        const matches = Object.values(state.solvers).filter(
          (s) => (!args.solverId || s.id === args.solverId) && (!args.status || s.status === args.status),
        )
        return jsonResult(`${matches.length} solver(s)`, {
          ok: true,
          revision: state.revision,
          solvers: matches.map((s) => {
            const contract = solverContract(state, s.id)
            return {
              ...s,
              contract: {
                node: {
                  id: contract.node.id,
                  title: contract.node.title,
                  status: contract.node.status,
                  readiness: nodeReadiness(state, contract.node),
                },
                ancestors: contract.ancestors.map((a) => ({ id: a.id, title: a.title })),
                prerequisiteOutputs: contract.prerequisiteOutputs.map((n) => ({ id: n.id, title: n.title, note: n.note })),
                gateFacts: contract.gateFacts.map((f) => ({ key: f.key, status: f.status, confidence: f.confidence })),
              },
            }
          }),
        })
      },
    },
  }
}
