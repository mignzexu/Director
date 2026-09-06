// Enhancement plugin: sandbox — secure shell execution.
//
// Contributes the `platform-exec` tool (the additive, opt-in replacement for
// overriding the built-in bash tool) and the session-tracking hook. Only
// agents that explicitly enable it (private) route through the sandbox;
// every other agent keeps using opencode's native shell untouched.
import { tool } from "@opencode-ai/plugin"
import type { ExtensionPlugin } from "../types.ts"
import type { ShellExecInput } from "../../execution/kernel.ts"
import { executeOpenCodeShell, platformForOpenCode } from "../../bootstrap.ts"

export const sandboxExtension: ExtensionPlugin = {
  id: "sandbox",
  description: "Secure shell execution inside the project-owned Windows AppContainer sandbox",

  tools: {
    "platform-exec": tool({
      description:
        "Execute a shell command through the Agent Extensions Execution Kernel. Runs in the project Windows sandbox: workspace read/write, protected platform paths inaccessible, outside-workspace and credential paths inaccessible, network disabled.",
      args: {
        command: tool.schema
          .string()
          .describe("The shell command to execute. May use shell operators and pipes."),
        cwd: tool.schema
          .string()
          .optional()
          .describe("Working directory relative to the session directory. Defaults to the session directory."),
        timeout_ms: tool.schema
          .number()
          .optional()
          .describe("Timeout in milliseconds. Defaults to 120000."),
        permissions: tool.schema
          .object({
            network: tool.schema.boolean().optional().describe("Allow network access for this invocation."),
            read: tool.schema.array(tool.schema.string()).optional().describe("Additional read roots outside the workspace."),
            write: tool.schema.array(tool.schema.string()).optional().describe("Additional write roots outside the workspace."),
          })
          .optional()
          .describe("Requested sandbox permission escalation. Phase 1 rejects all escalation requests."),
        justification: tool.schema
          .string()
          .optional()
          .describe("Why escalated permissions are needed. Recorded in the audit log."),
      },
      async execute(args, context) {
        const input: ShellExecInput = {
          command: args.command,
          ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
          ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
          ...(args.permissions !== undefined ? { permissions: args.permissions } : {}),
          ...(args.justification !== undefined ? { justification: args.justification } : {}),
        }
        const result = await executeOpenCodeShell(input, {
          sessionID: context.sessionID,
          messageID: context.messageID,
          agent: context.agent,
          directory: context.directory,
          worktree: context.worktree,
          abort: context.abort,
        })
        return JSON.stringify(result)
      },
    }),
  },

  async onEvent(event, ctx) {
    if (event.type !== "session.created") {
      return
    }
    const sessionId = (event.properties as { info?: { id?: string } } | undefined)?.info?.id
    if (!sessionId) {
      return
    }
    try {
      const platform = platformForOpenCode({ directory: ctx.directory, worktree: ctx.worktree })
      await platform.state.write("sessions.json", {
        session_id: sessionId,
        created_at: new Date().toISOString(),
      })
    } catch (error) {
      ctx.log("warn", `sandbox extension failed to record session: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
}
