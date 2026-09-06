import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { runProcess } from "../src/execution/process.ts"
import path from "node:path"
import { isNestedSandbox, testTempRoot } from "./helpers.ts"

const cwd = testTempRoot()
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined) {
    env[key] = value
  }
}

describe(
  "process runner",
  { skip: isNestedSandbox() ? "libuv spawn is unavailable inside the platform sandbox" : false },
  () => {
  test("captures exit code and output", async () => {
    const result = await runProcess({
      command: "cmd",
      args: ["/c", "echo hello & echo err 1>&2 & exit 7"],
      cwd,
      env,
    })
    assert.equal(result.exit_code, 7)
    assert.match(result.stdout, /hello/)
    assert.match(result.stderr, /err/)
  })

  test("enforces timeout and kills process tree", async () => {
    const result = await runProcess({
      command: "powershell",
      args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
      cwd,
      env,
      timeoutMs: 2000,
    })
    assert.equal(result.timed_out, true)
    assert.equal(result.cancelled, false)
    assert.ok(result.duration_ms < 15_000, `duration was ${result.duration_ms}`)
  })

  test("honors AbortSignal", async () => {
    const controller = new AbortController()
    const run = runProcess({
      command: "powershell",
      args: ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"],
      cwd,
      env,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 300)
    const result = await run
    assert.equal(result.cancelled, true)
    assert.equal(result.timed_out, false)
    assert.ok(result.duration_ms < 15_000)
  })

  test("truncates oversized output", async () => {
    const result = await runProcess({
      command: "cmd",
      args: ["/c", "for /l %i in (1,1,2000) do @echo line-%i"],
      cwd,
      env,
      maxOutputChars: 512,
    })
    assert.equal(result.stdout_truncated, true)
    assert.ok(result.stdout.endsWith("truncated at 512 chars]"))
  })
  },
)

