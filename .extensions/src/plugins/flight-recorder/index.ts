// flight-recorder —— 飞行记录仪（调试阶段第 1 项）：宿主工具执行的自动黑匣子。
//
// 定位：只记录"发生过什么"（action.executed，Phase 1 账目），不下"这意味
// 着什么"的结论——事实空间保持严格（fact 必须锚定真凭实据），执行历史从
// 此自动完整（"记账是自愿的"从此破局一半）。
//
// 数据源：宿主 event 流（L1 → L2 扇出）的 message.part.updated——
// part.type === "tool" 且 state.status ∈ {completed, error}。
// 防御式解析：事件形状是宿主 SDK 细节、版本敏感——任何形状不对一律静默
// 跳过（最坏采集不到，绝不破坏账本；聚合器故障隔离兜底）。
// 过滤：runtime-ledger 账本记录类工具（fact-/plan-/solver-/director-/
// memory-/research- 前缀）不记录——避免账本刷自己的屏。verify-run 保留：
// 它是验证发生的核心执行证据，且频率低不刷屏。
// 风险等级：low（只写 .extensions/state/ 下平台数据）。
import type { ExtensionPlugin, ExtensionPluginEvent } from "../types.ts"
import { createRuntime, type DpnRuntime } from "../../runtime/index.ts"

// runtime-ledger 自有工具前缀（避免黑匣子刷自己的屏）
const OWN_TOOL_PREFIXES = [
  "fact-",
  "plan-",
  "solver-",
  "director-",
  "memory-",
  "research-",
]

const OUTPUT_TAIL_LENGTH = 400

function isOwnTool(toolName: string): boolean {
  return OWN_TOOL_PREFIXES.some((p) => toolName === p.slice(0, -1) || toolName.startsWith(p))
}

// 防御式提取：事件形状是宿主细节，任何不符合预期一律返回 undefined
function extractToolExecution(event: ExtensionPluginEvent): { tool: string; ok: boolean; outcome: string } | undefined {
  if (event.type !== "message.part.updated") {
    return undefined
  }
  const part = (event.properties as { part?: { type?: unknown; tool?: unknown; state?: unknown } } | undefined)?.part
  if (!part || typeof part !== "object" || part.type !== "tool") {
    return undefined
  }
  const tool = typeof part.tool === "string" ? part.tool : undefined
  if (!tool || isOwnTool(tool)) {
    return undefined
  }
  const state = part.state as { status?: unknown; output?: unknown; error?: unknown; title?: unknown } | undefined
  const status = state?.status
  if (status !== "completed" && status !== "error") {
    return undefined // pending/running 不是"发生过"
  }
  const ok = status === "completed"
  const raw = ok ? state?.output : state?.error
  const tail = typeof raw === "string" && raw.length > 0 ? raw.slice(-OUTPUT_TAIL_LENGTH) : (typeof state?.title === "string" ? state.title : "")
  return { tool, ok, outcome: tail }
}

export function createFlightRecorderExtension(): ExtensionPlugin {
  let runtime: DpnRuntime | undefined

  return {
    id: "flight-recorder",
    description: "Flight recorder — host tool executions auto-recorded as action.executed ledger entries",
    setup: async (ctx) => {
      runtime = await createRuntime({ directory: ctx.directory })
      ctx.log("debug", "flight-recorder ready")
    },
    onEvent: async (event, ctx) => {
      const extracted = extractToolExecution(event)
      if (!extracted || !runtime) {
        return
      }
      try {
        await runtime.dispatch({
          type: "action.executed",
          source: "flight-recorder",
          payload: {
            name: extracted.tool,
            outcome: extracted.outcome,
            ok: extracted.ok,
          },
        })
      } catch (error) {
        // 采集失败不破坏宿主（onEvent 故障隔离语义），记录即可
        ctx.log("warn", `flight-recorder failed to record ${extracted.tool}: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

export const flightRecorderExtension: ExtensionPlugin = createFlightRecorderExtension()
