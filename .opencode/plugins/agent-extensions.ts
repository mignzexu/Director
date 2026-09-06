// L1 Extension entry — the ONLY opencode-side file of the Agent Extensions.
// Everything else lives under .extensions/ and is routed through the L2
// aggregator (src/adapters/opencode/index.ts). New enhancement plugins never
// add files here.
import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"
import { composeExtensionHooks } from "../../.extensions/src/adapters/opencode/index.ts"

export const AgentExtensionsPlugin: Plugin = async ({ directory, worktree, client }) => {
  const log = (level: "debug" | "warn" | "error", message: string): void => {
    void client.app.log({ body: { service: "agent-extensions", level, message } }).catch(() => undefined)
  }

  const hooks = await composeExtensionHooks({ directory, worktree, log })
  log("debug", `Agent Extensions ready (plugins: ${hooks.ids.join(", ")})`)

  return {
    tool: hooks.tools as Record<string, ToolDefinition>,
    event: async ({ event }) => {
      await hooks.onEvent(event as { type: string; properties?: Record<string, unknown> })
    },
  }
}

export default AgentExtensionsPlugin
