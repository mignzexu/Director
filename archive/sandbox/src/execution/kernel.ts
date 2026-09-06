import { promises as fs } from "node:fs"
import path from "node:path"
import type { SandboxBackend, SandboxExecResult } from "./sandbox-backend.ts"
import type { AuditLogger, StateStore } from "../core/types.ts"
import { loadSandboxConfig, type SandboxConfig } from "../config/sandbox-config.ts"
import { defaultSandboxPolicy, isPathWithin, type SandboxPolicy } from "./policy.ts"
import { platformTmpDir, sanitizeEnvironment } from "./environment.ts"

export interface ShellExecInput {
  command: string
  cwd?: string
  timeout_ms?: number
  permissions?: {
    network?: boolean
    read?: string[]
    write?: string[]
  }
  justification?: string
  /** Operator-approved via the ask flow — set by the plugin, never the model. */
  escalation_approved?: boolean
  /** Run detached: returns immediately with a job handle (pid + output dir). */
  background?: boolean
  /** Inner shell: "cmd" | "powershell" | "pwsh". */
  shell?: string
}

export interface ShellExecResult {
  exit_code: number | null
  stdout: string
  stderr: string
  duration_ms: number
  timed_out: boolean
  cancelled: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
  approved: boolean
  backend: string
  error?: string
  /** Machine-readable sandbox error code (see capabilities/sandbox/errors.ts). */
  error_code?: string
  /** Resolved working directory of the execution. */
  cwd?: string
  /** Present when the command was started in the background. */
  background?: { pid: number; dir: string }
  /** Escalations actually applied for this invocation. */
  escalated?: { network: boolean; read: string[]; write: string[] }
  sandbox: {
    network: boolean
    read_roots: string[]
    write_roots: string[]
    protected_roots: string[]
  }
}

export interface ExecutionMeta {
  sessionId?: string
  agent?: string
  messageId?: string
  directory: string
  worktree?: string
}

export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000
export const DEFAULT_INLINE_OUTPUT_CHARS = 30_000

interface RequestedPermissions {
  network: boolean
  read: string[]
  write: string[]
}

interface Escalation {
  network: boolean
  read: string[]
  write: string[]
}

interface ExecutionPlan {
  workspace: string
  cwd: string
  policy: SandboxPolicy
}

interface ExecutionOutcome {
  result: ShellExecResult
  approved: boolean
  cwd: string
  requested: RequestedPermissions
  justification?: string
}

function requestedPermissions(input: unknown): RequestedPermissions {
  if (!input || typeof input !== "object") {
    return { network: false, read: [], write: [] }
  }
  const permissions = (input as { permissions?: ShellExecInput["permissions"] }).permissions
  return {
    network: permissions?.network === true,
    read: Array.isArray(permissions?.read) ? permissions.read.filter((item): item is string => typeof item === "string") : [],
    write: Array.isArray(permissions?.write) ? permissions.write.filter((item): item is string => typeof item === "string") : [],
  }
}

function parseInput(input: unknown, config: SandboxConfig): ShellExecInput {
  if (!input || typeof input !== "object") {
    throw new Error("shell.exec input must be an object")
  }
  const value = input as Partial<ShellExecInput>
  if (typeof value.command !== "string") {
    throw new Error("shell.exec command must be a string")
  }
  if (value.cwd !== undefined && typeof value.cwd !== "string") {
    throw new Error("shell.exec cwd must be a string")
  }
  if (
    value.timeout_ms !== undefined &&
    (!Number.isSafeInteger(value.timeout_ms) || value.timeout_ms <= 0 || value.timeout_ms > 86_400_000)
  ) {
    throw new Error("shell.exec timeout_ms must be a positive integer no greater than 86400000")
  }
  if (value.background !== undefined && typeof value.background !== "boolean") {
    throw new Error("shell.exec background must be boolean")
  }
  if (value.shell !== undefined && typeof value.shell !== "string") {
    throw new Error("shell.exec shell must be a string")
  }
  if (value.escalation_approved !== undefined && typeof value.escalation_approved !== "boolean") {
    throw new Error("shell.exec escalation_approved must be boolean")
  }
  const permissions = value.permissions
  if (permissions !== undefined) {
    if (typeof permissions !== "object" || permissions === null) {
      throw new Error("shell.exec permissions must be an object")
    }
    for (const field of ["read", "write"] as const) {
      const roots = permissions[field]
      if (roots !== undefined && (!Array.isArray(roots) || roots.some((item) => typeof item !== "string"))) {
        throw new Error(`shell.exec permissions.${field} must be a string array`)
      }
    }
    if (permissions.network !== undefined && typeof permissions.network !== "boolean") {
      throw new Error("shell.exec permissions.network must be boolean")
    }
  }
  if (value.justification !== undefined && typeof value.justification !== "string") {
    throw new Error("shell.exec justification must be a string")
  }
  return {
    command: value.command,
    ...(value.cwd !== undefined ? { cwd: value.cwd } : {}),
    ...(value.timeout_ms !== undefined ? { timeout_ms: value.timeout_ms } : {}),
    ...(value.permissions !== undefined ? { permissions: value.permissions } : {}),
    ...(value.justification !== undefined ? { justification: value.justification } : {}),
    ...(value.background !== undefined ? { background: value.background } : {}),
    ...(value.shell !== undefined ? { shell: value.shell } : {}),
    ...(value.escalation_approved !== undefined ? { escalation_approved: value.escalation_approved } : {}),
  }
}

