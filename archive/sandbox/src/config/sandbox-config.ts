import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { DEFAULT_ENVIRONMENT_ALLOW, DEFAULT_ENVIRONMENT_DROP_PATTERN_SOURCES } from "../execution/environment.ts"

export interface SandboxConfig {
  version: 1
  backend: "windows-appcontainer"
  profile: string
  network: "deny"
  filesystem: {
    workspace_read: true
    workspace_write: true
    git_read: true
    git_write: false
    outside_read: false
    outside_write: false
    protected_paths: string[]
  }
  process: {
    default_timeout_ms: number
    max_output_chars: number
    /** Inner shell used per exec: "cmd" | "powershell" | "pwsh". */
    default_shell: "cmd" | "powershell" | "pwsh"
    /** stdout beyond this size overflows to a file (pointer returned). */
    inline_output_chars: number
    /** Per-invocation Job memory cap in MB (optional, off when absent). */
    memory_limit_mb?: number
    /** Per-invocation Job CPU hard cap in percent 1-100 (optional, off when absent). */
    cpu_rate?: number
  }
  environment: {
    allow: string[]
    drop_patterns: string[]
  }
}

export const DEFAULT_CONFIG: SandboxConfig = {
  version: 1,
  backend: "windows-appcontainer",
  profile: "agent-platform-main",
  network: "deny",
  filesystem: {
    workspace_read: true,
    workspace_write: true,
    git_read: true,
    git_write: false,
    outside_read: false,
    outside_write: false,
    protected_paths: [
      ".extensions/config",
      ".extensions/state",
      ".agent-platform/config",
      ".agent-platform/state",
      ".opencode",
    ],
  },
  process: {
    default_timeout_ms: 120_000,
    max_output_chars: 1_000_000,
    default_shell: "cmd" as const,
    inline_output_chars: 30_000,
  },
  environment: {
    allow: [...DEFAULT_ENVIRONMENT_ALLOW],
    drop_patterns: [...DEFAULT_ENVIRONMENT_DROP_PATTERN_SOURCES],
  },
}

function cloneDefault(): SandboxConfig {
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as SandboxConfig
}

function invalid(message: string): never {
  throw new Error(`invalid sandbox configuration: ${message}`)
}

function validate(raw: unknown): SandboxConfig {
  if (!raw || typeof raw !== "object") {
    return invalid("root must be an object")
  }
  const value = raw as Partial<SandboxConfig>
  if (value.version !== 1) {
    return invalid("version must be 1")
  }
  if (value.backend !== "windows-appcontainer") {
    return invalid("backend must be windows-appcontainer")
  }
  if (
    value.profile !== undefined &&
    (typeof value.profile !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.profile))
  ) {
    return invalid("profile must be an AppContainer-safe name (1-64 chars: letters, digits, dot, dash, underscore)")
  }
  if (value.network !== "deny") {
    return invalid("network must be deny in Phase 1")
  }
  const filesystem = value.filesystem
  if (!filesystem || filesystem.workspace_read !== true || filesystem.workspace_write !== true) {
    return invalid("workspace read/write must be enabled")
  }
  if (filesystem.git_read !== true || filesystem.git_write !== false) {
    return invalid(".git must be read-only")
  }
  if (filesystem.outside_read !== false || filesystem.outside_write !== false) {
    return invalid("outside-workspace access must be denied")
  }
  if (!Array.isArray(filesystem.protected_paths) || filesystem.protected_paths.some((item) => typeof item !== "string")) {
    return invalid("protected_paths must be an array of strings")
  }
  const processConfig = value.process
  if (
    !processConfig ||
    !Number.isSafeInteger(processConfig.default_timeout_ms) ||
    processConfig.default_timeout_ms <= 0 ||
    !Number.isSafeInteger(processConfig.max_output_chars) ||
    processConfig.max_output_chars <= 0
  ) {
    return invalid("process limits must be positive integers")
  }
  if (
    processConfig.default_shell !== undefined &&
    processConfig.default_shell !== "cmd" &&
    processConfig.default_shell !== "powershell" &&
    processConfig.default_shell !== "pwsh"
  ) {
    return invalid("process.default_shell must be 'cmd', 'powershell' or 'pwsh'")
  }
  if (
    processConfig.inline_output_chars !== undefined &&
    (!Number.isSafeInteger(processConfig.inline_output_chars) || processConfig.inline_output_chars <= 0)
  ) {
    return invalid("process.inline_output_chars must be a positive integer")
  }
  if (
    processConfig.memory_limit_mb !== undefined &&
    (!Number.isSafeInteger(processConfig.memory_limit_mb) || processConfig.memory_limit_mb <= 0)
  ) {
    return invalid("process.memory_limit_mb must be a positive integer")
  }
  if (
    processConfig.cpu_rate !== undefined &&
    (!Number.isSafeInteger(processConfig.cpu_rate) || processConfig.cpu_rate < 1 || processConfig.cpu_rate > 100)
  ) {
    return invalid("process.cpu_rate must be an integer between 1 and 100")
  }
  const environment = value.environment
  if (
    !environment ||
    !Array.isArray(environment.allow) ||
    environment.allow.some((item) => typeof item !== "string") ||
    !Array.isArray(environment.drop_patterns) ||
    environment.drop_patterns.some((item) => typeof item !== "string")
  ) {
    return invalid("environment allow/drop_patterns must be string arrays")
  }
  for (const pattern of environment.drop_patterns) {
    try {
      new RegExp(pattern)
    } catch (error) {
      return invalid(`invalid environment pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    version: 1,
    backend: "windows-appcontainer",
    profile: typeof value.profile === "string" ? value.profile : "agent-platform-main",
    network: "deny",
    filesystem: {
      workspace_read: true,
      workspace_write: true,
      git_read: true,
      git_write: false,
      outside_read: false,
      outside_write: false,
      protected_paths: [...filesystem.protected_paths],
    },
    process: {
      default_timeout_ms: processConfig.default_timeout_ms,
      max_output_chars: processConfig.max_output_chars,
      default_shell: processConfig.default_shell ?? "cmd",
      inline_output_chars: processConfig.inline_output_chars ?? 30_000,
      ...(processConfig.memory_limit_mb !== undefined ? { memory_limit_mb: processConfig.memory_limit_mb } : {}),
      ...(processConfig.cpu_rate !== undefined ? { cpu_rate: processConfig.cpu_rate } : {}),
    },
    environment: {
      allow: [...environment.allow],
      drop_patterns: [...environment.drop_patterns],
    },
  }
}

export function sandboxConfigPath(root: string): string {
  return path.join(root, ".extensions", "config", "sandbox.json")
}

export function loadSandboxConfig(root: string): SandboxConfig {
  const file = sandboxConfigPath(root)
  if (!existsSync(file)) {
    return cloneDefault()
  }
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    throw new Error(`cannot read sandbox configuration ${file}: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return validate(JSON.parse(raw) as unknown)
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`invalid sandbox configuration JSON ${file}: ${error.message}`)
    }
    throw error
  }
}
