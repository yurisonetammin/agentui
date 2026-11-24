/**
 * Pure helper to detect and summarize subagent / delegated-agent tool calls
 * across Claude Code (Task / Agent), OMP (subagent), Pi, Codex, and ACP engines.
 */

import type { ToolCallItem } from './types'

export interface SubagentCallInfo {
  role: string
  description: string
  prompt?: string
  model?: string
  status: 'running' | 'success' | 'error'
  durationMs?: number
}

const SUBAGENT_TOOL_NAME_RE =
  /^(task|agent|subagent|spawn_agent|dispatch_agent|invoke_subagent|delegate|delegate_task|run_subagent|parallel_agents?)$/i

function str(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined
  const trimmed = val.trim()
  return trimmed || undefined
}

export function extractSubagentInfo(tool: ToolCallItem): SubagentCallInfo | null {
  const args = tool.args ?? {}
  const nameMatches = SUBAGENT_TOOL_NAME_RE.test(tool.name.trim())
  const explicitRole =
    str(args.subagent_type) ??
    str(args.subagentType) ??
    str(args.agent_type) ??
    str(args.agentType) ??
    str(args.role) ??
    str(args.agent)

  if (!nameMatches && !explicitRole) return null
  if (!nameMatches && !str(args.prompt) && !str(args.task) && !str(args.description)) {
    return null
  }

  const prompt = str(args.prompt) ?? str(args.task) ?? str(args.instructions) ?? str(args.message)
  const rawDesc =
    str(args.description) ??
    str(args.title) ??
    str(args.goal) ??
    str(args.summary) ??
    (prompt ? prompt.split(/\r?\n/)[0]!.slice(0, 90) : undefined) ??
    tool.name

  const role = explicitRole ?? str(args.type) ?? str(args.name) ?? tool.name
  const model = str(args.model) ?? str(args.model_id)

  return {
    role,
    description: rawDesc,
    prompt,
    model,
    status: tool.status,
    durationMs: tool.durationMs,
  }
}
