// ───── 想改面板標題、分頁、顏色、時間，改這個檔案 ─────

import type { FileKind, MergeOp, SubTabs, TabId, WikiModel } from '../types'
import type { FileGroupId } from './git/parse'

// 面板的 id 在 register.tsx：引擎要在那裡直接看到它們的值。
export const PANEL_TITLE = 'Soap Panel'
// 兩邊都一樣的段落，衝突的前後各留幾行，其餘收成「⋯ N unchanged lines」。
export const MERGE_CONTEXT = 3
// 合併畫面每一欄的寬度；三欄加起來不到 100%，剩下的當欄距。
export const MERGE_COLUMN_WIDTH = '32%'

// 進行中的操作在 conflict 分頁上的名稱。
export const OP_LABEL: Record<Exclude<MergeOp, ''>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
}

// 檔案狀態的名稱和顏色：檔案列的狀態字母、差異的標題都用這張表。
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
  files:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  services:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  library: '<path d="m16 6 4 14"/><path d="M12 6v14"/><path d="M8 8v12"/><path d="M4 4v16"/>',
  box: '<rect width="18" height="18" x="3" y="3" rx="2"/>',
  boxChecked: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/>',
  spec: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  restart: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  rollback: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',
  db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  at: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
}
export type IconName = keyof typeof ICONS

export const ICON_PX = 16

// log 分頁每一列的固定欄寬（字數）：短 sha（桌面版字寬不一，多留一格）、作者名稱（太長截斷）、
// 多久前（最長像「11mo」）。subject 吃掉剩下的寬度。
export const LOG_SHA_WIDTH = 8
export const LOG_AUTHOR_WIDTH = 10
export const LOG_AGO_WIDTH = 4

// 檔案列（diff、log 的 commit、conflict、Files 搜尋）檔名那欄的固定寬（字數），太長截斷；資料夾從這欄後面開始。
export const PATH_NAME_WIDTH = 14
// 選中的 tab 恆亮的底色。
export const ACTIVE_BG = '#3a3a3a'
// 終端機的輸入框墊的 ACTIVE_BG 底色至少這麼寬（字數）。
export const FIELD_MIN_WIDTH = 30
// 差異的顏色：加的行綠字、減的行紅字（VS Code Dark 的 git 顏色），整行不上底色；
// 跟配對那行比改到的字詞才上底色、字換成主題的一般字色，跟旁邊的字對比夠才看得出來。
export const DIFF_STYLE = {
  add: { text: '#73c991', word: '#2d6a35' },
  remove: { text: '#f48771', word: '#8b2e2e' },
} as const
// Files 分頁 ⋯ 選單的底色（不透明，蓋住底下的列）和寬度（字數，放得下 Press again to delete）。
export const MENU_BG = '#262626'
export const MENU_WIDTH = 26
// 圖示按鈕的寬度：這串空白撐出按鈕，底色、hover、圖示都對齊這塊區域。
// 用不換行空白（ ），一般空白會被吃掉。
export const ICON_BUTTON_LABEL = ' '.repeat(10)
// 一長串字元要多長才比任何面板都寬（超出的部分被裁掉）：整行按鈕的 label、終端機的分隔線和用量 bar。
const OVERFLOW_CHARS = 400
// 整行按鈕的 label：比任何面板都寬，超出整行的部分被裁掉。
export const ROW_BUTTON_LABEL = ' '.repeat(OVERFLOW_CHARS)
// 包住那顆按鈕的那層有多寬（欄數；百分比最多 100%，不夠用）：比按鈕寬，按鈕才不會被壓窄而在最右邊畫出「…」。
export const ROW_OVERLAY_WIDTH = ROW_BUTTON_LABEL.length * 2

// 沒選中的圖示和分隔線的顏色。
export const MUTED = '#8b8b8b'
// 選中的圖示（和紅底上的圖示）的顏色。
export const ACTIVE_ICON = '#ffffff'

// 分隔線。桌面版把 Svg 畫成 max-width:100% 的圖，寬度會被壓到面板寬、高度固定 1px；
// preserveAspectRatio="none" 讓線跟著拉伸，不會被等比縮到看不見。終端機沒有 Svg，用一長串橫線字元。
export const DIVIDER_PX = 4000
export const DIVIDER_TEXT = '─'.repeat(OVERFLOW_CHARS)

// 一種顏色：theme 給 Text（跟著主題），hex 給 Svg（要色碼）。
export type Tint = { theme: string; hex: string; background?: string }

