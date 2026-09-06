import { test, describe } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { SandboxError } from "../src/capabilities/sandbox/errors.ts"
import { parseBinShell, resolveCommandShell } from "../src/capabilities/sandbox/shell.ts"

const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const defaultCmd = path.win32.join(systemRoot, "System32", "cmd.exe")

describe("bin shell normalization", () => {
  test("default resolves to System32 cmd.exe", () => {
    const shell = parseBinShell(undefined)
    assert.equal(shell.exe.toLowerCase(), defaultCmd.toLowerCase())
    assert.deepEqual(shell.args, ["/d", "/s", "/c"])
  })

  test("null/empty falls back to the default", () => {
    assert.equal(parseBinShell(null).exe.toLowerCase(), defaultCmd.toLowerCase())
    assert.equal(parseBinShell("").exe.toLowerCase(), defaultCmd.toLowerCase())
    assert.equal(parseBinShell("   ").exe.toLowerCase(), defaultCmd.toLowerCase())
  })

  test("bare cmd token and absolute cmd.exe both resolve with cmd flags", () => {
    assert.deepEqual(parseBinShell("cmd").args, ["/d", "/s", "/c"])
    const abs = parseBinShell("D:\\tools\\cmd.exe")
    assert.equal(abs.exe, "D:\\tools\\cmd.exe")
    assert.deepEqual(abs.args, ["/d", "/s", "/c"])
  })

  test("powershell token resolves to the WindowsPowerShell install", () => {
    const shell = parseBinShell("powershell")
    assert.equal(
      shell.exe.toLowerCase(),
      path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe").toLowerCase(),
    )
    assert.deepEqual(shell.args, ["-NoProfile", "-Command"])
  })

  test("pwsh token resolves with profile-free flags", () => {
    const shell = parseBinShell("pwsh")
    assert.equal(shell.exe, "pwsh.exe")
    assert.deepEqual(shell.args, ["-NoProfile", "-Command"])
  })

  test("relative path with directory component is rejected, never degraded", () => {
    assert.throws(() => parseBinShell("bin\\bash.exe"), (err: unknown) => {
      assert.ok(err instanceof SandboxError)
      assert.equal((err as SandboxError).code, "shell_invalid")
      return true
    })
  })

  test("unrecognised shells are rejected with a typed error", () => {
    for (const raw of ["bash", "zsh", "D:\\shells\\bash.exe", "make"]) {
      assert.throws(() => parseBinShell(raw), (err: unknown) => {
        assert.ok(err instanceof SandboxError)
        assert.equal((err as SandboxError).code, "shell_invalid")
        return true
      })
    }
  })
})

describe("command shell resolution (Windows backend contract)", () => {
  test("accepts an absolute cmd.exe path", () => {
    assert.equal(resolveCommandShell("C:\\Windows\\system32\\cmd.exe"), "C:\\Windows\\system32\\cmd.exe")
  })

  test("accepts the default when input is absent", () => {
    assert.equal(resolveCommandShell(undefined).toLowerCase(), defaultCmd.toLowerCase())
  })

  test("rejects non-cmd shells — POSIX shells change command semantics", () => {
    assert.throws(() => resolveCommandShell("pwsh"), (err: unknown) => {
      assert.ok(err instanceof SandboxError)
      assert.equal((err as SandboxError).code, "shell_invalid")
      return true
    })
    assert.throws(() => resolveCommandShell("powershell"), /cmd\.exe/)
  })
})
