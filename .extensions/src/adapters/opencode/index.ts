// L2 routing aggregator — the bridge between the single opencode-side
// Extension entry (.opencode/plugins/agent-extensions.ts) and the
// self-contained enhancement plugins under src/plugins/.
//
// Kept deliberately dumb: a static registry array. No dynamic discovery,
// no lifecycle framework — adding a plugin is a one-line change below.
// Conventions: see src/plugins/README.md.
//
// 本文件是插件层唯一的宿主类型接入点（Phase 12 独立性收口）：opencode 的
// ToolContext 在此映射为宿主无关的 ToolPort，宿主 SDK 类型不外泄到插件层。
// 换 coding CLI = 写一个新适配器（如 adapters/mcp/），插件与 Runtime 零改动。
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ExtensionPlugin, ExtensionPluginContext, ExtensionTool, ToolPort } from "../../plugins/types.ts"
import { runtimeLedgerExtension } from "../../plugins/runtime-ledger/index.ts"
import { flightRecorderExtension } from "../../plugins/flight-recorder/index.ts"

// 宿主 ToolContext → 宿主无关 ToolPort（三字段收口：审计归属 + 数据落点）
function toPort(ctx: { sessionID: string; agent: string; directory: string }): ToolPort {
  return { agent: ctx.agent, sessionID: ctx.sessionID, directory: ctx.directory }
}

// 自有 ExtensionTool → 宿主 ToolDefinition（args zod shape 直接透传）
function toHostTool(t: ExtensionTool): ToolDefinition {
  return {
    description: t.description,
    args: t.args,
    execute: (args, hostCtx) => t.execute(args, toPort(hostCtx)),
  }
}

export const extensionRegistry: readonly ExtensionPlugin[] = [
  // Enhancement plugins register here, one line each:
  //   <id>Extension,
  //
  // Plugin ① sandbox (platform-exec) was archived on 2026-09-05 — see
  // archive/sandbox/README.md. OS-level isolation moves to the openchamber
  // layer.
  runtimeLedgerExtension, // Plugin ② runtime-ledger: DPN Runtime 事实账本（2026-09-05）
  flightRecorderExtension, // Plugin ③ flight-recorder: 宿主工具执行黑匣子（2026-09-06）
]

export function extensionPluginIds(
  registry: readonly ExtensionPlugin[] = extensionRegistry,
): string[] {
  return registry.map((extension) => extension.id)
}

export interface ComposedExtensionHooks {
  tools: Record<string, ToolDefinition>
  ids: string[]
  onEvent: (event: { type: string; properties?: Record<string, unknown> }) => Promise<void>
}

export async function composeExtensionHooks(
  host: {
    directory: string
    worktree?: string
    log: (level: "debug" | "warn" | "error", message: string) => void
  },
  registry: readonly ExtensionPlugin[] = extensionRegistry,
): Promise<ComposedExtensionHooks> {
  const ctx: ExtensionPluginContext = {
    directory: host.directory,
    worktree: host.worktree,
    log: host.log,
  }
  const tools: Record<string, ToolDefinition> = {}
  for (const extension of registry) {
    for (const [id, definition] of Object.entries(extension.tools ?? {})) {
      if (tools[id] !== undefined) {
        throw new Error(`duplicate extension tool id: ${id} (plugin ${extension.id})`)
      }
      tools[id] = toHostTool(definition)
    }
    if (extension.setup) {
      try {
        await extension.setup(ctx)
      } catch (error) {
        host.log("error", `extension '${extension.id}' setup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return {
    tools,
    ids: registry.map((extension) => extension.id),
    onEvent: async (event) => {
      for (const extension of registry) {
        if (!extension.onEvent) {
          continue
        }
        try {
          await extension.onEvent(event, ctx)
        } catch (error) {
          host.log("warn", `extension '${extension.id}' event hook failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    },
  }
}
