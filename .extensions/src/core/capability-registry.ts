import type { Capability, CapabilityRegistry } from "./types.ts"

export class DefaultCapabilityRegistry implements CapabilityRegistry {
  private capabilities = new Map<string, Capability>()

  register(capability: Capability): void {
    if (this.capabilities.has(capability.id)) {
      throw new Error(`capability already registered: ${capability.id}`)
    }
    this.capabilities.set(capability.id, capability)
  }

  get(id: string): Capability {
    const capability = this.capabilities.get(id)
    if (!capability) {
      throw new Error(`unknown capability: ${id}`)
    }
    return capability
  }

  list(): Capability[] {
    return [...this.capabilities.values()]
  }
}
