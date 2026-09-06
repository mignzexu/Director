import { test, describe, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { sanitizeEnvironment, platformTmpDir } from "../src/execution/environment.ts"
import path from "node:path"

const originalEnv = { ...process.env }

beforeEach(() => {
  process.env.AWS_ACCESS_KEY_ID = "AKIAFAKE"
  process.env.GITHUB_TOKEN = "ghp_fake"
  process.env.OPENAI_API_KEY = "sk-fake"
  process.env.USERPROFILE = "C:\\Users\\someone"
  process.env.APPDATA = "C:\\Users\\someone\\AppData\\Roaming"
})

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
})

describe("environment sanitization", () => {
  test("drops credential-like variables", () => {
    const env = sanitizeEnvironment({ tmpDir: "T:\\tmp" })
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined)
    assert.equal(env.GITHUB_TOKEN, undefined)
    assert.equal(env.OPENAI_API_KEY, undefined)
  })

  test("keeps only allowlisted variables", () => {
    const env = sanitizeEnvironment({ tmpDir: "T:\\tmp" })
    assert.ok(env.PATH)
    assert.ok(env.SystemRoot)
    assert.equal(env.USERPROFILE, undefined)
    assert.equal(env.APPDATA, undefined)
  })

  test("pins temp variables to platform tmp dir", () => {
    const env = sanitizeEnvironment({ tmpDir: "T:\\tmp" })
    assert.equal(env.TMPDIR, "T:\\tmp")
    assert.equal(env.TMP, "T:\\tmp")
    assert.equal(env.TEMP, "T:\\tmp")
  })

  test("drop patterns also apply to kept keys", () => {
    const env = sanitizeEnvironment({
      tmpDir: "T:\\tmp",
      keep: ["PATH", "MY_TOKEN"],
      dropPatterns: [/TOKEN$/i],
    })
    assert.ok(env.PATH)
    assert.equal(env.MY_TOKEN, undefined)
  })

  test("platformTmpDir nests under base", () => {
    assert.equal(platformTmpDir(path.join("C:", "base")), path.join("C:", "base", "tmp"))
  })
})
