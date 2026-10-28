// Soap Panel 的焦點：按了按鈕後焦點不要丟、按的那顆不見了把焦點圈移到看得到的按鈕上。
// 不碰 $ 和 atom，用 register.tsx 給的 FocusIo。
//
// 焦點有三種會丟：
// 1. 引擎知道的：點分頁標籤切到 Soap Panel 時引擎不會通知、也不給焦點；按完按鈕有時也會丟（引擎回報沒焦點）。
//    定時看一下（focusWhenShown）：它「剛被切到前面」或「剛按完按鈕」又沒焦點，就把焦點給它。
//    只在那兩種時候給，平常在輸入框打字不會被搶。
// 2. 引擎不知道的：按的按鈕重畫後不見了（整塊換成差異、合併，那列消失），桌面版的焦點會掉到輸入框，
//    引擎卻還以為 Soap Panel 拿著鍵盤，給焦點也補不回來，快捷鍵就跑去輸入框。
//    要把焦點圈移到看得到的按鈕上才行：每次畫完檢查剛按的那顆還在不在（checkPressed）。
// 3. 按了這個畫面沒綁的字母（log 分頁按 m）：桌面版把那個鍵交給輸入框，焦點跟著跑過去。
//    這種在畫面那層擋掉（ui/panel.tsx 的 strayKeys）。
// 4. 終端機點輸入框（底下那顆透明按鈕）時 Soap Panel 沒拿著鍵盤：引擎不肯移焦點圈（focusInput）。

import type { RenderChildren, Timer, UiPane, UiPressArgument } from 'claude-code'

import type { Cover } from '../../types'
import { REFOCUS_AFTER_PRESS_MS } from '../config'
import { buttonKeys, neighbourKey, ringAnchor, tabIconKey } from './keys'

export type FocusIo = {
  findPane: () => Promise<UiPane | undefined>
  // 把焦點給 Soap Panel。
  focusPanel: () => Promise<unknown>
  // 把 Soap Panel 的焦點圈移到 key 那個按鈕上；Soap Panel 沒拿著鍵盤就算了（回 false）。
  ringOn: (key: string) => Promise<boolean>
  now: () => Promise<number>
  after: (ms: number, fn: () => unknown) => Timer
  // 看著的 Tab 和它的子分頁。
  shownTab: () => Promise<{ t: string; sub: string | undefined }>
  // Soap Panel 剛被切到前面時重讀（register.tsx 的 refreshWhenShown）。
  refreshWhenShown: () => Promise<void>
}

// 上一輪看的時候在不在前面；沒記錄當作在（剛啟動不搶焦點）。
let wasShown: boolean | undefined
let isWatching = false
// 按完按鈕後，到這個時間點之前丟了焦點（引擎知道的）就補回來；undefined 是沒有要補。
let refocusUntil: number | undefined
// 剛按的按鈕（key，處理完是 undefined）、它換掉後焦點圈的首選（to），看到什麼時候（until：
// 動作還在跑是 Infinity，做完再給 REFOCUS_AFTER_PRESS_MS）。這段時間內畫面上沒了這顆，就把焦點圈移走。
let pressed: { key?: string; to?: string; until: number } | undefined

export async function isPaneShown(io: FocusIo) {
  return (await io.findPane())?.isShown === true
}

// 包住面板上按鈕的動作：記下按的是哪顆，動作做完（可能要跑 git 很久）才開始算那段時間。
// ringKey：按的按鈕會換成這顆（兩邊都要 → Reset），焦點圈優先移到它，不移到遠處的 Back。
export function act(io: FocusIo, fn: () => unknown, ringKey?: string) {
  return async (e: UiPressArgument) => {
    const mine = { key: e.element, to: ringKey, until: Infinity }
    pressed = mine
    try {
      await fn()
    } finally {
      const end = (await io.now()) + REFOCUS_AFTER_PRESS_MS
      refocusUntil = end
      mine.until = end
    }
  }
}

// 上一次畫的樹：leaveRow 從這裡找按的那顆的下一列。
let drawnTree: RenderChildren

// 每次畫完：剛按的那顆不在畫面上了，就把焦點圈移到 ringAnchor（換上來的那顆、Back、分頁圖示）。
// 還沒有落點可移（套用中，Back 藏起來了）就等下一次畫。畫的 hook 裡不能等自己畫出來的東西，所以等畫完再移。
export function checkPressed(io: FocusIo, tree: RenderChildren, now: number, t: string, sub: string | undefined) {
  drawnTree = tree
  const p = pressed
  if (p?.key === undefined || now >= p.until) return
  const keys = buttonKeys(tree)
  if (keys.has(p.key)) {
    // 動作做完還在，就不會再不見了。
    if (p.until !== Infinity) p.key = undefined

    return
  }
  const anchor = ringAnchor(keys, t, sub, p.to)
  if (anchor === undefined) return
  p.key = undefined
  io.after(0, () => void io.ringOn(anchor))
}

// 按的那顆跟著那列要被刪掉了（diff 分頁的檔案、分支、Spec、Wiki、DB 連線、Files 選單）：刪之前先把焦點圈移到下一列同一種按鈕（沒有就上一列、再沒有就分頁圖示）。
// rowKey：用那列的這顆找鄰居（Files 是在選單裡按 Delete，鄰居是下一列的 ⋯）；沒給就用按的那顆。
// 等它不見才移就晚了：桌面版的焦點已經掉出 Soap Panel，下一次點只會拿回焦點、按不到東西。
export async function leaveRow(io: FocusIo, rowKey?: string) {
  const p = pressed
  const key = p?.key
  if (p === undefined || key === undefined) return
  p.key = undefined
  const from = rowKey ?? key
  const before = [...buttonKeys(drawnTree)]
  const left = new Set(before.filter(k => k !== key && k !== from))
  const { t, sub } = await io.shownTab()
  const to = neighbourKey(before, from, left) ?? ringAnchor(left, t, sub)
  if (to !== undefined) await io.ringOn(to)
}

// 上一次畫的蓋版畫面。沒按按鈕它自己不見了（回合結束發現衝突解掉了、差異的檔案沒有變更了），
// checkPressed 管不到：畫面整塊換回分頁，焦點圈移到分頁圖示。
let drawnCover: Cover['kind'] = 'none'

export function checkCover(io: FocusIo, kind: Cover['kind'], now: number, t: string, sub: string | undefined) {
  const wasCovered = drawnCover !== 'none'
  drawnCover = kind
  const isPressing = pressed !== undefined && now < pressed.until
  if (wasCovered && kind === 'none' && !isPressing) io.after(0, () => void io.ringOn(tabIconKey(t, sub)))
}

// 不一律先給焦點：checkCover 那些沒按按鈕的 ringOn 不該搶鍵盤，這裡是人點了輸入框才給。
export async function focusInput(io: FocusIo, key: string) {
  if (await io.ringOn(key)) return
  await io.focusPanel().catch(() => undefined)
  await io.ringOn(key)
}

export async function focusWhenShown(io: FocusIo) {
  if (isWatching) return
  isWatching = true
  try {
    const pane = await io.findPane()
    const isShown = pane?.isShown === true
    if (isShown && pane?.isFocused === false) {
      const isJustPressed = refocusUntil !== undefined && (await io.now()) < refocusUntil
      if (wasShown === false || isJustPressed) {
        await io.focusPanel()
        refocusUntil = undefined
      }
    }
    if (isShown && wasShown === false) void io.refreshWhenShown().catch(() => undefined)
    wasShown = isShown
  } catch {
    // 讀不到就等下一輪。
  } finally {
    isWatching = false
  }
}
