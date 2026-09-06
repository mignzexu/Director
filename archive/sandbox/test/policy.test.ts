import { test, describe } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { defaultSandboxPolicy, isPathWithin, isGitPath } from "../src/execution/policy.ts"

describe("sandbox policy", () => {
  test("defaults deny network and grant no extra roots", () => {
    const policy = defaultSandboxPolicy({ workspace: "D:\\work" })
    assert.equal(policy.network, false)
    assert.deepEqual(policy.readRoots, [])
    assert.deepEqual(policy.writeRoots, [])
    assert.equal(policy.workspace, path.resolve("D:\\work"))
  })

  test("explicit permissions override defaults", () => {
    const policy = defaultSandboxPolicy({
      workspace: "D:\\work",
      network: true,
      readRoots: ["C:\\shared"],
      writeRoots: ["D:\\out"],
    })
    assert.equal(policy.network, true)
    assert.deepEqual(policy.readRoots, ["C:\\shared"])
    assert.deepEqual(policy.writeRoots, ["D:\\out"])
  })

  test("isPathWithin handles case, separators and traversal", () => {
    assert.equal(isPathWithin("D:\\work", "D:\\work\\src\\a.ts"), true)
    assert.equal(isPathWithin("D:\\work", "d:\\WORK\\src"), true)
    assert.equal(isPathWithin("D:\\work", "D:\\work"), true)
    assert.equal(isPathWithin("D:\\work", "D:\\work2"), false)
    assert.equal(isPathWithin("D:\\work", "D:\\other"), false)
    assert.equal(isPathWithin("D:/work", "D:/work/sub"), true)
  })

  test("isGitPath identifies .git subtree", () => {
    assert.equal(isGitPath("D:\\work", "D:\\work\\.git\\config"), true)
    assert.equal(isGitPath("D:\\work", "D:\\work\\.git"), true)
    assert.equal(isGitPath("D:\\work", "D:\\work\\.gitignore"), false)
    assert.equal(isGitPath("D:\\work", "D:\\work\\src"), false)
  })
})
