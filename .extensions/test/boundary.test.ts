// 架构边界守卫（Phase 12 独立性收口）：把宿主解耦变成被测试锁定的制度。
//
// 三层边界：
//   A 固有层  src/runtime | src/state | src/core —— 零宿主依赖（node 内置 + 相对导入）
//   B 插件层  src/plugins —— 自有契约（ToolPort/ExtensionTool），零 @opencode-ai 引用
//   C 适配层  src/adapters —— 宿主 SDK 类型唯一允许的落点（.opencode/ 的 L1 同理）
// 换 coding CLI = 写一个新适配器；A/B 层零改动。
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const EXTENSIONS_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)))

async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "state" || entry.name === "tmp") {
        continue
      }
      files.push(...(await walk(full)))
    } else if (entry.name.endsWith(".ts")) {
      files.push(full)
    }
  }
  return files
}

async function assertNoHostImports(dir: string, label: string): Promise<void> {
  const files = await walk(dir)
  assert.ok(files.length > 0, `${label}: expected sources under ${dir}`)
  for (const file of files) {
    const raw = await fs.readFile(file, "utf8")
    assert.ok(
      !raw.includes("@opencode-ai"),
      `${label} boundary violated in ${path.relative(EXTENSIONS_ROOT, file)}: host SDK reference found`,
    )
  }
}

describe("architecture boundary (host independence)", () => {
  test("A: runtime/state/core are pure — no host SDK anywhere", async () => {
    await assertNoHostImports(path.join(EXTENSIONS_ROOT, "src", "runtime"), "runtime")
    await assertNoHostImports(path.join(EXTENSIONS_ROOT, "src", "state"), "state")
    await assertNoHostImports(path.join(EXTENSIONS_ROOT, "src", "core"), "core")
  })

  test("B: plugins use the own contract — no @opencode-ai imports at all", async () => {
    await assertNoHostImports(path.join(EXTENSIONS_ROOT, "src", "plugins"), "plugins")
  })

  test("C: host SDK types live only in the adapter layer", async () => {
    const adapterFiles = await walk(path.join(EXTENSIONS_ROOT, "src", "adapters"))
    assert.ok(adapterFiles.length > 0)
    for (const file of adapterFiles) {
      const raw = await fs.readFile(file, "utf8")
      assert.ok(raw.includes("@opencode-ai/plugin"), `adapter ${path.relative(EXTENSIONS_ROOT, file)} must own the host types`)
    }
  })

  test("ToolPort is the whole host surface tools may see (3 fields)", async () => {
    const raw = await fs.readFile(path.join(EXTENSIONS_ROOT, "src", "plugins", "types.ts"), "utf8")
    assert.match(raw, /interface ToolPort \{/)
    assert.match(raw, /agent: string/)
    assert.match(raw, /sessionID: string/)
    assert.match(raw, /directory: string/)
    // 收口面不得悄悄变大：宿主 ToolContext 的其余字段不许进入契约
    assert.ok(!raw.includes("worktree:"), "ToolPort must not grow host fields silently")
    assert.ok(!raw.includes("ask("), "ToolPort must not grow host fields silently")
  })

  test("the adapter maps host ToolContext into ToolPort", async () => {
    const raw = await fs.readFile(path.join(EXTENSIONS_ROOT, "src", "adapters", "opencode", "index.ts"), "utf8")
    assert.match(raw, /function toPort/)
    assert.match(raw, /toHostTool/)
  })
})
