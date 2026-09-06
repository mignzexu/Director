// runtime-ledger 私有模块：研究工具（research-question / research-hypothesis / research-query）。
// 认知对象层（蓝图 §2 Epistemic State）：Question/Hypothesis 与 World State 分离
// （Fact ≠ Hypothesis）。信念引出而非计算；verdict 是阈值制度转换；
// 信念移动必须引用真账证据（validation gate）。实验 = 计划节点 + verify-run。
// 风险等级：low（只写 .extensions/state/ 下平台数据）。
import { z } from "zod"
import { researchQuery } from "../../runtime/reducer.ts"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"
import { HYPOTHESIS_VERDICTS, LINEAGE_MECHANISMS } from "../../runtime/types.ts"

const questionArgs = {
  action: z.enum(["raised", "resolved"]).describe("raised: open a question; resolved: close it with a resolution"),
  question: z.string().optional().describe("raised only: the open question"),
  subject: z.string().optional().describe("raised only: theme label"),
  motivation: z.string().optional().describe("raised only: why this question matters now"),
  questionId: z.string().optional().describe("resolved only: the question to close"),
  resolution: z.string().optional().describe("resolved only: the answer reached (required)"),
}
const questionSchema = z.object(questionArgs)
type QuestionArgs = z.infer<typeof questionSchema>

const hypothesisArgs = {
  action: z.enum(["proposed", "updated", "evaluated"]).describe("proposed: new hypothesis; updated: belief move; evaluated: verdict"),
  questionId: z.string().optional().describe("proposed only: the open question this hypothesis answers"),
  statement: z.string().optional().describe("proposed only: the hypothesis (with a testable prediction)"),
  prior: z.number().min(0).max(1).optional().describe("proposed only: stated prior belief P(H) with rationale"),
  rationale: z.string().optional().describe("required: why you hold this belief / move"),
  mechanism: z.enum(LINEAGE_MECHANISMS).default("de-novo").describe("proposed only: de-novo | inspired-by | refine"),
  parentId: z.string().optional().describe("proposed only: parent hypothesis for inspired-by/refine"),
  hypothesisId: z.string().optional().describe("updated/evaluated only: the hypothesis to act on"),
  belief: z.number().min(0).max(1).optional().describe("updated only: restated P(H) after evidence"),
  evidenceId: z
    .string()
    .optional()
    .describe("updated/evaluated only: the ledger evidence that justifies the move (validation gate)"),
  verdict: z.enum(HYPOTHESIS_VERDICTS).optional().describe("evaluated only: supported (≥0.8) | refuted (≤0.2) | dormant"),
  reasoning: z.string().optional().describe("evaluated only: the verdict reasoning (required)"),
}
const hypothesisSchema = z.object(hypothesisArgs)
type HypothesisArgs = z.infer<typeof hypothesisSchema>

const queryArgs = {
  subject: z.string().optional().describe("Filter by question subject"),
  questionId: z.string().optional().describe("Filter hypotheses by question"),
  include: z.enum(["questions", "hypotheses", "all"]).default("all"),
}
const querySchema = z.object(queryArgs)
type QueryArgs = z.infer<typeof querySchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

