// runtime-ledger 私有模块：记忆工具（memory-record / memory-recall）。
// 四类记忆三类是推导视图，lesson 是唯一存储原语；锚定强制由 Runtime 校验。
// asOf 时间点查询（Zep 双时态启发）用账本重放实现——事件溯源免费获得。
// 风险等级：low（只写 .extensions/state/ 下平台数据）。
import { z } from "zod"
import { memoryRecall, replay } from "../../runtime/reducer.ts"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"

const recordArgs = {
  action: z.enum(["recorded", "retired"]).describe("recorded: anchor a new lesson; retired: retire an existing one"),
  subject: z.string().optional().describe("recorded only: lesson theme, e.g. 'verify-runs'"),
  lesson: z.string().optional().describe("recorded only: the generalized lesson itself"),
  anchors: z
    .array(z.string())
    .optional()
    .describe(
      "recorded only: ledger anchors (evidenceId 'ev:...', node id, or 'seq:<n>') — required, lessons must be anchored to real ledger entries",
    ),
  scope: z.string().optional().describe("recorded only: optional scope label"),
  lessonId: z.string().optional().describe("retired only: the lesson to retire"),
  reason: z.string().optional().describe("retired only: why it is being retired (required)"),
}
const recordSchema = z.object(recordArgs)
type RecordArgs = z.infer<typeof recordSchema>

const recallArgs = {
  scope: z.string().optional().describe("Filter lessons by scope"),
  subject: z.string().optional().describe("Filter lessons by subject"),
  include: z.enum(["lessons", "failures", "decisions", "problems", "all"]).default("all"),
  showRetired: z.boolean().default(false).describe("Include retired lessons (they are re-ranked, never deleted)"),
  asOf: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Point-in-time recall: reconstruct memory as of this ledger seq (replay-based)"),
}
const recallSchema = z.object(recallArgs)
type RecallArgs = z.infer<typeof recallSchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

export function buildMemoryTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  return {
    "memory-record": {
      description:
        "Record a generalized lesson into long-term memory, anchored to real ledger entries (evidence / nodes / " +
        "event seqs — fabrication is rejected by the runtime), or retire a lesson that practice has disproven " +
        "(retired lessons are re-ranked out of recall, never deleted).",
      args: recordArgs,
      execute: async (rawArgs, port) => {
        const args: RecordArgs = recordSchema.parse(rawArgs)
        try {
          if (args.action === "recorded") {
            if (args.subject === undefined || args.lesson === undefined || args.anchors === undefined) {
              return rejection("action 'recorded' requires subject, lesson and anchors")
            }
            // 写前提示（Mem0 启发）：同主题未退休的已有经验，交给 agent 显式决定
            // 是补充还是退休旧的——合并判断属智能侧，制度只提供可见性
            const relatedExisting = Object.values(getRuntime().getState().memory.lessons).filter(
              (l) => !l.retired && l.subject === args.subject,
            )
            const event = await getRuntime().dispatch({
              type: "memory.lesson.recorded",
              source: port.agent,
              payload: {
                subject: args.subject,
                lesson: args.lesson,
                anchors: args.anchors,
                ...(args.scope !== undefined ? { scope: args.scope } : {}),
              },
            })
            const lesson = getRuntime().getState().memory.lessons[`ls:${event.id}`]
            return jsonResult(`lesson anchored (${args.anchors.length} anchor(s))`, {
              ok: true,
              seq: event.seq,
              lesson,
              relatedExisting: relatedExisting.map((l) => ({ id: l.id, subject: l.subject, lesson: l.lesson })),
            })
          }
          if (args.lessonId === undefined || args.reason === undefined) {
            return rejection("action 'retired' requires lessonId and reason")
          }
          const event = await getRuntime().dispatch({
            type: "memory.lesson.retired",
            source: port.agent,
            payload: { lessonId: args.lessonId, reason: args.reason },
          })
          const lesson = getRuntime().getState().memory.lessons[args.lessonId]
          return jsonResult(`${args.lessonId} retired`, { ok: true, seq: event.seq, lesson })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "memory-recall": {
      description:
        "Recall the four memory views: lessons (generalized experience), failures (failed nodes/solvers with " +
        "reasons), decisions (recent director reviews), problems (goals + outcomes + known unknowns). " +
        "asOf reconstructs the memory as of an earlier ledger seq (point-in-time recall).",
      args: recallArgs,
      execute: async (rawArgs) => {
        const args: RecallArgs = recallSchema.parse(rawArgs)
        let state = getRuntime().getState()
        const asOf = args.asOf
        if (asOf !== undefined) {
          if (asOf > state.revision) {
            return rejection(`asOf seq ${asOf} is beyond the current revision ${state.revision}`)
          }
          state = replay((await getRuntime().events.readAll()).filter((e) => e.seq <= asOf))
        }
        const filter = {
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          include: args.include,
          showRetired: args.showRetired,
        }
        const view = memoryRecall(state, filter)
        return jsonResult(
          `${view.lessons.length} lesson(s) · ${view.failures.nodes.length + view.failures.solvers.length} failure(s)`,
          {
            ok: true,
            revision: state.revision,
            ...(args.asOf !== undefined ? { asOf: args.asOf } : {}),
            ...view,
          },
        )
      },
    },
  }
}