function emptyResult(
  message: string,
  backend: string,
  policy?: SandboxPolicy,
  durationMs = 0,
): ShellExecResult {
  return {
    exit_code: null,
    stdout: "",
    stderr: message,
    duration_ms: durationMs,
    timed_out: false,
    cancelled: false,
    stdout_truncated: false,
    stderr_truncated: false,
    approved: false,
    backend,
    error: message,
    sandbox: {
      network: policy?.network ?? false,
      read_roots: policy?.readRoots ?? [],
      write_roots: policy?.writeRoots ?? [],
      protected_roots: policy?.protectedRoots ?? [],
    },
  }
}

function mapBackendResult(
  result: SandboxExecResult,
  backend: string,
  policy: SandboxPolicy,
  durationMs: number,
  overrides: { cwd?: string; stdout?: string; background?: { pid: number; dir: string }; escalated?: Escalation } = {},
): ShellExecResult {
  const mapped: ShellExecResult = {
    exit_code: result.exit_code,
    stdout: overrides.stdout ?? result.stdout,
    stderr: result.stderr,
    duration_ms: result.duration_ms || durationMs,
    timed_out: result.timed_out || result.exit_code === 124,
    cancelled: result.cancelled,
    stdout_truncated: result.stdout_truncated,
    stderr_truncated: result.stderr_truncated,
    approved: true,
    backend,
    ...(result.error ? { error: result.error } : {}),
    ...(result.error_code ? { error_code: result.error_code } : {}),
    ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
    ...(overrides.background ? { background: overrides.background } : {}),
    ...(overrides.escalated
      ? {
          escalated: {
            network: overrides.escalated.network,
            read: [...overrides.escalated.read],
            write: [...overrides.escalated.write],
          },
        }
      : {}),
    sandbox: {
      network: policy.network || (overrides.escalated?.network === true),
      read_roots: policy.readRoots,
      write_roots: policy.writeRoots,
      protected_roots: policy.protectedRoots,
    },
  }
  return mapped
}

export class ExecutionKernel {
  readonly backend: SandboxBackend
  readonly config: SandboxConfig
  private state: StateStore
  private audit: AuditLogger
  private defaultTimeoutMs: number
  private maxOutputChars: number
  private tmpRoot: string

  constructor(options: {
    backend: SandboxBackend
    state: StateStore
    audit: AuditLogger
    config?: SandboxConfig
    defaultTimeoutMs?: number
    maxOutputChars?: number
    tmpRoot?: string
  }) {
    this.backend = options.backend
    this.state = options.state
    this.audit = options.audit
    this.config = options.config ?? loadSandboxConfig(process.cwd())
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? this.config.process.default_timeout_ms ?? DEFAULT_TIMEOUT_MS
    this.maxOutputChars = options.maxOutputChars ?? this.config.process.max_output_chars ?? DEFAULT_MAX_OUTPUT_CHARS
    this.tmpRoot = options.tmpRoot ?? platformTmpDir(process.cwd())
  }

  async exec(input: ShellExecInput, meta: ExecutionMeta): Promise<ShellExecResult> {
    return this.execWithSignal(input, meta, undefined)
  }

