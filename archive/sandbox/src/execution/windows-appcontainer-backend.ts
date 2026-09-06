import { promises as fs, existsSync, type Dirent } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { platform as hostPlatform } from "node:os"
import type {
  SandboxBackend,
  SandboxExecInput,
  SandboxExecResult,
} from "./sandbox-backend.ts"
import { runProcess } from "./process.ts"
import {
  SANDBOX_ERROR_PREFIX,
  decodeSandboxErrorLines,
  resolveCommandShell,
} from "../capabilities/sandbox/index.ts"

function runtimeFile(name: string): string {
  return fileURLToPath(new URL(`../../runtime/${name}`, import.meta.url))
}

export function resolvePowerShellBinary(override?: string): string {
  const candidates = [
    override,
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      : undefined,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate
    }
  }
  throw new Error("project sandbox requires Windows PowerShell 5.1; no powershell.exe was found")
}

export function projectRuntimeFiles(): { launcher: string; nativeSource: string } {
  return {
    launcher: runtimeFile("windows-appcontainer-launcher.ps1"),
    nativeSource: runtimeFile("windows-appcontainer-native.cs"),
  }
}

export function sandboxAvailable(): boolean {
  if (hostPlatform() !== "win32") {
    return false
  }
  try {
    resolvePowerShellBinary()
    const files = projectRuntimeFiles()
    return existsSync(files.launcher) && existsSync(files.nativeSource)
  } catch {
    return false
  }
}

export interface SandboxRequest {
  version: 2
  workspace: string
  cwd: string
  command: string
  comspec: string
  environment: Record<string, string>
  protected_paths: string[]
  profile: string
  launcher_timeout_ms: number
  background: boolean
  shell: string
  memory_limit_mb: number
  cpu_rate: number
  escalation: {
    network: boolean
    read_roots: string[]
    write_roots: string[]
  }
}

export function buildSandboxRequest(input: SandboxExecInput): SandboxRequest {
  if (input.escalation !== undefined && input.background === true) {
    throw new Error("escalation cannot be combined with background execution")
  }
  // Validated, never trusted ambient input: an invalid comspec is a typed
  // sandbox error, not a silent fallback (sandbox-runtime parseWindowsBinShell
  // pattern).
  const comspec = resolveCommandShell(input.env.ComSpec ?? process.env.ComSpec)
  return {
    version: 2,
    workspace: input.workspace,
    cwd: input.cwd,
    command: input.command,
    comspec,
    environment: input.env,
    protected_paths: input.permissions.protectedRoots.map((item) => path.relative(input.workspace, item)),
    profile: input.profile,
    launcher_timeout_ms: input.launcherTimeoutMs,
    background: input.background === true,
    shell: input.shell ?? "cmd",
    memory_limit_mb: input.memoryLimitMb ?? 0,
    cpu_rate: input.cpuRate ?? 0,
    escalation: {
      network: input.escalation?.network === true,
      read_roots: input.escalation?.read ?? [],
      write_roots: input.escalation?.write ?? [],
    },
  }
}

export async function sweepStaleTmpDirs(tmpRoot: string, maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  if (hostPlatform() !== "win32") {
    return
  }
  let entries: Dirent[]
  try {
    entries = await fs.readdir(tmpRoot, { withFileTypes: true })
  } catch {
    return
  }
  const cutoff = Date.now() - maxAgeMs
  for (const entry of entries) {
    if (!entry.isDirectory() || !(entry.name.startsWith("exec-") || entry.name.startsWith("out-") || entry.name.startsWith("job-"))) {
      continue
    }
    const dir = path.join(tmpRoot, entry.name)
    try {
      const info = await fs.stat(dir)
      if (info.mtimeMs < cutoff) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    } catch {
      // best-effort sweep; ignore unreadable entries
    }
  }
}

export class WindowsAppContainerBackend implements SandboxBackend {
  readonly name = "windows-appcontainer"
  private powershell: string | undefined

  constructor(options?: { powershellBin?: string }) {
    this.powershell = options?.powershellBin
  }

  supported(): boolean {
    return sandboxAvailable()
  }

  async exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    if (hostPlatform() !== "win32") {
      throw new Error("windows-appcontainer sandbox is only available on Windows")
    }
    const powershell = resolvePowerShellBinary(this.powershell)
    const files = projectRuntimeFiles()
    const request: SandboxRequest = buildSandboxRequest(input)
    await fs.mkdir(input.tmpDir, { recursive: true })
    const requestFile = path.join(input.tmpDir, `request-${randomUUID()}.json`)
    await fs.writeFile(requestFile, JSON.stringify(request), "utf8")

    try {
      const result = await runProcess({
        command: powershell,
        args: [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          files.launcher,
          "-RequestFile",
          requestFile,
        ],
        cwd: input.cwd,
        env: input.env,
        timeoutMs: input.timeoutMs,
        signal: input.signal,
        maxOutputChars: input.maxOutputChars,
      })
      const hasSandboxError = result.stderr.includes(SANDBOX_ERROR_PREFIX)
      const structured = decodeSandboxErrorLines(result.stderr)
      const lastStructured = structured.length > 0 ? structured[structured.length - 1] : undefined
      return {
        exit_code: result.exit_code,
        stdout: result.stdout,
        stderr: result.stderr,
        duration_ms: result.duration_ms,
        timed_out: result.timed_out,
        cancelled: result.cancelled,
        stdout_truncated: result.stdout_truncated,
        stderr_truncated: result.stderr_truncated,
        ...(hasSandboxError || lastStructured
          ? { error: lastStructured ? lastStructured.message : result.stderr.trim() }
          : {}),
        ...(lastStructured ? { error_code: lastStructured.code } : {}),
        ...(result.background ? { background: result.background } : {}),
      }
    } finally {
      await fs.rm(requestFile, { force: true }).catch(() => undefined)
      await fs.rm(input.tmpDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
