import type { Capability, CapabilityContext } from "../core/types.ts"
import type { ExecutionKernel, ShellExecInput } from "../execution/kernel.ts"

export class ShellExecCapability implements Capability {
  readonly id = "shell.exec"
  readonly description = "Execute a shell command inside the agent platform sandbox"

  private kernel: ExecutionKernel

  constructor(kernel: ExecutionKernel) {
    this.kernel = kernel
  }

  async execute(input: unknown, context: CapabilityContext): Promise<unknown> {
    return this.kernel.execWithSignal(input as ShellExecInput, {
      sessionId: context.sessionId,
      agent: context.agent,
      messageId: context.messageId,
      directory: context.directory,
      worktree: context.worktree,
    }, context.signal)
  }
}
