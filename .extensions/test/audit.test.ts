import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { JsonlAuditLogger } from "../src/state/audit.ts"
import { FileStateStore } from "../src/state/state-store.ts"
import type { AuditEvent } from "../src/core/types.ts"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-platform-audit-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("audit logger", () => {
  test("appends structured JSON lines", async () => {
    const logger = new JsonlAuditLogger(path.join(dir, "audit.jsonl"))
    const event: AuditEvent = {
      timestamp: "2026-09-02T00:00:00.000Z",
      session_id: "s1",
      agent: "private",
      capability: "shell.exec",
      command: "npm test",
      cwd: "D:\\work",
      permissions: { network: false },
      approved: true,
      exit_code: 0,
      duration_ms: 12,
    }
    await logger.record(event)
    const raw = await fs.readFile(path.join(dir, "audit.jsonl"), "utf8")
    assert.ok(raw.trimEnd().endsWith("}"))
    const all = await logger.readAll()
    assert.equal(all.length, 1)
    assert.equal(all[0].command, "npm test")
    assert.equal(all[0].exit_code, 0)
  })

  test("readAll returns empty for missing file", async () => {
    const logger = new JsonlAuditLogger(path.join(dir, "missing.jsonl"))
    assert.deepEqual(await logger.readAll(), [])
  })
})

describe("state store", () => {
  test("read/write roundtrip and traversal rejection", async () => {
    const store = new FileStateStore(path.join(dir, "state"))
    await store.write("agents.json", { count: 1 })
    const value = await store.read<{ count: number }>("agents.json")
    assert.equal(value?.count, 1)
    assert.equal(await store.exists("agents.json"), true)
    await assert.rejects(() => store.write("../escape.json", {}) )
  })
})
