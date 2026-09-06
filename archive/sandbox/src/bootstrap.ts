import { existsSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentPlatform } from "./core/platform.ts"
import { createAgentPlatform } from "./core/platform.ts"
import { DefaultCapabilityRegistry } from "./core/capability-registry.ts"
import { FileStateStore } from "./state/state-store.ts"
import { JsonlAuditLogger } from "./state/audit.ts"
import { ExecutionKernel } from "./execution/kernel.ts"
import { WindowsAppContainerBackend, resolvePowerShellBinary, sweepStaleTmpDirs } from "./execution/windows-appcontainer-backend.ts"
import type { SandboxBackend } from "./execution/sandbox-backend.ts"
import { ShellExecCapability } from "./capabilities/shell-exec.ts"
import { loadSandboxConfig, sandboxConfigPath } from "./config/sandbox-config.ts"

export interface PlatformOptions {
  directory: string
  worktree?: string
  sandbox?: "auto" | "windows-appcontainer"
  powershellBin?: string
  stateDir?: string
}

export function resolveProjectRoot(directory: string | undefined, worktree: string | undefined): string {
  const candidates = [worktree, directory].filter((item): item is string => Boolean(item?.trim()))
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate)
    if (resolved === path.parse(resolved).root) {
      continue
    }
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      return resolved
    }
  }
  let current = path.resolve(process.cwd())
  while (current !== path.parse(current).root) {
    const marker = path.join(current, ".extensions", "config", "sandbox.json")
    const legacyMarker = path.join(current, ".agent-platform", "config", "sandbox.json")
    if ((existsSync(marker) || existsSync(legacyMarker)) && statSync(current).isDirectory()) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  if (candidates.length === 0) {
    throw new Error("OpenCode did not provide a project directory")
  }
  throw new Error(`Agent Platform could not resolve a non-root project directory: ${candidates.join(", ")}`)
}

const platformCache = new Map<string, { platform: AgentPlatform; configMtimeMs: number }>()

function configStamp(root: string): number {
  const file = sandboxConfigPath(root)
  if (!existsSync(file)) {
    return 0
  }
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

function pickBackend(options: PlatformOptions): SandboxBackend {
  const mode = options.sandbox ?? "auto"
  if (mode !== "auto" && mode !== "windows-appcontainer") {
    throw new Error(`unknown sandbox mode: ${mode}`)
  }
  try {
    resolvePowerShellBinary(options.powershellBin)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  return new WindowsAppContainerBackend({ powershellBin: options.powershellBin })
}

export function createPlatform(options: PlatformOptions): AgentPlatform {
  const root = resolveProjectRoot(options.directory, options.worktree)
  const config = loadSandboxConfig(root)
  const cacheKey = `${config.backend}:${root}:${options.stateDir ?? "default"}`
  const stamp = configStamp(root)
  const cached = platformCache.get(cacheKey)
  if (cached && cached.configMtimeMs === stamp) {
    return cached.platform
  }

  const stateRoot = options.stateDir ?? path.join(root, ".extensions", "state")
  const resolvedStateRoot = path.resolve(stateRoot)
  if (resolvedStateRoot !== root && !resolvedStateRoot.startsWith(root + path.sep)) {
    throw new Error("Agent Platform state directory must remain inside the project")
  }
  const tmpRoot = path.join(root, ".extensions", "tmp")
  const state = new FileStateStore(resolvedStateRoot)
  const audit = new JsonlAuditLogger(path.join(resolvedStateRoot, "audit.jsonl"))
  const backend = pickBackend(options)
  const kernel = new ExecutionKernel({ backend, state, audit, config, tmpRoot })
  const capabilities = new DefaultCapabilityRegistry()
  capabilities.register(new ShellExecCapability(kernel))

  const platform = createAgentPlatform({
    directory: root,
    capabilities,
    execution: kernel,
    state,
    audit,
  })
  platformCache.set(cacheKey, { platform, configMtimeMs: stamp })
  void sweepStaleTmpDirs(tmpRoot).catch(() => undefined)
  return platform
}

// ---- external-caller entry (engine-level; enhancement plugins import these) ----

export interface OpenCodeContext {
  directory: string
  worktree?: string
  sessionID?: string
  messageID?: string
  agent?: string
  abort?: AbortSignal
}

function localProjectRoot(): string {
  // this file lives at <root>/.extensions/src/bootstrap.ts → up 3 levels
  return path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
}

function usableProjectRoot(candidate: string | undefined): string | undefined {
  if (!candidate?.trim()) {
    return undefined
  }
  const resolved = path.resolve(candidate)
  if (resolved === path.parse(resolved).root) {
    return undefined
  }
  try {
    return statSync(resolved).isDirectory() ? resolved : undefined
  } catch {
    return undefined
  }
}

export function projectRootForOpenCode(context: OpenCodeContext): string {
  const contextRoot = usableProjectRoot(context.worktree) ?? usableProjectRoot(context.directory)
  if (contextRoot) {
    return contextRoot
  }
  const adapterRoot = localProjectRoot()
  if (
    existsSync(path.join(adapterRoot, ".extensions", "config", "sandbox.json")) ||
    existsSync(path.join(adapterRoot, ".agent-platform", "config", "sandbox.json"))
  ) {
    return adapterRoot
  }
  throw new Error("OpenCode did not provide a usable project directory")
}

export function platformForOpenCode(context: OpenCodeContext): AgentPlatform {
  const root = projectRootForOpenCode(context)
  return createPlatform({
    directory: root,
    worktree: root,
  })
}

export async function executeOpenCodeShell(
  input: Parameters<ExecutionKernel["exec"]>[0],
  context: OpenCodeContext,
): Promise<ReturnType<ExecutionKernel["exec"]>> {
  const root = projectRootForOpenCode(context)
  const platform = platformForOpenCode(context)
  // Route through the capability so the abort signal rides in
  // CapabilityContext (ExecutionMeta has no signal field).
  const result = await platform.capabilities.get("shell.exec").execute(input, {
    sessionId: context.sessionID,
    agent: context.agent,
    messageId: context.messageID,
    directory: root,
    worktree: root,
    signal: context.abort,
  })
  return result as ReturnType<ExecutionKernel["exec"]>
}
