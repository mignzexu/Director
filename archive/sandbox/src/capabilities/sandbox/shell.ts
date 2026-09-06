// Inner-shell normalization — a focused port of the Anthropic sandbox-runtime
// `parseWindowsBinShell` pattern: a SOLE normalizer with all validation in one
// place, and no silent fallback to cmd.exe for unrecognised input.
//
// One deliberate divergence: bash.exe is REJECTED, not merely
// path-required. Our command contract is cmd-style (`&` chains, cmd quoting)
// end to end — the native launcher builds `cmd /d /s /c call file.cmd` — so
// accepting a POSIX shell here would change execution semantics, not just the
// binary. See resolveCommandShell for the stricter cmd-only check the Windows
// backend actually uses.

import path from "node:path"
import { SandboxError } from "./errors.ts"

export interface BinShell {
  /** Shell executable (absolute). */
  exe: string
  /** Argv placed between the executable and the user's command string. */
  args: readonly string[]
}

const PWSH_FLAGS = ["-NoProfile", "-Command"] as const
const CMD_FLAGS = ["/d", "/s", "/c"] as const

export function parseBinShell(raw?: string | null): BinShell {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  const cmdDefault: BinShell = {
    exe: path.win32.join(systemRoot, "System32", "cmd.exe"),
    args: CMD_FLAGS,
  }
  if (raw === undefined || raw === null || raw.trim() === "") {
    return cmdDefault
  }
  const isAbs = path.win32.isAbsolute(raw)
  const base = path.win32.basename(raw).toLowerCase()
  // A relative path with a directory component is neither a bare token nor a
  // resolved install — never silently degrade.
  if (!isAbs && raw !== path.win32.basename(raw)) {
    throw new SandboxError(
      "shell_invalid",
      `shell must be a bare token or an absolute path (got ${JSON.stringify(raw)})`,
    )
  }
  switch (base) {
    case "cmd":
    case "cmd.exe":
      return isAbs ? { exe: raw, args: CMD_FLAGS } : cmdDefault
    case "powershell":
    case "powershell.exe":
      return {
        exe: isAbs
          ? raw
          : path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args: PWSH_FLAGS,
      }
    case "pwsh":
    case "pwsh.exe":
      return { exe: isAbs ? raw : "pwsh.exe", args: PWSH_FLAGS }
    default:
      throw new SandboxError(
        "shell_invalid",
        `unrecognised shell ${JSON.stringify(raw)}: expected 'cmd' | 'powershell' | 'pwsh' or an absolute path to cmd.exe/powershell.exe/pwsh.exe`,
      )
  }
}

/**
 * The Windows sandbox executes commands through cmd.exe with hardcoded
 * native flags (`cmd /d /s /c call file.cmd`), so the comspec MUST be a
 * validated absolute cmd.exe path. Normalizes then enforces that constraint,
 * throwing a typed error instead of trusting ambient environment input.
 */
export function resolveCommandShell(raw?: string | null): string {
  const shell = parseBinShell(raw)
  if (!shell.exe.toLowerCase().endsWith("\\cmd.exe")) {
    throw new SandboxError(
      "shell_invalid",
      `the Windows sandbox executes commands through cmd.exe (got ${JSON.stringify(raw)}); POSIX shells change command semantics and are rejected`,
    )
  }
  return shell.exe
}
