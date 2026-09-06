// Sandbox error taxonomy — ported from the Anthropic sandbox-runtime design
// (WindowsSandboxErrorCode / WindowsSandboxError). Consumers branch on `.code`
// instead of prose-matching `.message`; message text is diagnostic and may
// change between releases.
//
// The launcher emits BOTH channels for backward compatibility:
//   1. the legacy human-readable prefix line: AGENT_PLATFORM_SANDBOX_ERROR: [code] message
//   2. one compact JSON line: {"svc":"agent-platform-sandbox","code":"...","message":"...","ts":"..."}
// Older kernels read (1); this module decodes (2).

export const SANDBOX_ERROR_SERVICE = "agent-extensions-sandbox"
// Legacy prefix kept verbatim for pre-Extension consumers (the running host
// process matches this exact string until restart):
export const SANDBOX_ERROR_PREFIX = "AGENT_PLATFORM_SANDBOX_ERROR:"

export type SandboxErrorCode =
  /** request version is not the supported one */
  | "request_unsupported"
  /** profile name missing or not AppContainer-safe */
  | "profile_invalid"
  /** inner shell is not a validated absolute cmd.exe path */
  | "shell_invalid"
  /** workspace missing / not a directory / filesystem root */
  | "workspace_invalid"
  /** cwd missing or outside the workspace */
  | "cwd_invalid"
  /** native launcher dll could not be loaded or compiled */
  | "native_unavailable"
  /** an ACL rule could not be applied */
  | "provision_failed"
  /** behavioral probe contradicted the sandbox policy (fail-closed) */
  | "verify_failed"
  /** the network probe connected — the network fence is NOT active */
  | "verify_network_open"
  /** the protected-path probe wrote through a deny — protection broken */
  | "protected_probe_violation"
  /** internal launcher error (unexpected exception) */
  | "internal_error"

export interface SandboxErrorLine {
  svc: typeof SANDBOX_ERROR_SERVICE
  code: SandboxErrorCode
  message: string
  ts?: string
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode

  constructor(code: SandboxErrorCode, message: string) {
    super(message)
    this.name = "SandboxError"
    this.code = code
  }
}

export function encodeSandboxErrorLine(
  code: SandboxErrorCode,
  message: string,
  ts: string = new Date().toISOString(),
): string {
  return JSON.stringify({ svc: SANDBOX_ERROR_SERVICE, code, message, ts })
}

/**
 * Decode every structured error line from a launcher stderr stream.
 * Tolerates arbitrary interleaved output (command stderr passes through the
 * same stream): only exact `{"svc":"agent-platform-sandbox",…}` objects with
 * string code/message are collected, in order.
 */
export function decodeSandboxErrorLines(stderr: string): SandboxErrorLine[] {
  if (!stderr) {
    return []
  }
  const out: SandboxErrorLine[] = []
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith("{") || !line.includes(`"${SANDBOX_ERROR_SERVICE}"`)) {
      continue
    }
    try {
      const parsed = JSON.parse(line) as Partial<SandboxErrorLine>
      if (
        parsed?.svc === SANDBOX_ERROR_SERVICE &&
        typeof parsed.code === "string" &&
        typeof parsed.message === "string"
      ) {
        out.push({
          svc: SANDBOX_ERROR_SERVICE,
          code: parsed.code as SandboxErrorCode,
          message: parsed.message,
          ...(typeof parsed.ts === "string" ? { ts: parsed.ts } : {}),
        })
      }
    } catch {
      // not our line — command output that happens to look like JSON
    }
  }
  return out
}

/** Extract the machine-readable code from a legacy prefix line, if any. */
export function codeFromPrefixLine(stderr: string): SandboxErrorCode | undefined {
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith(SANDBOX_ERROR_PREFIX)) {
      continue
    }
    const match = line.slice(SANDBOX_ERROR_PREFIX.length).trim().match(/^\[([a-z_]+)\]/)
    if (match) {
      return match[1] as SandboxErrorCode
    }
  }
  return undefined
}