  async execWithSignal(
    input: ShellExecInput,
    meta: ExecutionMeta,
    signal: AbortSignal | undefined,
  ): Promise<ShellExecResult> {
    const started = Date.now()
    const requested = requestedPermissions(input)
    const fallbackWorkspace = path.resolve(meta.worktree?.trim() || meta.directory || process.cwd())
    let cwd = fallbackWorkspace
    try {
      const workspace = await this.resolveWorkspace(meta)
      cwd = workspace
      const parsed = parseInput(input, this.config)
      cwd = await this.resolveCwd(workspace, parsed.cwd)
      const plan = this.planExecution(workspace, cwd)
      const timeoutMs = parsed.timeout_ms ?? this.defaultTimeoutMs
      const escalation = this.resolveEscalation(parsed, plan)
      const outcome =
        this.rejectionOutcome(parsed, plan, started) ??
        (await this.dispatchToBackend(parsed, escalation, signal, plan, timeoutMs, started))
      return await this.auditOutcome(input, meta, outcome)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const outcome: ExecutionOutcome = {
        result: emptyResult(message, this.backend.name, undefined, Date.now() - started),
        approved: false,
        cwd,
        requested,
        ...(typeof input?.justification === "string" ? { justification: input.justification } : {}),
      }
      return await this.auditOutcome(input, meta, outcome)
    }
  }

  private resolveWorkspace(meta: ExecutionMeta): Promise<string> {
    const candidate = meta.worktree?.trim() || meta.directory
    if (!candidate) {
      throw new Error("execution workspace is missing")
    }
    const resolved = path.resolve(candidate)
    if (resolved === path.parse(resolved).root) {
      throw new Error("execution workspace cannot be a filesystem root")
    }
    return fs.stat(resolved).then(async (info) => {
      if (!info.isDirectory()) {
        throw new Error(`execution workspace is not a directory: ${resolved}`)
      }
      return fs.realpath(resolved)
    })
  }

  private async resolveCwd(workspace: string, requestedCwd: string | undefined): Promise<string> {
    const candidate = requestedCwd ? path.resolve(workspace, requestedCwd) : workspace
    if (!isPathWithin(workspace, candidate)) {
      throw new Error("working directory is outside the execution workspace")
    }
    const real = await fs.realpath(candidate)
    if (!isPathWithin(workspace, real)) {
      throw new Error("working directory resolves outside the execution workspace")
    }
    const info = await fs.stat(real)
    if (!info.isDirectory()) {
      throw new Error(`working directory is not a directory: ${real}`)
    }
    return real
  }

  private planExecution(workspace: string, cwd: string): ExecutionPlan {
    const policy = defaultSandboxPolicy({ workspace, config: this.config })
    for (const protectedRoot of policy.protectedRoots) {
      if (!isPathWithin(policy.workspace, protectedRoot)) {
        throw new Error(`sandbox protected path escapes workspace: ${protectedRoot}`)
      }
    }
    return { workspace, cwd, policy }
  }

  private rejectionOutcome(
    parsed: ShellExecInput,
    plan: ExecutionPlan,
    started: number,
  ): ExecutionOutcome | undefined {
    if (parsed.command.trim()) {
      return undefined
    }
    return {
      result: emptyResult("empty command", this.backend.name, plan.policy, Date.now() - started),
      approved: false,
      cwd: plan.cwd,
      requested: requestedPermissions(parsed),
      ...(parsed.justification !== undefined ? { justification: parsed.justification } : {}),
    }
  }

  /**
   * Phase 2 escalation: the model may REQUEST extra grants; the plugin gates
   * the request through the operator-approval ask flow and only then sets
   * `escalation_approved`. The kernel enforces that flag plus path policy
   * (never overlapping protected paths) and resolves roots to absolutes.
   */
  private resolveEscalation(parsed: ShellExecInput, plan: ExecutionPlan): Escalation | undefined {
    const requested = parsed.permissions
    const wantsNetwork = requested?.network === true
    const wantsRead = requested?.read ?? []
    const wantsWrite = requested?.write ?? []
    if (!wantsNetwork && wantsRead.length === 0 && wantsWrite.length === 0) {
      return undefined
    }
    if (parsed.background) {
      throw new Error("permission escalation cannot be combined with background execution")
    }
    if (parsed.escalation_approved !== true) {
      throw new Error("permission escalation requires operator approval before it can be applied")
    }
    const protectedPaths = this.config.filesystem.protected_paths.map((item) => path.resolve(plan.workspace, item))
    const resolveRoots = (kind: string, roots: string[]): string[] =>
      roots.map((root) => {
        const abs = path.resolve(plan.workspace, root)
        if (isPathWithin(abs, plan.workspace) && abs !== plan.workspace) {
          // inside the workspace: already granted, harmless no-op
          return abs
        }
        for (const protectedPath of protectedPaths) {
          if (isPathWithin(abs, protectedPath) || isPathWithin(protectedPath, abs)) {
            throw new Error(`escalation ${kind} root '${root}' overlaps protected path '${protectedPath}'`)
          }
        }
        return abs
      })
    return {
      network: wantsNetwork,
      read: resolveRoots("read", wantsRead),
      write: resolveRoots("write", wantsWrite),
    }
  }

