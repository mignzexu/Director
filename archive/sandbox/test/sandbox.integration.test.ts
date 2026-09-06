import { test, describe, before, after } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ExecutionKernel } from "../src/execution/kernel.ts"
import { FileStateStore } from "../src/state/state-store.ts"
import { JsonlAuditLogger } from "../src/state/audit.ts"
import { WindowsAppContainerBackend } from "../src/execution/windows-appcontainer-backend.ts"
import { makeTempWorkspace, removeTemp, gitInit, sandboxAvailable } from "./helpers.ts"

const available = sandboxAvailable()

let dir: string
let workspace: string
let outside: string
let kernel: ExecutionKernel

before(async () => {
  if (!available) {
    return
  }
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-sbx-"))
  workspace = await makeTempWorkspace()
  await gitInit(workspace)
  outside = path.join(dir, "outside")
  await fs.mkdir(outside, { recursive: true })
  const state = new FileStateStore(path.join(dir, "state"))
  const audit = new JsonlAuditLogger(path.join(dir, "state", "audit.jsonl"))
  kernel = new ExecutionKernel({
    backend: new WindowsAppContainerBackend(),
    state,
    audit,
    defaultTimeoutMs: 20_000,
  })
})

after(async () => {
  if (!available) {
    return
  }
  await removeTemp(dir)
  await removeTemp(workspace)
})

function maybe(label: string, fn: () => Promise<void>): void {
  test(label, { skip: !available ? "project Windows sandbox not available" : false }, fn)
}

describe("project-owned Windows sandbox integration", () => {
  maybe("workspace write succeeds and is visible on host", async () => {
    const result = await kernel.exec(
      { command: "echo payload > from-sandbox.txt & type from-sandbox.txt" },
      { directory: workspace },
    )
    assert.equal(result.exit_code, 0, result.stderr)
    assert.match(result.stdout, /payload/)
    const content = await fs.readFile(path.join(workspace, "from-sandbox.txt"), "utf8")
    assert.match(content, /payload/)
  })

  maybe("outside-workspace write is denied", async () => {
    const target = path.join(outside, "escape.txt")
    const result = await kernel.exec(
      { command: `echo pwn > "${target}"` },
      { directory: workspace },
    )
    assert.notEqual(result.exit_code, 0, `expected denial, got: ${result.stdout}${result.stderr}`)
    assert.equal(await existsSafe(target), false)
  })

  maybe(".git is read-only", async () => {
    const gitConfig = path.join(workspace, ".git", "config")
    const readResult = await kernel.exec(
      { command: `type "${gitConfig}"` },
      { directory: workspace },
    )
    assert.equal(readResult.exit_code, 0, readResult.stderr)
    const writeResult = await kernel.exec(
      { command: `echo corrupt > "${gitConfig}"` },
      { directory: workspace },
    )
    assert.notEqual(writeResult.exit_code, 0, "write into .git must fail")
    const content = await fs.readFile(gitConfig, "utf8")
    assert.ok(!content.includes("corrupt"), ".git content must be unchanged")
  })

  maybe("credential locations are inaccessible", async () => {
    const sshConfig = path.join(os.homedir(), ".ssh", "config")
    if (await existsSafe(sshConfig)) {
      const result = await kernel.exec(
        { command: `type "${sshConfig}"` },
        { directory: workspace },
      )
      assert.notEqual(result.exit_code, 0, "reading ~/.ssh/config must fail")
    }
    const probe = path.join(os.homedir(), ".agent-platform-probe.txt")
    const writeResult = await kernel.exec(
      { command: `echo x > "${probe}"` },
      { directory: workspace },
    )
    assert.notEqual(writeResult.exit_code, 0, "writing into home directory must fail")
    assert.equal(await existsSafe(probe), false)
  })

  maybe("network is denied by default", async () => {
    const result = await kernel.exec(
      { command: "curl.exe -s -o NUL -m 8 -w %{http_code} https://example.com" },
      { directory: workspace },
    )
    assert.notEqual(result.exit_code, 0, "TCP connection must fail inside sandbox")
  })

  maybe("platform tmp dir is writable", async () => {
    const result = await kernel.exec(
      { command: "echo t > %TMPDIR%\\platform-probe.txt & type %TMPDIR%\\platform-probe.txt" },
      { directory: workspace },
    )
    assert.equal(result.exit_code, 0, result.stderr)
    assert.match(result.stdout, /t/)
  })

  maybe("timeout kills the sandboxed process tree", async () => {
    const result = await kernel.exec(
      {
        command: "powershell -NoProfile -Command Start-Sleep -Seconds 60",
        timeout_ms: 3000,
      },
      { directory: workspace },
    )
    assert.equal(result.timed_out, true)
    assert.ok(result.duration_ms < 15_000, `duration was ${result.duration_ms}`)
  })

  maybe("AbortSignal cancels the sandboxed process", async () => {
    const controller = new AbortController()
    const promise = kernel.execWithSignal(
      { command: "powershell -NoProfile -Command Start-Sleep -Seconds 60" },
      { directory: workspace },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 500)
    const result = await promise
    assert.equal(result.cancelled, true)
    assert.ok(result.duration_ms < 15_000)
  })

  maybe("structured result surfaces exit code and audit record", async () => {
    const result = await kernel.exec(
      { command: "cmd /c exit 9" },
      { directory: workspace, sessionId: "int-session" },
    )
    assert.equal(result.exit_code, 9)
    const events = await new JsonlAuditLogger(path.join(dir, "state", "audit.jsonl")).readAll()
    const last = events[events.length - 1]
    assert.equal(last?.capability, "shell.exec")
    assert.equal(last?.exit_code, 9)
    assert.equal(last?.session_id, "int-session")
    assert.equal(last?.permissions?.network, false)
  })
})

async function existsSafe(file: string): Promise<boolean> {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}
