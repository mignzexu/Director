// Sandbox capability — the platform-facing surface of the execution sandbox.
//
// Layering (see runtime/README.md):
//   capabilities/sandbox/  platform contracts: error taxonomy, shell policy
//   execution/             kernel + Windows backend adapter (spawns the launcher)
//   runtime/               OS boundary: launcher.ps1 + native CreateProcess
//
// Design principles ported from anthropics/sandbox-runtime:
//   - stable machine-readable error codes, never prose-matching
//   - truth from live enumeration — no marker/flag files for provision state
//   - behavioral verification with fail-closed semantics after any repair
export { SandboxError, encodeSandboxErrorLine, decodeSandboxErrorLines, codeFromPrefixLine, SANDBOX_ERROR_SERVICE, SANDBOX_ERROR_PREFIX } from "./errors.ts"
export type { SandboxErrorCode, SandboxErrorLine } from "./errors.ts"
export { parseBinShell, resolveCommandShell } from "./shell.ts"
export type { BinShell } from "./shell.ts"