export const GOOD: Tint = { theme: 'success', hex: '#4eba65' }
export const WARN: Tint = { theme: 'warning', hex: '#d4a72c' }
// 危險／不好的紅色：剩餘用量低、停止鈕、有衝突的子分頁。
export const DANGER: Tint = { theme: 'error', hex: '#e5534b' }
// 要按兩次的按鈕的打勾：紅底白勾（終端機是紅色方塊加紅字），一看就知道再按會做。
export const ARMED_TINT: Tint = { theme: DANGER.theme, hex: ACTIVE_ICON, background: DANGER.hex }
// 分支名稱複製好了：綠底白勾，COPIED_MS 後換回複製圖示。
export const COPIED_TINT: Tint = { theme: GOOD.theme, hex: ACTIVE_ICON, background: GOOD.hex }

// 上層 Tab。之後要加新的 Tab，在這裡加一筆，再到 ui/panel.tsx 的 TAB_BODIES 補上它的內容。
export const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'files', label: 'Files', icon: 'files' },
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'services', label: 'Services', icon: 'services' },
  { id: 'spec', label: 'Docs', icon: 'book' },
  { id: 'db', label: 'DB', icon: 'db' },
]

// 有子分頁的 Tab 和它的子分頁。內容：Git 在 ui/panel.tsx 的 GIT_SUB_TAB_BODIES，Spec（計劃和 wiki）在 ui/tabs/spec.tsx 的 SPEC_SUB_TAB_BODIES。
export const SUB_TABS: { [T in keyof SubTabs]: { id: SubTabs[T]; label: string; icon: IconName }[] } = {
  git: [
    { id: 'diff', label: 'diff', icon: 'diff' },
    { id: 'branch', label: 'branch', icon: 'branch' },
    { id: 'log', label: 'log', icon: 'log' },
    { id: 'conflict', label: 'conflict', icon: 'conflict' },
  ],
  spec: [
    { id: 'spec', label: 'Spec', icon: 'spec' },
    { id: 'wiki', label: 'Wiki', icon: 'library' },
  ],
}

export const hasSubTabs = (tab: TabId): tab is keyof SubTabs => tab in SUB_TABS

// log 分頁一頁列幾筆 commit（換頁見 widgets 的 pager）。
export const LOG_PAGE = 30
// branch 分頁每個資料夾（含最外層）直屬的分支最多畫幾個；分支上千個時全畫會卡死，其餘用搜尋找。
export const BRANCH_ROW_LIMIT = 50
// Local、Remote 各最多畫幾列（資料夾、分支都算）：搜尋時資料夾全部打開，每個資料夾各 50 個加起來還是會太多。
// 每列有三顆 Svg 圖示鈕，上千個分支時搜尋打一個字就幾乎全中，畫到 200 列桌面版會卡住、打字沒反應。
export const BRANCH_TREE_LIMIT = 50
// branch、Files 分頁資料夾列的顏色（天空藍；也可以寫主題色名稱）；終端機是包在按鈕裡的 Text 上色。
export const FOLDER_COLOR = '#38bdf8'
// diff 分頁一頁最多畫幾個檔案（三組加起來；換頁見 widgets 的 pager）。沒 ignore 的資料夾會冒出上千個 untracked 檔案。
export const FILE_PAGE = 50

// Files 分頁一個資料夾最多畫幾列（node_modules 這種上千個的，全畫會卡）。
export const FILES_ROW_LIMIT = 200
// Files 分頁搜尋：整個 session 資料夾最多收幾個檔案來比對、一次同時讀幾個資料夾；這些資料夾不往下找。
export const FILES_WALK_LIMIT = 20_000
export const FILES_WALK_BATCH = 32
export const FILES_WALK_SKIP: readonly string[] = ['.git', 'node_modules']
// 點檔案看內容：比這大的不讀（bytes）。
export const FILE_VIEW_MAX_BYTES = 1_000_000
// Spec 分頁：plan skill 把每個 feature 的計劃寫在這個資料夾（相對 session 資料夾）底下的 <feature>/plan.yaml。
export const SPEC_DIR = '.soap/tasks'
export const PLAN_FILE = 'plan.yaml'
// Wiki 子分頁：頁面是這個資料夾（相對 session 資料夾）底下的 .md；勾了哪幾頁存在 $.store 的「CHECKED_KEY:session 資料夾」，
// Distill 和 wiki skill 的草稿放在 DRAFTS_DIR（. 開頭的資料夾不算頁面）。頁面最多列幾頁。
export const WIKI_DIR = '.soap/wiki'
export const WIKI_CHECKED_KEY = 'wiki.checked'
export const WIKI_DRAFTS_DIR = '.drafts'
export const WIKI_PAGE_LIMIT = 500
// Distill 時一起給 Claude 看的既有頁面最多幾 byte（照檔案大小算，超過的只給路徑、不讀），免得整個 wiki 塞爆一次請求。
export const WIKI_DISTILL_MAX_BYTES = 100_000
// Summary Conversation 可選的模型：跟對話同一種（還沒選過就是它）從快取接著問；
// 其他的把對話轉成文字（最多 WIKI_TRANSCRIPT_MAX_CHARS 字，太長留最新的）另外問，選了存在 $.store 的 WIKI_MODEL_KEY。
export const WIKI_MODELS: { id: WikiModel; label: string }[] = [
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]
export const WIKI_MODEL_KEY = 'wiki.model'
export const WIKI_TRANSCRIPT_MAX_CHARS = 300_000
// 另外問時：回覆最多幾個 token、最多等多久。
export const WIKI_DISTILL_MAX_TOKENS = 8_000
export const WIKI_DISTILL_TIMEOUT_MS = 180_000

