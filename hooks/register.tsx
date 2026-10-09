import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SoapStats } from '../types'

// ───── 想改面板內容，只要改這一區 ─────
const PANE = 'soap-panel'
const PANEL_TITLE = 'Soap Panel'

// 每一行：左邊的標籤 + 右邊的值。增減、改順序都可以。
const LINES: { label: string; value: (s: SoapStats) => string }[] = [
  { label: '目錄', value: s => s.cwd },
  { label: '模型', value: s => s.model || '-' },
  { label: 'Context', value: s => (s.contextPercent === null ? '-' : `${s.contextPercent}%`) },
  { label: '花費', value: s => (s.costUsd === null ? '-' : `$${s.costUsd.toFixed(2)}`) },
  { label: '回合數', value: s => String(s.turns) },
  { label: '工具次數', value: s => String(s.toolCalls) },
  { label: '最近工具', value: s => s.lastTool || '-' },
]
// ───── 以下是運作邏輯，通常不用動 ─────

const initial: SoapStats = {
  cwd: '',
  model: '',
  contextPercent: null,
  costUsd: null,
  turns: 0,
  toolCalls: 0,
  lastTool: '',
}
const stats = atom({ plugin: 'soap-mods', key: 'stats' } as const, initial)

// 從引擎讀取最新的 session 資訊，寫進 atom（面板會自動重畫）
async function refresh($: EngineInterface) {
  const [cwd, model, usage] = await Promise.all([
    $.session.cwd(),
    $.session.model(),
    $.session.usage(),
  ])
  await update($, stats, s => ({
    ...s,
    cwd,
    model,
    contextPercent: usage.context.percent ?? null,
    costUsd: usage.cost?.usd ?? null,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'soap-panel',
      description: '開啟 Soap Panel（session 資訊面板）',
    })
    await refresh($)
    void $.ui.open({ id: PANE, title: PANEL_TITLE })

    return next(e)
  })

  on('command.run', { command: 'soap-panel' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: PANEL_TITLE })

    return { text: 'Soap Panel 已開啟。' }
  })

  on('tool.call', async ($, e, next) => {
    await update($, stats, s => ({ ...s, toolCalls: s.toolCalls + 1, lastTool: e.tool }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, stats, s => ({ ...s, turns: s.turns + 1 }))
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = await read($, stats)

    return (
      <Box flexDirection="column">
        <Text bold>{PANEL_TITLE}</Text>
        {LINES.map(line => (
          <Text>
            <Text dimColor>{line.label}：</Text>
            {line.value(s)}
          </Text>
        ))}
      </Box>
    )
  })
}
