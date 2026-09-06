// AgentPlatform —— 平台接口（Phase 12 诚实化收口）。
//
// 真实槽位（本仓库实现）：
//   capabilities —— 能力注册表（宿主权限键管理工具准入）
//   runtime      —— DPN-AOR Core Runtime：事件账本 / World State / DPN /
//                   Solver / Director 制度 / Evidence / Memory / Research
//                   （原蓝图拆分的 verification / memory / tasks 等子系统
//                   均以事件溯源形态承载于 runtime，不再单列假占位）
//   state        —— 通用 JSON 状态存储
//   audit        —— 执行层审计（verify-run 等本地副作用记录）
//
// 已让渡宿主（原占位已移除，见《初衷.md》易腐性原则）：
//   execution（沙箱 → openchamber）、permissions（宿主原生权限键）、
//   agents（宿主 Agent Registry）、context（宿主会话 + shieldContract 推导）、
//   models（模型路由为调试阶段候选）
import type { CapabilityRegistry, AuditLogger, StateStore } from "./types.ts"
import type { DpnRuntime } from "../runtime/index.ts"

export interface AgentPlatform {
  readonly name: string
  readonly directory: string
  capabilities: CapabilityRegistry
  runtime: DpnRuntime
  state: StateStore
  audit: AuditLogger
}

export function createAgentPlatform(input: {
  directory: string
  capabilities: CapabilityRegistry
  runtime: DpnRuntime
  state: StateStore
  audit: AuditLogger
}): AgentPlatform {
  return {
    name: "agent-extensions",
    directory: input.directory,
    capabilities: input.capabilities,
    runtime: input.runtime,
    state: input.state,
    audit: input.audit,
  }
}