// DB 分頁（SQL Server，經過 sqlcmd）：存連線的 $.store key、macOS Keychain 項目的 service 名稱。
export const DB_STORE_KEY = 'db.connections'
export const DB_KEYCHAIN_SERVICE = 'soap-mods-db'
// 結果最多留幾列、每格最多畫幾個字（多的截成「…」）；資料表最多列幾個；點資料表預覽幾列。
export const DB_ROW_LIMIT = 200
export const DB_CELL_WIDTH = 40
export const DB_TABLE_LIMIT = 300
export const DB_PREVIEW_ROWS = 100
// sqlcmd 連線（-l）、查詢（-t）各等幾秒；整個程序再多給一點時間才砍。
export const DB_LOGIN_TIMEOUT_S = 15
export const DB_QUERY_TIMEOUT_S = 60
export const DB_PROCESS_TIMEOUT_MS = (DB_LOGIN_TIMEOUT_S + DB_QUERY_TIMEOUT_S + 10) * 1000

// 檔案內容、Wiki 頁面最多畫前面這麼多字（引擎的 Code、Markdown 一次最多畫 100000 字），切在行尾。差異一行一列分頁畫，不切。
export const CODE_MAX_CHARS = 60_000
// 差異自己一行一列畫（改到的字詞反白），一頁最多這麼多行，底下用換頁列換頁：一次畫幾千個 Text 會把桌面版卡住。
export const DIFF_PAGE_ROWS = 800

// 面板最底下的用量：左邊 5h、右邊 weekly，各占一半。kind 是引擎回報的視窗名稱。
export const USAGE_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: 'Weekly' },
]
// 重置倒數多久重畫一次。
export const USAGE_TICK_MS = 60_000
// bar 的高度（桌面版，px）；終端機的文字 bar：剩餘、用掉的各一長串方塊，被裁到那段的寬度。
export const USAGE_BAR_PX = 4
export const USAGE_BAR_FULL = '█'.repeat(OVERFLOW_CHARS)
export const USAGE_BAR_EMPTY = '░'.repeat(OVERFLOW_CHARS)

// Services 分頁開著時多久重新掃一次程序（掃一次大約 1 秒）。
export const SERVICES_SCAN_MS = 5_000
// Git、Services 分頁開著時多久重讀一次 git 狀態（外面改的檔案、回合進行中改的也看得到）。
export const GIT_REFRESH_MS = 5_000
// 重跑：停掉之後等多久再開（讓 port 放出來）；開完之後在這些時間點檢查新程序還在不在（同時重掃，
// 服務要一點時間才會 LISTEN）。這段時間內掛掉就算重跑失敗，在面板上提示。
export const RESTART_GAP_MS = 500
export const RESTART_CHECK_MS = [2_000, 5_000, 15_000, 30_000]
// 要按兩次的按鈕（刪除、切換分支、rollback、abort）按了一次後，多久沒再按就收回去。
export const DELETE_ARM_MS = 3_000
// 分支按了一次、等著再按一次切換時，那列後面寫的提示。
export const SWITCH_ARMED_HINT = 'press again to switch'
// 複製分支名稱後，綠底打勾留多久。
export const COPIED_MS = 2_000
// branch 分頁的 Fetch／Pull 最多等多久（git 預設只等 30 秒，大 repo 抓不完）。
export const SYNC_TIMEOUT_MS = 300_000

// 多久看一次面板是不是剛被切到前面（要補焦點）；按完按鈕後多久內丟了焦點也補回來。見 register.tsx 的 focusWhenShown。
export const FOCUS_WATCH_MS = 200
export const REFOCUS_AFTER_PRESS_MS = 600
