// flight-recorder 测试：宿主事件流 → 黑匣子落账。
// 覆盖：completed/error 采集、自有工具过滤、pending/running 忽略、
// 畸形事件静默跳过、真实聚合器下的双插件扇出（runtime-ledger 同场）。
import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { composeExtensionHooks } from "../src/adapters/opencode/index.ts"
import { createFlightRecorderExtension } from "../src/plugins/flight-recorder/index.ts"
import { createRuntimeLedgerExtension } from "../src/plugins/runtime-ledger/index.ts"
import type { ExtensionPluginContext } from "../src/plugins/types.ts"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "dpn-flight-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function host(): { directory: string; worktree: string; log: ExtensionPluginContext["log"] } {
  return { directory: dir, worktree: dir, log: () => {} }
}

function toolUpdated(tool: string, status: string, extra: Record<string, unknown> = {}): ExtensionPluginEventLike {
  return {
    type: "message.part.updated",
    properties: {
      part: { type: "tool", tool, state: { status, ...extra } },
    },
  }
}

interface ExtensionPluginEventLike {
  type: string
  properties?: Record<string, unknown>
}

async function actionsCount(): Promise<number> {
  const raw = await fs.readFile(path.join(dir, ".extensions", "state", "runtime", "events.jsonl"), "utf8")
  return raw
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "action.executed").length
}

describe("flight-recorder", () => {
  test("completed and error executions are recorded with tails; own tools and pending are filtered", async () => {
    const hooks = await composeExtensionHooks(host(), [createFlightRecorderExtension()])
    const onEvent = hooks.onEvent!
    const ctx: ExtensionPluginContext = { directory: dir, worktree: dir, log: () => {} }

    await onEvent(toolUpdated("bash", "completed", { output: "3 tests passed\n" }))
    await onEvent(toolUpdated("bash", "error", { error: "command not found" }))
    await onEvent(toolUpdated("edit", "completed", { output: "", title: "patched foo.ts" }))
    // 过滤面
    await onEvent(toolUpdated("fact-record", "completed", { output: "self" })) // 自有域：跳过
    await onEvent(toolUpdated("verify-run", "completed", { output: "witnessed" })) // 验证动作：保留
    await onEvent(toolUpdated("bash", "running", { output: "x" })) // 未完成：跳过
    await onEvent(toolUpdated("bash", "pending", {})) // 未完成：跳过
    // 畸形事件：静默跳过
    await onEvent({ type: "message.part.updated", properties: { part: { type: "text" } } })
    await onEvent({ type: "message.part.updated" })
    await onEvent({ type: "session.created", properties: {} })

    assert.equal(await actionsCount(), 4, "2 completed + 1 error + verify-run recorded, others filtered")
  })

  test("recorded action carries tool name, ok flag and output tail", async () => {
    const hooks = await composeExtensionHooks(host(), [createFlightRecorderExtension()])
    const ctx: ExtensionPluginContext = { directory: dir, worktree: dir, log: () => {} }
    await hooks.onEvent!(toolUpdated("bash", "completed", { output: "line1\nline2\n" }))
    const raw = await fs.readFile(path.join(dir, ".extensions", "state", "runtime", "events.jsonl"), "utf8")
    const event = JSON.parse(raw.trim().split("\n").find((l) => l.includes("action.executed"))!)
    assert.equal(event.type, "action.executed")
    assert.equal(event.source, "flight-recorder")
    assert.equal(event.payload.name, "bash")
    assert.equal(event.payload.ok, true)
    assert.match(event.payload.outcome, /line2/)
  })

  test("coexists with runtime-ledger in the registry: both plugins fan out", async () => {
    const hooks = await composeExtensionHooks(host(), [createFlightRecorderExtension(), createRuntimeLedgerExtension()])
    assert.deepEqual(hooks.ids, ["flight-recorder", "runtime-ledger"])
    assert.deepEqual(Object.keys(hooks.tools).sort(), [
      "director-review",
      "director-tick",
      "fact-query",
      "fact-record",
      "memory-recall",
      "memory-record",
      "plan-node",
      "plan-query",
      "research-hypothesis",
      "research-query",
      "research-question",
      "solver-query",
      "solver-report",
      "solver-spawn",
      "verify-run",
    ])

    // 同一账本：ledger 工具记账 + recorder 采集宿主工具，互不干扰
    const ctx: ExtensionPluginContext = { directory: dir, worktree: dir, log: () => {} }
    const t = (id: string) => hooks.tools[id] as { execute(args: unknown, c: ToolContext): Promise<ToolResult> }
    const hostCtx: ToolContext = {
      sessionID: "s1",
      messageID: "m1",
      agent: "private",
      directory: dir,
      worktree: dir,
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {},
    }
    await t("fact-record").execute(
      { entity: "co", property: "exist", action: "observed", value: true, evidenceType: "external" },
      hostCtx,
    )
    await hooks.onEvent!(toolUpdated("bash", "completed", { output: "ok" }))
    const raw = await fs.readFile(path.join(dir, ".extensions", "state", "runtime", "events.jsonl"), "utf8")
    const types = raw.trim().split("\n").map((l) => JSON.parse(l).type)
    assert.ok(types.includes("fact.observed"), "ledger tool wrote its event")
    assert.ok(types.includes("action.executed"), "recorder wrote its event")
  })
})