  private async dispatchToBackend(
    parsed: ShellExecInput,
    escalation: Escalation | undefined,
    signal: AbortSignal | undefined,
    plan: ExecutionPlan,
    timeoutMs: number,
    started: number,
  ): Promise<ExecutionOutcome> {
    const tmpDir = await this.tmpDirFor()
    try {
      const env = sanitizeEnvironment({
        tmpDir,
        keep: this.config.environment.allow,
        dropPatterns: this.config.environment.drop_patterns.map((pattern) => new RegExp(pattern)),
      })
      const background = parsed.background === true
      const backendResult = await this.backend.exec({
        command: parsed.command,
        workspace: plan.workspace,
        cwd: plan.cwd,
        tmpDir,
        env,
        permissions: {
          network: plan.policy.network,
          readRoots: plan.policy.readRoots,
          writeRoots: plan.policy.writeRoots,
          protectedRoots: plan.policy.protectedRoots,
        },
        timeoutMs,
        launcherTimeoutMs: background ? 0 : Math.max(1000, timeoutMs - 2500),
        profile: this.config.profile,
        maxOutputChars: this.maxOutputChars,
        signal,
        background,
        shell: parsed.shell ?? this.config.process.default_shell,
        memoryLimitMb: this.config.process.memory_limit_mb,
        cpuRate: this.config.process.cpu_rate,
        escalation,
      })

      // Large stdout overflows to a file next to the exec scratch (swept
      // after 24h); the model gets a head plus a pointer.
      const inlineChars = this.config.process.inline_output_chars ?? DEFAULT_INLINE_OUTPUT_CHARS
      let backendStdout = backendResult.stdout
      if (backendStdout.length > inlineChars) {
        const outPath = path.join(this.tmpRoot, `out-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
        await fs.mkdir(this.tmpRoot, { recursive: true })
        await fs.writeFile(outPath, backendStdout, "utf8")
        backendStdout =
          backendStdout.slice(0, inlineChars) + `\n...[output truncated at ${inlineChars} chars — full output: ${outPath}]`
        backendResult.stdout_truncated = true
      }

      return {
        result: mapBackendResult(backendResult, this.backend.name, plan.policy, Date.now() - started, {
          cwd: plan.cwd,
          stdout: backendStdout,
          background: background
            ? (backendResult.background ?? undefined)
            : undefined,
          escalated: escalation,
        }),
        approved: true,
        cwd: plan.cwd,
        requested: requestedPermissions(parsed),
        ...(parsed.justification !== undefined ? { justification: parsed.justification } : {}),
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private async tmpDirFor(): Promise<string> {
    await fs.mkdir(this.tmpRoot, { recursive: true })
    return fs.mkdtemp(path.join(this.tmpRoot, "exec-"))
  }

  private async auditOutcome(
    input: ShellExecInput,
    meta: ExecutionMeta,
    outcome: ExecutionOutcome,
  ): Promise<ShellExecResult> {
    const result = outcome.result
    try {
      await this.audit.record({
        timestamp: new Date().toISOString(),
        session_id: meta.sessionId,
        agent: meta.agent,
        capability: "shell.exec",
        command: typeof input?.command === "string" ? input.command : "",
        cwd: outcome.cwd,
        permissions: {
          network: result.sandbox.network,
          read: result.sandbox.read_roots,
          write: result.sandbox.write_roots,
          protected_paths: result.sandbox.protected_roots,
        },
        requested_permissions: {
          network: outcome.requested.network,
          read: outcome.requested.read,
          write: outcome.requested.write,
          ...(outcome.justification !== undefined ? { justification: outcome.justification } : {}),
        },
        approved: outcome.approved,
        backend: result.backend,
        exit_code: result.exit_code,
        timed_out: result.timed_out,
        cancelled: result.cancelled,
        duration_ms: result.duration_ms,
        error: result.error,
        ...(result.error_code ? { error_code: result.error_code } : {}),
      })
    } catch (error) {
      const message = `audit logging failed: ${error instanceof Error ? error.message : String(error)}`
      return {
        ...result,
        error: result.error ? `${result.error}; ${message}` : message,
        stderr: result.stderr ? `${result.stderr}\n${message}` : message,
      }
    }
    return result
  }
}
