export interface SandboxPermissions {
  network: boolean
  readRoots: string[]
  writeRoots: string[]
  protectedRoots: string[]
}

export interface SandboxEscalation {
  network: boolean
  read: string[]
  write: string[]
}

export interface SandboxExecInput {
  command: string
  workspace: string
  cwd: string
  tmpDir: string
  env: Record<string, string>
  permissions: SandboxPermissions
  timeoutMs: number
  maxOutputChars: number
  signal?: AbortSignal
  profile: string
  launcherTimeoutMs: number
  /** Run detached — returns immediately with a job handle. */
  background?: boolean
  /** Inner shell: "cmd" | "powershell" | "pwsh". */
  shell?: string
  /** Per-invocation job resource limits (0/undefined = off). */
  memoryLimitMb?: number
  cpuRate?: number
  /** Operator-approved escalations, applied by the launcher. */
  escalation?: SandboxEscalation
}

export interface SandboxExecResult {
  exit_code: number | null
  stdout: string
  stderr: string
  duration_ms: number
  timed_out: boolean
  cancelled: boolean
  stdout_truncated: boolean
  stderr_truncated: boolean
  error?: string
  /** Machine-readable sandbox error code (see capabilities/sandbox/errors.ts). */
  error_code?: string
  /** Present when the command was started in the background. */
  background?: { pid: number; dir: string }
}

export interface SandboxBackend {
  readonly name: string
  exec(input: SandboxExecInput): Promise<SandboxExecResult>
}
