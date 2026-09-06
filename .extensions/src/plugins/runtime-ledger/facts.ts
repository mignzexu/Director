// runtime-ledger 私有模块：事实工具（fact-record / fact-query）。
// 状态迁移与铁律由 Runtime 强制；本模块只做参数装配与结果格式化。
import { z } from "zod"
import type { ExtensionTool, ToolPort } from "../../plugins/types.ts"
import type { DpnRuntime } from "../../runtime/index.ts"
import { DECLARED_EVIDENCE_TYPES, type DeclaredEvidenceType } from "../../runtime/types.ts"

const FACT_ACTIONS = ["unknown", "observed", "verified", "invalidated", "staled"] as const


const recordArgs = {
  entity: z.string().min(1).describe("Fact subject, e.g. 'service/auth'"),
  property: z.string().min(1).describe("Fact property, e.g. 'build'"),
  action: z.enum(FACT_ACTIONS).describe("unknown | observed | verified | invalidated | staled"),
  value: z
    .union([z.string(), z.number(), z.boolean()])
    .optional()
    .describe("Fact value; required for observed/verified"),
  evidenceType: z
    .enum(DECLARED_EVIDENCE_TYPES)
    .optional()
    .describe(
      "Declared evidence kind (human / external / agent_claim); required for observed/verified/invalidated. " +
        "For test/tool_output evidence use the verify-run tool — declared ones are downgraded by the runtime.",
    ),
  note: z.string().optional().describe("Optional note, e.g. reason for invalidated/staled"),
}
const recordSchema = z.object(recordArgs)
type RecordArgs = z.infer<typeof recordSchema>

const queryArgs = {
  entity: z.string().optional().describe("Filter by entity (substring match)"),
  property: z.string().optional().describe("Filter by property (substring match)"),
}
const querySchema = z.object(queryArgs)
type QueryArgs = z.infer<typeof querySchema>

function jsonResult(title: string, body: unknown): { title: string; output: string } {
  return { title, output: JSON.stringify(body, null, 2) }
}

function rejection(message: string): { title: string; output: string } {
  return jsonResult("rejected", { ok: false, error: message })
}

export function buildFactTools(getRuntime: () => DpnRuntime): Record<string, ExtensionTool> {
  return {
    "fact-record": {
      description:
        "Record a fact about the world into the runtime ledger. Status transitions and evidence rules are " +
        "enforced by the runtime: agent_claim evidence can never make a fact VERIFIED (executors cannot " +
        "prove their own success) — use tool_output/test/human/external evidence, or have it independently verified.",
      args: recordArgs,
      execute: async (rawArgs, port) => {
        const args: RecordArgs = recordSchema.parse(rawArgs)
        const { entity, property, action, note } = args
        const base: Record<string, unknown> = { entity, property, ...(note !== undefined ? { note } : {}) }

        let type: "fact.unknown" | "fact.observed" | "fact.verified" | "fact.invalidated" | "fact.staled"
        let payload: Record<string, unknown>
        if (action === "unknown" || action === "staled") {
          type = action === "unknown" ? "fact.unknown" : "fact.staled"
          payload = base
        } else {
          if (args.value === undefined) {
            return rejection(`action '${action}' requires a value`)
          }
          if (args.evidenceType === undefined) {
            return rejection(`action '${action}' requires an evidenceType`)
          }
          type = action === "observed" ? "fact.observed" : action === "verified" ? "fact.verified" : "fact.invalidated"
          payload = { ...base, value: args.value, evidence: { type: args.evidenceType } }
        }

        try {
          const event = await getRuntime().dispatch({ type, source: port.agent, payload })
          const fact = getRuntime().getState().facts[`${entity}::${property}`]
          return jsonResult(`${entity}::${property} → ${fact?.status ?? "?"}`, {
            ok: true,
            seq: event.seq,
            fact,
          })
        } catch (error) {
          return rejection(error instanceof Error ? error.message : String(error))
        }
      },
    },
    "fact-query": {
      description: "Query the runtime world state: facts with status, confidence and supporting evidence.",
      args: queryArgs,
      execute: async (rawArgs) => {
        const args: QueryArgs = querySchema.parse(rawArgs)
        const state = getRuntime().getState()
        const facts = Object.values(state.facts).filter(
          (f) =>
            (!args.entity || f.entity.includes(args.entity)) &&
            (!args.property || f.property.includes(args.property)),
        )
        return jsonResult(`${facts.length} fact(s)`, {
          ok: true,
          revision: state.revision,
          facts: facts.map((f) => ({
            key: f.key,
            value: f.value,
            status: f.status,
            confidence: f.confidence,
            updatedAt: f.updatedAt,
            note: f.note,
            evidence: f.evidenceIds.flatMap((id) => {
              const e = state.evidence[id]
              return e ? [{ id: e.id, type: e.type, reliability: e.reliability, source: e.source, at: e.at }] : []
            }),
          })),
        })
      },
    },
  }
}
