import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)))

function projectPath(...parts: string[]): string {
  return path.join(PROJECT_ROOT, ...parts)
}

interface Frontmatter {
  description?: string
  mode?: string
  permission?: Record<string, string>
}

async function parseFrontmatter(file: string): Promise<Frontmatter> {
  const raw = await fs.readFile(file, "utf8")
  const match = raw.match(/^---\n([\s\S]*?)\n---\n/)
  assert.ok(match, `frontmatter block missing in ${file}`)
  const frontmatter: Frontmatter = {}
  for (const line of match[1].split("\n")) {
    const top = line.match(/^([\w-]+):\s*(.*)$/)
    if (top) {
      const key = top[1]
      const value = top[2].trim()
      if (key === "permission") {
        frontmatter.permission = {}
      } else {
        ;(frontmatter as Record<string, string>)[key] = value
      }
      continue
    }
    const nested = line.match(/^\s+([\w-]+):\s*(.*)$/)
    if (nested && frontmatter.permission) {
      frontmatter.permission[nested[1]] = nested[2].trim()
    }
  }
  return frontmatter
}

describe("private agent registration", () => {
  test("agent definition file exists with primary mode", async () => {
    const file = projectPath(".opencode", "agents", "private.md")
    const frontmatter = await parseFrontmatter(file)
    assert.equal(frontmatter.mode, "primary")
    assert.ok(frontmatter.description && frontmatter.description.length > 0)
  })

  test("agent definition does not rely on prompt for security", async () => {
    const raw = await fs.readFile(projectPath(".opencode", "agents", "private.md"), "utf8")
    assert.ok(!raw.includes("do not read"), "prompt must not contain naive deny instructions")
  })

  test("permission config uses native bash (sandbox archived)", async () => {
    const file = projectPath(".opencode", "agents", "private.md")
    const frontmatter = await parseFrontmatter(file)
    assert.equal(frontmatter.permission?.bash, "allow", "private agent uses opencode native bash after sandbox archival")
    assert.ok(
      !("platform-exec" in (frontmatter.permission ?? {})),
      "platform-exec must be gone (sandbox archived to archive/sandbox/)",
    )
    assert.equal(frontmatter.permission?.["external_directory"], "deny")
    assert.equal(frontmatter.permission?.webfetch, "deny")
    assert.equal(frontmatter.permission?.websearch, "deny")
  })

  test("project opencode.json is valid", async () => {
    const raw = await fs.readFile(projectPath("opencode.json"), "utf8")
    const config = JSON.parse(raw) as { $schema?: string }
    assert.ok(config.$schema?.startsWith("https://opencode.ai"))
  })
})

describe("extension two-level routing", () => {
  test("L1 entry is the only opencode-side plugin and routes through the aggregator", async () => {
    const raw = await fs.readFile(projectPath(".opencode", "plugins", "agent-extensions.ts"), "utf8")
    assert.ok(raw.includes("AgentExtensionsPlugin"), "entry must export AgentExtensionsPlugin")
    assert.ok(raw.includes("composeExtensionHooks"), "entry must route through the L2 aggregator")
    assert.ok(raw.includes(".extensions/src/adapters/opencode/index.ts"), "entry must import the aggregator from .extensions")
  })

  test("L1 entry is a thin router (no business logic)", async () => {
    const raw = await fs.readFile(projectPath(".opencode", "plugins", "agent-extensions.ts"), "utf8")
    const lines = raw.split("\n").length
    assert.ok(lines < 40, `entry must stay thin, found ${lines} lines`)
  })

  test("L2 aggregator keeps a static registry (empty until a plugin registers)", async () => {
    const raw = await fs.readFile(projectPath(".extensions", "src", "adapters", "opencode", "index.ts"), "utf8")
    assert.ok(raw.includes("extensionRegistry"), "aggregator must expose the static registry")
    assert.ok(!/sandboxExtension/.test(raw), "archived sandbox plugin must not be registered")
  })

  test("archived sandbox code is out of the runtime tree", async () => {
    await assert.rejects(
      () => fs.access(projectPath(".extensions", "src", "execution")),
      "execution kernel must live only in archive/sandbox/",
    )
    await assert.rejects(
      () => fs.access(projectPath(".extensions", "src", "plugins", "sandbox")),
      "sandbox plugin must live only in archive/sandbox/",
    )
    await assert.rejects(
      () => fs.access(projectPath(".extensions", "runtime")),
      "AppContainer runtime must live only in archive/sandbox/runtime/",
    )
  })

  test("legacy override files are gone (additive, not parasitic)", async () => {
    await assert.rejects(
      () => fs.access(projectPath(".opencode", "tools", "bash.ts")),
      "the parasitic bash override must not exist",
    )
    await assert.rejects(
      () => fs.access(projectPath(".opencode", "plugins", "agent-platform.ts")),
      "the old platform plugin must not exist",
    )
  })

  test("runtime entry must not reference external agent runtimes", async () => {
    const raw = await fs.readFile(projectPath(".opencode", "plugins", "agent-extensions.ts"), "utf8")
    assert.ok(!/codex/i.test(raw), "L1 entry must not reference the codex CLI")
  })
})
