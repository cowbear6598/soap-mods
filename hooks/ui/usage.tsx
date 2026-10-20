import { ACTIVE_BG, DANGER, GOOD, USAGE_BAR_EMPTY, USAGE_BAR_FULL, USAGE_BAR_PX, USAGE_WINDOWS, WARN } from '../config'
import type { UsageReading } from './actions'
import { stretchedSvg } from './svg'
import type { Widgets } from './widgets'

function usageLevel(remaining: number) {
  return remaining > 50 ? GOOD : remaining > 20 ? WARN : DANGER
}

// 離重置還有多久：「2d 18h 5m」「2h 26m」「12m」；沒有重置時間就回空字串。
function formatResetIn(resetsAt: string | undefined, now: number) {
  if (resetsAt === undefined) return ''
  const ms = Date.parse(resetsAt) - now
  if (Number.isNaN(ms)) return ''
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`

  return `${m}m`
}

// windows：引擎給的用量讀數；讀不到時是空的，每一半都畫「—」。
export function usageBar(w: Widgets, windows: readonly UsageReading[], now: number) {
  const { Box, Text } = w

  // 終端機的文字 bar：剩餘、用掉的各一格百分比寬的 Box，裡面一長串方塊被裁到那個寬度，填滿那一半。
  const segment = (width: number, glyphs: string, color: string) => (
    <Box width={`${width}%`} height={1} overflow="hidden">
      <Text color={color}>{glyphs}</Text>
    </Box>
  )
  // 百分比寬只收整數：rounded 是四捨五入過的剩餘。
  const textBar = (rounded: number, color: string) => (
    <Box width="100%">
      {segment(rounded, USAGE_BAR_FULL, color)}
      {segment(100 - rounded, USAGE_BAR_EMPTY, color)}
    </Box>
  )

  // 其中一半：「5h · 93% · 2h 26m」一行，下面一條剩餘用量的 bar；還沒有讀數就是「5h · —」。
  const half = (u: (typeof USAGE_WINDOWS)[number]) => {
    const reading = windows.find(r => r.kind === u.kind)
    const remaining = reading === undefined ? 0 : Math.max(0, Math.min(100, 100 - reading.percentUsed))
    const rounded = Math.round(remaining)
    const percent = `${rounded}%`
    const resetIn = reading === undefined ? '' : formatResetIn(reading.resetsAt, now)
    const level = usageLevel(remaining)

    return (
      <Box key={`usage:${u.kind}`} width="50%" flexDirection="column" paddingX={1}>
        <Box>
          <Text dimColor>{`${u.label} · `}</Text>
          {reading === undefined ? (
            <Text dimColor>—</Text>
          ) : (
            <Text bold color={level.theme}>
              {percent}
            </Text>
          )}
          {resetIn !== '' && <Text dimColor>{` · ${resetIn}`}</Text>}
        </Box>
        {reading !== undefined &&
          (w.hasSvg
            ? w.stretched(
                stretchedSvg(USAGE_BAR_PX, [
                  { width: 100, fill: ACTIVE_BG },
                  { width: remaining, fill: level.hex },
                ]),
                `${percent} left`,
                USAGE_BAR_PX,
              )
            : textBar(rounded, level.theme))}
      </Box>
    )
  }

  return <Box width="100%">{USAGE_WINDOWS.map(half)}</Box>
}
