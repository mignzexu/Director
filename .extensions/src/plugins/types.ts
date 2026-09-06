// Enhancement-plugin contract — the second level of the two-level routing.
//
//   L1  .opencode/plugins/agent-extensions.ts     (the ONLY opencode-side file)
//   L2  src/plugins/<id>/                          (self-contained plugins)
//
// 宿主无关契约（Phase 12 独立性强化）：插件层不 import 任何宿主 SDK——
// 工具通过自有 ExtensionTool 契约声明，宿主耦合收口在 ToolPort 三字段
// （agent / sessionID / directory），由各宿主适配器负责映射。
// 换 coding CLI = 写一个适配器（如 adapters/mcp/），插件与 Runtime 零改动。
import type { z } from "zod"

// 工具执行时从宿主拿到的最小身份面（审计字段归属、工作区落点）
export interface ToolPort {
  /** Calling agent identity (ledger event `source`). */
  agent: string
  /** Host session id (audit trail). */
  sessionID: string
  /** Workspace root — runtime data lives under <directory>/.extensions/state/. */
  directory: string
}

// 工具结果：与宿主无关的结构化文本
export type ToolOutcome = string | { title?: string; output: string }

// 自有工具契约：args 为 zod shape（宿主适配器负责转换为其原生 schema 形态）
export interface ExtensionTool {
  description: string
  args: Record<string, z.ZodTypeAny>
  execute(args: unknown, port: ToolPort): Promise<ToolOutcome>
}

export interface ExtensionPluginContext {
  directory: string
  worktree?: string
  log: (level: "debug" | "warn" | "error", message: string) => void
}

export interface ExtensionPluginEvent {
  type: string
  properties?: Record<string, unknown>
}

export interface ExtensionPlugin {
  /** Stable plugin id (routing/diagnostics; not exposed to the model). */
  id: string
  description: string
  /** opencode-agnostic tool contributions, keyed by tool id (e.g. "<domain>-<action>"). */
  tools?: Record<string, ExtensionTool>
  /** One-time initialization; failures are logged, never fatal. */
  setup?: (ctx: ExtensionPluginContext) => void | Promise<void>
  /** Event hook (session lifecycle etc.); failures are logged, never fatal. */
  onEvent?: (event: ExtensionPluginEvent, ctx: ExtensionPluginContext) => void | Promise<void>
}
