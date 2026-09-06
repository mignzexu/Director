import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { runProcess } from "../src/execution/process.ts"
import type {
  SandboxBackend,
  SandboxExecInput,
  SandboxExecResult,
} from "../src/execution/sandbox-backend.ts"
import { sandboxAvailable as windowsSandboxAvailable } from "../src/execution/windows-appcontainer-backend.ts"

function looksLikeAppContainerTemp(): boolean {
  const temp = process.env.TEMP ?? process.env.TMP ?? ""
  return /\\Packages\\[^\\]+\\AC\\/i.test(temp)
}

const IS_NESTED_SANDBOX = process.env.AGENT_PLATFORM_SANDBOXED === "1" || looksLikeAppContainerTemp()

export function isNestedSandbox(): boolean {
  return IS_NESTED_SANDBOX
}

export function testTempRoot(): string {
  if (IS_NESTED_SANDBOX) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".extensions", "tmp")
  }
  return os.tmpdir()
}

export class LocalProcessBackend implements SandboxBackend {
  readonly name = "local-process"
  async exec(input: SandboxExecInput): Promise<SandboxExecResult> {
    return runProcess({
      command: "cmd",
      args: ["/c", input.command],
      cwd: input.cwd,
      env: input.env,
      timeoutMs: input.timeoutMs,
      signal: input.signal,
      maxOutputChars: input.maxOutputChars,
    })
  }
}

export async function makeTempWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(testTempRoot(), "agent-platform-test-"))
  await fs.writeFile(path.join(dir, "readme.txt"), "hello", "utf8")
  await fs.mkdir(path.join(dir, ".git"), { recursive: true })
  await fs.writeFile(path.join(dir, ".git", "config"), "[core]\n", "utf8")
  return dir
}

export async function gitInit(dir: string): Promise<void> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  await runProcess({
    command: "git",
    args: ["init", "-q", dir],
    cwd: dir,
    env,
  })
}

export async function removeTemp(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

export function sandboxAvailable(): boolean {
  if (IS_NESTED_SANDBOX) {
    return false
  }
  return windowsSandboxAvailable()
}
