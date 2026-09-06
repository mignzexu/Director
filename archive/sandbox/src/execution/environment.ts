import path from "node:path"

// Single source of truth for the sanitized-environment defaults.
// sandbox-config.ts (DEFAULT_CONFIG) and config/sandbox.json mirror these;
// change them here first, then sync the config file.
export const DEFAULT_ENVIRONMENT_ALLOW = [
  "PATH",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "OS",
  "LOCALAPPDATA",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "PUBLIC",
  "ALLUSERSPROFILE",
  "USERNAME",
  "COMPUTERNAME",
]

// Marked on every sandboxed child process so nested execution (e.g. running
// the test suite from inside the sandbox) can be detected and skipped.
export const SANDBOX_MARKER_VARIABLE = "AGENT_PLATFORM_SANDBOXED"

export const DEFAULT_ENVIRONMENT_DROP_PATTERN_SOURCES = [
  "KEY$",
  "TOKEN$",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "^AWS",
  "^AZURE",
  "^GCP_",
  "^GOOGLE_",
  "^SSH_",
  "^GITHUB_",
  "^GITLAB_",
  "^OPENAI_",
  "^ANTHROPIC_",
  "^HF_",
  "^HUGGING",
  "^DOCKER_",
  "^KUBE",
]

export const DEFAULT_ENVIRONMENT_DROP_PATTERNS: RegExp[] = DEFAULT_ENVIRONMENT_DROP_PATTERN_SOURCES.map(
  (source) => new RegExp(source),
)

export interface SanitizeEnvironmentOptions {
  tmpDir: string
  keep?: string[]
  dropPatterns?: RegExp[]
}

export function sanitizeEnvironment(options: SanitizeEnvironmentOptions): Record<string, string> {
  const keep = options.keep ?? DEFAULT_ENVIRONMENT_ALLOW
  const dropPatterns = options.dropPatterns ?? DEFAULT_ENVIRONMENT_DROP_PATTERNS
  const env: Record<string, string> = {}

  for (const key of keep) {
    if (dropPatterns.some((pattern) => pattern.test(key))) {
      continue
    }
    const value = process.env[key]
    if (value !== undefined && !value.includes("\u0000")) {
      env[key] = value
    }
  }

  if (env.ComSpec === undefined && process.env.ComSpec !== undefined) {
    env.ComSpec = process.env.ComSpec
  }
  if (env.SystemRoot === undefined && process.env.SystemRoot !== undefined) {
    env.SystemRoot = process.env.SystemRoot
  }
  if (env.SystemDrive === undefined && process.env.SystemDrive !== undefined) {
    env.SystemDrive = process.env.SystemDrive
  }

  env.TMPDIR = options.tmpDir
  env.TMP = options.tmpDir
  env.TEMP = options.tmpDir
  env[SANDBOX_MARKER_VARIABLE] = "1"

  return env
}

export function platformTmpDir(base: string): string {
  return path.join(base, "tmp")
}
