import type { HarnessId } from './types'

export type CapabilitySupport = 'yes' | 'partial' | 'no'

export interface HarnessCapabilities {
  /** 运行中插入引导消息（Steer） */
  steer: CapabilitySupport
  /** 运行中排队追加指令（Follow-up） */
  followUp: CapabilitySupport
  /** 手动上下文压缩 Compact */
  compact: CapabilitySupport
  /** Thinking / Reasoning 档位切换 */
  thinking: CapabilitySupport
  /** 会话内模型热切换 */
  modelSwitch: CapabilitySupport
  /** 原生分叉 / 分支树 */
  fork: CapabilitySupport
  /** 扩展审批弹窗（extension UI / 权限请求） */
  extensionUi: CapabilitySupport
  /** 上下文 token 用量统计 */
  contextStats: CapabilitySupport
  /** CLI 历史会话扫描与回放 */
  historyReplay: CapabilitySupport
  /** 图片附件输入 */
  images: CapabilitySupport
  /** 斜杠命令发现 */
  slashCommands: CapabilitySupport
}

export const HARNESS_CAPABILITIES: Record<HarnessId, HarnessCapabilities> = {
  pi: {
    steer: 'yes',
    followUp: 'yes',
    compact: 'yes',
    thinking: 'yes',
    modelSwitch: 'yes',
    fork: 'yes',
    extensionUi: 'yes',
    contextStats: 'yes',
    historyReplay: 'yes',
    images: 'yes',
    slashCommands: 'yes',
  },
  omp: {
    steer: 'yes',
    followUp: 'yes',
    compact: 'yes',
    thinking: 'yes',
    modelSwitch: 'yes',
    fork: 'yes',
    extensionUi: 'yes',
    contextStats: 'yes',
    historyReplay: 'yes',
    images: 'yes',
    slashCommands: 'yes',
  },
  prime: {
    steer: 'yes',
    followUp: 'yes',
    compact: 'yes',
    thinking: 'yes',
    modelSwitch: 'yes',
    fork: 'partial',
    extensionUi: 'partial',
    contextStats: 'partial',
    historyReplay: 'yes',
    images: 'yes',
    slashCommands: 'yes',
  },
  claude: {
    steer: 'partial',
    followUp: 'partial',
    compact: 'yes',
    thinking: 'partial',
    modelSwitch: 'yes',
    fork: 'no',
    extensionUi: 'yes',
    contextStats: 'partial',
    historyReplay: 'partial',
    images: 'yes',
    slashCommands: 'partial',
  },
  codex: {
    steer: 'yes',
    followUp: 'no',
    compact: 'yes',
    thinking: 'partial',
    modelSwitch: 'yes',
    fork: 'partial',
    extensionUi: 'yes',
    contextStats: 'yes',
    historyReplay: 'no',
    images: 'yes',
    slashCommands: 'no',
  },
  acp: {
    steer: 'no',
    followUp: 'no',
    compact: 'no',
    thinking: 'no',
    modelSwitch: 'partial',
    fork: 'no',
    extensionUi: 'yes',
    contextStats: 'no',
    historyReplay: 'no',
    images: 'partial',
    slashCommands: 'yes',
  },
  dsh: {
    steer: 'no',
    followUp: 'no',
    compact: 'no',
    thinking: 'no',
    modelSwitch: 'partial',
    fork: 'no',
    extensionUi: 'yes',
    contextStats: 'no',
    historyReplay: 'no',
    images: 'partial',
    slashCommands: 'yes',
  },
}

export const CAPABILITY_LABELS: { key: keyof HarnessCapabilities; label: string }[] = [
  { key: 'steer', label: 'Steer 引导' },
  { key: 'followUp', label: 'Follow-up 排队' },
  { key: 'compact', label: 'Compact 压缩' },
  { key: 'thinking', label: 'Thinking 档位' },
  { key: 'modelSwitch', label: '模型热切换' },
  { key: 'fork', label: '分叉 / 分支树' },
  { key: 'extensionUi', label: '内嵌审批' },
  { key: 'contextStats', label: '上下文统计' },
  { key: 'historyReplay', label: '历史回放' },
  { key: 'images', label: '图片输入' },
  { key: 'slashCommands', label: '斜杠命令' },
]

/** Notes shown under the capability matrix for bridged engines. */
export const CAPABILITY_NOTES: Partial<Record<HarnessId, string>> = {
  prime: 'Rust 版（0.9.9+）拒绝 --extension，扩展审批与部分统计不可用；TS 版全量支持。',
  claude: 'Thinking 档位在重新连接后生效；Steer/Follow-up 以排队消息实现；历史回放读取 ~/.claude/projects 会话文件。',
  codex: '基于 app-server v2 协议（thread/turn/item）；Thinking 映射为模型默认 reasoning effort；历史回放暂不支持。',
  acp: '通用 Agent Client Protocol v1 接入（gemini --experimental-acp / qwen / claude-code-acp 等），能力取决于具体 Agent。',
  dsh: '通过 dsh --profile acp 的 ACP stdio 接入；模型与上下文由 dsh profile 管理。',
}
