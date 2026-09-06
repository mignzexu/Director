import { test, describe } from "node:test"
import assert from "node:assert/strict"
import {
  SANDBOX_ERROR_PREFIX,
  SANDBOX_ERROR_SERVICE,
  codeFromPrefixLine,
  decodeSandboxErrorLines,
  encodeSandboxErrorLine,
} from "../src/capabilities/sandbox/errors.ts"

describe("sandbox error codec", () => {
  test("encode/decode roundtrip", () => {
    const line = encodeSandboxErrorLine("verify_failed", "protection probe contradicted policy")
    const decoded = decodeSandboxErrorLines(line)
    assert.equal(decoded.length, 1)
    assert.equal(decoded[0].svc, SANDBOX_ERROR_SERVICE)
    assert.equal(decoded[0].code, "verify_failed")
    assert.equal(decoded[0].message, "protection probe contradicted policy")
    assert.ok(decoded[0].ts)
  })

  test("decodes the last structured line from mixed command output", () => {
    const stderr = [
      "some command noise that looks like { json: but is not ours",
      encodeSandboxErrorLine("internal_error", "first failure"),
      "Access is denied.",
      encodeSandboxErrorLine("verify_network_open", "probe connected"),
    ].join("\r\n")
    const decoded = decodeSandboxErrorLines(stderr)
    assert.equal(decoded.length, 2)
    assert.equal(decoded[decoded.length - 1].code, "verify_network_open")
  })

  test("ignores foreign JSON objects and malformed lines", () => {
    const stderr = [
      '{"svc":"someone-else","code":"x","message":"y"}',
      "{not json at all",
      JSON.stringify({ code: "verify_failed", message: "missing svc field" }),
      "",
    ].join("\n")
    assert.deepEqual(decodeSandboxErrorLines(stderr), [])
  })

  test("empty stderr decodes to nothing", () => {
    assert.deepEqual(decodeSandboxErrorLines(""), [])
  })

  test("prefix line remains parseable for legacy consumers", () => {
    const line = `${SANDBOX_ERROR_PREFIX} [shell_invalid] comspec must be cmd.exe`
    assert.ok(line.startsWith(SANDBOX_ERROR_PREFIX))
    assert.equal(codeFromPrefixLine(line), "shell_invalid")
  })

  test("codeFromPrefixLine tolerates legacy prefix without code bracket", () => {
    assert.equal(codeFromPrefixLine(`${SANDBOX_ERROR_PREFIX} old-style message`), undefined)
  })
})
