// Functional tests for the L2 routing layer, using mock plugins.
// These verify the Extension machinery itself — tool aggregation, id
// uniqueness, event fan-out, and failure isolation — independently of any
// real enhancement plugin.
import { test, describe } from "node:test"
import assert from "node:assert/strict"
import { composeExtensionHooks, extensionRegistry, extensionPluginIds } from "../src/adapters/opencode/index.ts"
import type { ExtensionPlugin, ExtensionPluginContext } from "../src/plugins/types.ts"

const host = {
  directory: "D:\\proj",
  worktree: "D:\\proj",
  log: (() => {}) as ExtensionPluginContext["log"],
}

function makePlugin(id: string, overrides: Partial<ExtensionPlugin> = {}): ExtensionPlugin {
  return {
    id,
    description: `${id} mock plugin`,
    ...overrides,
  }
}

describe("extension routing registry (default)", () => {
  test("default registry routes both active plugins in registration order", () => {
    assert.deepEqual(extensionPluginIds(), ["runtime-ledger", "flight-recorder"])
    assert.equal(extensionRegistry.length, 2)
  })
})

describe("extension routing composition (mock plugins)", () => {
  test("aggregates tools from multiple plugins with namespacing by id map", async () => {
    const a = makePlugin("alpha", { tools: { "alpha-tool": { description: "a", args: {}, execute: async () => "a" } } })
    const b = makePlugin("beta", { tools: { "beta-tool": { description: "b", args: {}, execute: async () => "b" } } })
    const hooks = await composeExtensionHooks(host, [a, b])
    assert.deepEqual(Object.keys(hooks.tools).sort(), ["alpha-tool", "beta-tool"])
    assert.deepEqual(hooks.ids, ["alpha", "beta"])
  })

  test("duplicate tool id across plugins is a hard error", async () => {
    const a = makePlugin("alpha", { tools: { shared: { description: "a", args: {}, execute: async () => "a" } } })
    const b = makePlugin("beta", { tools: { shared: { description: "b", args: {}, execute: async () => "b" } } })
    await assert.rejects(
      () => composeExtensionHooks(host, [a, b]),
      /duplicate extension tool id: shared/,
    )
  })

  test("plugins without tools compose fine", async () => {
    const hooks = await composeExtensionHooks(host, [makePlugin("listener")])
    assert.deepEqual(hooks.tools, {})
    assert.deepEqual(hooks.ids, ["listener"])
  })

  test("event fan-out reaches every plugin", async () => {
    const seen: string[] = []
    const a = makePlugin("alpha", { onEvent: (event) => { seen.push(`alpha:${event.type}`) } })
    const b = makePlugin("beta", { onEvent: (event) => { seen.push(`beta:${event.type}`) } })
    const hooks = await composeExtensionHooks(host, [a, b])
    await hooks.onEvent({ type: "session.created" })
    assert.deepEqual(seen, ["alpha:session.created", "beta:session.created"])
  })

  test("one plugin's event failure does not isolate the others", async () => {
    const seen: string[] = []
    const logs: string[] = []
    const loggingHost = { ...host, log: (level: "debug" | "warn" | "error", message: string) => { logs.push(`${level}:${message}`) } }
    const bad = makePlugin("bad", { onEvent: () => { throw new Error("boom") } })
    const good = makePlugin("good", { onEvent: (event) => { seen.push(event.type) } })
    const hooks = await composeExtensionHooks(loggingHost, [bad, good])
    await hooks.onEvent({ type: "session.created" })
    assert.deepEqual(seen, ["session.created"])
    assert.ok(logs.some((entry) => entry.startsWith("warn:extension 'bad' event hook failed")), logs.join("|"))
  })

  test("setup failures are logged and non-fatal", async () => {
    const logs: string[] = []
    const loggingHost = { ...host, log: (level: "debug" | "warn" | "error", message: string) => { logs.push(`${level}:${message}`) } }
    const a = makePlugin("broken-setup", { setup: () => { throw new Error("setup exploded") } })
    const hooks = await composeExtensionHooks(loggingHost, [a])
    assert.deepEqual(hooks.ids, ["broken-setup"])
    assert.ok(logs.some((entry) => entry.startsWith("error:extension 'broken-setup' setup failed")), logs.join("|"))
  })

  test("plugin context carries directory/worktree", async () => {
    let captured: ExtensionPluginContext | undefined
    const a = makePlugin("probe", {
      setup: (ctx) => { captured = ctx },
    })
    await composeExtensionHooks(host, [a])
    assert.equal(captured?.directory, "D:\\proj")
    assert.equal(captured?.worktree, "D:\\proj")
    assert.equal(typeof captured?.log, "function")
  })
})