export function buildResearchTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  return {
    "research-question": {
      description:
        "Raise or resolve an epistemic question (the Question half of Epistemic State). Questions make the " +
        "system's unknowns actionable: raise one when an UNKNOWN blocks progress, resolve it when the answer " +
        "is anchored (usually after a hypothesis reaches a verdict or a fact is VERIFIED).",
      args: questionArgs,
      execute: async (rawArgs, port) => {
        const args: QuestionArgs = questionSchema.parse(rawArgs)
        try {
          if (args.action === "raised") {
            if (args.question === undefined) {
              return rejection("action 'raised' requires a question")
            }
            const event = await getRuntime().dispatch({
              type: "research.question.raised",
              source: port.agent,
              payload: {
                question: args.question,
                ...(args.subject !== undefined ? { subject: args.subject } : {}),
                ...(args.motivation !== undefined ? { motivation: args.motivation } : {}),
              },
            })
            const question = getRuntime().getState().research.questions[`q:${event.id}`]
            return jsonResult(`question raised: ${question?.id}`, { ok: true, seq: event.seq, question })
          }
          if (args.questionId === undefined || args.resolution === undefined) {
            return rejection("action 'resolved' requires questionId and resolution")
          }
          const event = await getRuntime().dispatch({
            type: "research.question.resolved",
            source: port.agent,
            payload: { questionId: args.questionId, resolution: args.resolution },
          })
          const question = getRuntime().getState().research.questions[args.questionId]
          return jsonResult(`question resolved: ${args.questionId}`, { ok: true, seq: event.seq, question })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "research-hypothesis": {
      description:
        "Drive the hypothesis lifecycle: propose (prior + rationale + lineage), update belief (must cite the " +
        "ledger evidence that moved it — validation gate), or evaluate to a verdict. Verdicts are threshold " +
        "transitions enforced by the runtime: supported requires belief ≥ 0.8, refuted ≤ 0.2, dormant needs " +
        "a reason. Terminal verdicts freeze the hypothesis — refine it to keep inquiry going.",
      args: hypothesisArgs,
      execute: async (rawArgs, port) => {
        const args: HypothesisArgs = hypothesisSchema.parse(rawArgs)
        try {
          if (args.action === "proposed") {
            if (
              args.questionId === undefined ||
              args.statement === undefined ||
              args.prior === undefined ||
              args.rationale === undefined
            ) {
              return rejection("action 'proposed' requires questionId, statement, prior and rationale")
            }
            const event = await getRuntime().dispatch({
              type: "research.hypothesis.proposed",
              source: port.agent,
              payload: {
                questionId: args.questionId,
                statement: args.statement,
                prior: args.prior,
                rationale: args.rationale,
                lineage: {
                  mechanism: args.mechanism,
                  ...(args.parentId !== undefined ? { parentId: args.parentId } : {}),
                },
              },
            })
            const hypothesis = getRuntime().getState().research.hypotheses[`h:${event.id}`]
            return jsonResult(`hypothesis proposed: ${hypothesis?.id}`, { ok: true, seq: event.seq, hypothesis })
          }
          if (args.action === "updated") {
            if (args.hypothesisId === undefined || args.belief === undefined || args.rationale === undefined || args.evidenceId === undefined) {
              return rejection("action 'updated' requires hypothesisId, belief, rationale and evidenceId")
            }
            const event = await getRuntime().dispatch({
              type: "research.hypothesis.belief.updated",
              source: port.agent,
              payload: {
                hypothesisId: args.hypothesisId,
                belief: args.belief,
                rationale: args.rationale,
                evidenceId: args.evidenceId,
              },
            })
            const hypothesis = getRuntime().getState().research.hypotheses[args.hypothesisId]
            return jsonResult(`belief → ${hypothesis?.belief}`, { ok: true, seq: event.seq, hypothesis })
          }
          if (args.hypothesisId === undefined || args.verdict === undefined || args.reasoning === undefined || args.evidenceId === undefined) {
            return rejection("action 'evaluated' requires hypothesisId, verdict, reasoning and evidenceId")
          }
          const event = await getRuntime().dispatch({
            type: "research.hypothesis.evaluated",
            source: port.agent,
            payload: {
              hypothesisId: args.hypothesisId,
              verdict: args.verdict,
              reasoning: args.reasoning,
              evidenceId: args.evidenceId,
            },
          })
          const hypothesis = getRuntime().getState().research.hypotheses[args.hypothesisId]
          return jsonResult(`verdict: ${hypothesis?.verdict}`, { ok: true, seq: event.seq, hypothesis })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "research-query": {
      description:
        "Query the epistemic state: open questions (open first, resolved after) and the hypothesis tree " +
        "(belief, verdict, lineage). Answers 'what do we not know, and what do we currently believe about it'.",
      args: queryArgs,
      execute: async (rawArgs) => {
        const args: QueryArgs = querySchema.parse(rawArgs)
        const state = getRuntime().getState()
        const filter = {
          ...(args.subject !== undefined ? { subject: args.subject } : {}),
          ...(args.questionId !== undefined ? { questionId: args.questionId } : {}),
        }
        const view = researchQuery(state, filter)
        return jsonResult(
          `${view.questions.filter((q) => !q.resolved).length} open / ${view.questions.length} question(s) · ${view.hypotheses.length} hypothesis(es)`,
          { ok: true, revision: state.revision, ...view },
        )
      },
    },
  }
}
