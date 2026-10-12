// ───── 想改面板標題、分頁、顏色、時間，改這個檔案 ─────

import type { GitSubTab, MergeOp, TabId } from '../types'
import type { FileGroupId, FileKind } from './git/parse'

// 面板的 id 在 register.tsx：引擎要在那裡直接看到它們的值。
export const PANEL_TITLE = 'Soap Panel'
// 解衝突的三欄面板（左 Ours、中 Result、右 Theirs）。columns 是跟引擎要的寬度，人拖過的寬度優先。
export const MERGE_COLUMNS = 180
// 兩邊都一樣的段落，衝突的前後各留幾行，其餘收成「⋯ N unchanged lines」。
export const MERGE_CONTEXT = 3
// 合併面板每一欄的寬度；三欄加起來不到 100%，剩下的當欄距。
export const MERGE_COLUMN_WIDTH = '32%'

// 進行中的操作在 conflict 分頁上的名稱。
export const OP_LABEL: Record<Exclude<MergeOp, ''>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
}

// 檔案狀態的名稱和顏色：檔案列的狀態字母、差異面板的標題都用這張表。
export const KIND_STYLE: Record<FileKind, { label: string; theme: string }> = {
  added: { label: 'Added', theme: 'success' },
  modified: { label: 'Modified', theme: 'warning' },
  deleted: { label: 'Deleted', theme: 'error' },
  renamed: { label: 'Renamed', theme: 'suggestion' },
  conflict: { label: 'Conflict', theme: 'error' },
}

// 變更列表的分組標題，照這個順序畫。
export const FILE_GROUPS: { id: FileGroupId; label: string }[] = [
  { id: 'staged', label: 'Staged' },
  { id: 'unstaged', label: 'Unstaged' },
  { id: 'untracked', label: 'Untracked' },
]

// 圖示：24x24 的線條圖，只放 <svg> 裡面的內容（Lucide 風格）。
export const ICONS = {
  git: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  log: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  conflict:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  services:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  restart: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
}
export type IconName = keyof typeof ICONS

export const ICON_PX = 16
// 選中的 tab 恆亮的底色。
export const ACTIVE_BG = '#3a3a3a'
// 圖示按鈕的寬度：這串空白撐出按鈕，底色、hover、圖示都對齊這塊區域。
// 用不換行空白（ ），一般空白會被吃掉。
export const ICON_BUTTON_LABEL = ' '.repeat(10)
// 整行按鈕的 label：比任何面板都寬，超出整行的部分被裁掉。
export const ROW_BUTTON_LABEL = ' '.repeat(400)
// 包住那顆按鈕的那層有多寬（欄數；百分比最多 100%，不夠用）：比按鈕寬，按鈕才不會被壓窄而在最右邊畫出「…」。
export const ROW_OVERLAY_WIDTH = ROW_BUTTON_LABEL.length * 2

// 沒選中的圖示和分隔線的顏色。
export const MUTED = '#8b8b8b'
// 選中的圖示（和紅底上的圖示）的顏色。
export const ACTIVE_ICON = '#ffffff'

// 分隔線。桌面版把 Svg 畫成 max-width:100% 的圖，寬度會被壓到面板寬、高度固定 1px；
// preserveAspectRatio="none" 讓線跟著拉伸，不會被等比縮到看不見。終端機沒有 Svg，用一長串橫線字元。
export const DIVIDER_PX = 4000
export const DIVIDER_TEXT = '─'.repeat(400)

// 一種顏色：theme 給 Text（跟著主題），hex 給 Svg（要色碼）。
export type Tint = { theme: string; hex: string; background?: string }

export const GOOD: Tint = { theme: 'success', hex: '#4eba65' }
export const WARN: Tint = { theme: 'warning', hex: '#d4a72c' }
// 危險／不好的紅色：剩餘用量低、停止鈕、有衝突的子分頁。
export const DANGER: Tint = { theme: 'error', hex: '#e5534b' }
// 分支的打勾：紅底白勾（終端機是按鈕前的紅色方塊），一看就知道再按會刪。
export const ARMED_TINT: Tint = { theme: DANGER.theme, hex: ACTIVE_ICON, background: DANGER.hex }

// 上層 Tab。之後要加新的 Tab，在這裡加一筆，再到 ui/panel.tsx 的 TAB_BODIES 補上它的內容。
export const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'services', label: 'Services', icon: 'services' },
]

// Git Tab 的子分頁；內容在 ui/panel.tsx 的 SUB_TAB_BODIES。
export const SUB_TABS: { id: GitSubTab; label: string; icon: IconName }[] = [
  { id: 'diff', label: 'diff', icon: 'diff' },
  { id: 'branch', label: 'branch', icon: 'branch' },
  { id: 'log', label: 'log', icon: 'log' },
  { id: 'conflict', label: 'conflict', icon: 'conflict' },
]

// log 分頁一次列幾筆 commit；Load more 再多列這麼多筆。
export const LOG_PAGE = 30
// branch 分頁每個資料夾（含最外層）直屬的分支最多畫幾個；分支上千個時全畫會卡死，其餘用搜尋找。
export const BRANCH_ROW_LIMIT = 50
// Local、Remote 各最多畫幾列（資料夾、分支都算）：搜尋時資料夾全部打開，每個資料夾各 50 個加起來還是會太多。
export const BRANCH_TREE_LIMIT = 200
// branch 分頁資料夾列的顏色（天空藍；也可以寫主題色名稱）；終端機的按鈕吃不到顏色，只有桌面版看得到。
export const FOLDER_COLOR = '#38bdf8'
// diff 分頁每組一開始畫幾個檔案；Show more 再多畫這麼多個。沒 ignore 的資料夾會冒出上千個 untracked 檔案。
export const FILE_PAGE = 50

// 面板最底下的用量：左邊 5h、右邊 weekly，各占一半。kind 是引擎回報的視窗名稱。
export const USAGE_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: 'Weekly' },
]
// 重置倒數多久重畫一次。
export const USAGE_TICK_MS = 60_000
// bar 的高度（桌面版，px）；終端機的文字 bar 有幾格。
export const USAGE_BAR_PX = 4
export const USAGE_BAR_CELLS = 10

// Services 分頁開著時多久重新掃一次程序（掃一次大約 1 秒）。
export const SERVICES_SCAN_MS = 5_000
// 重跑：停掉之後等多久再開（讓 port 放出來）；開完之後在這些時間點檢查新程序還在不在（同時重掃，
// 服務要一點時間才會 LISTEN）。這段時間內掛掉就算重跑失敗，在面板上提示。
export const RESTART_GAP_MS = 500
export const RESTART_CHECK_MS = [2_000, 5_000, 15_000, 30_000]
// 分支的垃圾桶換成打勾後，多久沒再按就收回去。
export const DELETE_ARM_MS = 3_000
// branch 分頁的 Fetch／Pull 最多等多久（git 預設只等 30 秒，大 repo 抓不完）。
export const SYNC_TIMEOUT_MS = 300_000

// 多久看一次面板是不是剛被切到前面（要補焦點）；按完按鈕後多久內丟了焦點也補回來。見 ui/panes.ts。
export const FOCUS_WATCH_MS = 200
export const REFOCUS_AFTER_PRESS_MS = 600
