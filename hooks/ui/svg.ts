import type { IconName } from '../config'
import { ACTIVE_ICON, DIVIDER_PX, ICONS, ICON_PX, MUTED } from '../config'

// 拉滿整行寬的橫條圖：依序疊上幾條從左邊開始的色條，width 是佔整行的百分比。分隔線和用量 bar 都用它。
export function stretchedSvg(heightPx: number, bars: { width: number; fill: string }[]) {
  const rects = bars.map(b => `<rect width="${b.width}" height="1" fill="${b.fill}"/>`).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_PX}" height="${heightPx}" viewBox="0 0 100 1" preserveAspectRatio="none">${rects}</svg>`
}

export const DIVIDER_SVG = stretchedSvg(1, [{ width: 100, fill: MUTED }])

export function iconSvg(name: IconName, isActive: boolean, tint?: string) {
  const color = tint ?? (isActive ? ACTIVE_ICON : MUTED)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}
