export type SoapStats = {
  cwd: string
  model: string
  contextPercent: number | null
  costUsd: number | null
  turns: number
  toolCalls: number
  lastTool: string
}

declare module 'claude-code' {
  interface PluginState {
    'soap-mods': { stats: SoapStats }
  }
}
