import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ExecutionKernel } from "../src/execution/kernel.ts"
import { FileStateStore } from "../src/state/state-store.ts"
import { JsonlAuditLogger } from "../src/state/audit.ts"
import { makeTempWorkspace, removeTemp, LocalProcessBackend, testTempRoot, isNestedSandbox } from "./helpers.ts"

let dir: string
let workspace: string
let kernel: ExecutionKernel

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(testTempRoot(), "agent-platform-kernel-"))
  workspace = await makeTempWorkspace()
  const state = new FileStateStore(path.join(dir, "state"))
  const audit = new JsonlAuditLogger(path.join(dir, "state", "audit.jsonl"))
  kernel = new ExecutionKernel({
    backend: new LocalProcessBackend(),
    state,
    audit,
    defaultTimeoutMs: 10_000,
  })
})

afterEach(async () => {
  await removeTemp(dir)
  await removeTemp(workspace)
})

describe(
  "execution kernel",
  { skip: isNestedSandbox() ? "libuv spawn is unavailable inside the platform sandbox" : false },
  () => {
  test("returns structured result with exit code", async () => {
    const result = await kernel.exec(
      { command: "echo structured & exit 3" },
      { directory: workspace },
    )
    assert.equal(result.exit_code, 3)
    assert.match(result.stdout, /structured/)
    assert.equal(result.timed_out, false)
    assert.equal(result.cancelled, false)
    assert.equal(result.sandbox.network, false)
  })

  test("workspace write succeeds through kernel", async () => {
    const result = await kernel.exec(
      { command: "echo data > out.txt" },
      { directory: workspace },
    )
    assert.equal(result.exit_code, 0)
    const content = await fs.readFile(path.join(workspace, "out.txt"), "utf8")
    assert.match(content, /data/)
  })

  test("enforces timeout and reports timed_out", async () => {
    const result = await kernel.exec(
      { command: "powershell -NoProfile -Command Start-Sleep -Seconds 30", timeout_ms: 1500 },
      { directory: workspace },
    )
    assert.equal(result.timed_out, true)
    assert.ok(result.duration_ms < 15_000)
  })

  test("honors abort signal and reports cancelled", async () => {
    const controller = new AbortController()
    const promise = kernel.execWithSignal(
      { command: "powershell -NoProfile -Command Start-Sleep -Seconds 30" },
      { directory: workspace },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 300)
    const result = await promise
    assert.equal(result.cancelled, true)
  })

  test("writes audit record for every invocation", async () => {
    await kernel.exec({ command: "exit 5" }, { directory: workspace, sessionId: "s1", agent: "private" })
    const events = await readAudit(path.join(dir, "state", "audit.jsonl"))
    assert.equal(events.length, 1)
    assert.equal(events[0].capability, "shell.exec")
    assert.equal(events[0].exit_code, 5)
    assert.equal(events[0].session_id, "s1")
    assert.equal(events[0].agent, "private")
    assert.equal(events[0].approved, true)
  })

  test("rejects sandbox escalation in Phase 1", async () => {
    const result = await kernel.exec(
      { command: "echo hi", permissions: { network: true } },
      { directory: workspace },
    )
    assert.equal(result.exit_code, null)
    assert.match(result.error ?? "", /not supported in Phase 1/)
    const extraRead = await kernel.exec(
      { command: "echo hi", permissions: { read: ["C:\\shared"] } },
      { directory: workspace },
    )
    assert.match(extraRead.error ?? "", /not supported in Phase 1/)
    const events = await readAudit(path.join(dir, "state", "audit.jsonl"))
    assert.equal(events.length, 2)
  })

  test("reports backend failure as error result", async () => {
    const state = new FileStateStore(path.join(dir, "state2"))
    const audit = new JsonlAuditLogger(path.join(dir, "state2", "audit.jsonl"))
    const failing = new ExecutionKernel({
      backend: {
        name: "boom",
        exec: async () => {
          throw new Error("sandbox exploded")
        },
      },
      state,
      audit,
    })
    const result = await failing.exec({ command: "anything" }, { directory: workspace })
    assert.equal(result.error, "sandbox exploded")
    assert.equal(result.exit_code, null)
  })
  },
)

async function readAudit(file: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(file, "utf8")
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
