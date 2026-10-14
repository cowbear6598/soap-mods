// 畫面和動作之間的約定。畫面（ui/）是純函式：拿到資料和這些動作，畫出樹；
// 動作的實作在 register.tsx（引擎只讓那裡碰 $），畫面不知道背後怎麼做。

import type { Elements, RenderSurface, SessionUsage, UiPressArgument } from 'claude-code'

import type {
  CommitFile,
  Cover,
  DbTable,
  DbView,
  FilesView,
  GitBranch,
  GitCommit,
  GitSubTab,
  GitSync,
  GitView,
  LogView,
  MergeChunk,
  Service,
  ServiceAction,
  ServicePending,
  ServicesView,
  SpecView,
  TabId,
} from '../../types'

// $.ui.resolve(e) 給的元件表。
export type Ui = Elements[RenderSurface]

// 包住按鈕的動作：做完後丟了焦點會補回來。ringKey：按的按鈕會被換掉時，做完把焦點圈移到換上來的那顆。
export type Press = (fn: () => unknown, ringKey?: string) => (e: UiPressArgument) => Promise<void>

// DB 分頁正在做的事：存連線、跑查詢；'' 是沒有。
export type DbBusy = '' | 'adding' | 'query'

export type UsageReading = SessionUsage['rateLimits'][number]

export type Actions = {
  selectTab: (id: TabId) => unknown
  selectSubTab: (id: GitSubTab) => unknown
  selectRepo: (name: string) => unknown
  // diff
  openDiff: (path: string) => unknown
  openMerge: (path: string) => unknown
  showMoreFiles: () => unknown
  // branch
  searchBranches: (text: string) => unknown
  toggleRemote: () => unknown
  toggleBranchFolder: (key: string, isOpen: boolean) => unknown
  switchBranch: (name: string, isRemote: boolean) => unknown
  deleteBranch: (name: string) => unknown
  syncBranches: (kind: GitSync) => unknown
  viewLog: (b: GitBranch) => unknown
  copyBranchName: (name: string) => unknown
  // log
  searchLog: (text: string) => unknown
  loadMoreLog: () => unknown
  openCommit: (c: GitCommit) => unknown
  toggleRangePick: () => unknown
  pickRange: (c: GitCommit) => unknown
  closeCommit: () => unknown
  openCommitDiff: (commits: GitCommit[], f: CommitFile, files: CommitFile[]) => unknown
  // 差異（畫在 Soap Panel 裡）
  stepDiffFile: (step: 1 | -1) => unknown
  // 關掉蓋住分頁的差異、合併、檔案內容，回到分頁
  closeCover: () => unknown
  // conflict
  abortOp: () => unknown
  cancelAbort: () => unknown
  continueOp: () => unknown
  // files
  // dir：相對 session 資料夾，'' 是它本身。
  openDir: (dir: string) => unknown
  // 看檔案內容（畫在 Soap Panel 裡）；path 一樣相對 session 資料夾。
  openFile: (path: string) => unknown
  stepFile: (step: 1 | -1) => unknown
  // 從 session 資料夾往下找檔名。
  searchFiles: (text: string) => unknown
  // spec：name 是 .soap/tasks 底下的 feature 資料夾。
  openSpec: (name: string) => unknown
  closeSpec: () => unknown
  // 叫 Claude 照打開的那份 plan.yaml 做。
  doSpec: () => unknown
  // 刪掉整個 feature 資料夾：按第一次只是待確認（打勾），再按才刪。
  deleteSpec: (name: string) => unknown
  // services
  runServiceAction: (s: Service, action: ServiceAction) => unknown
  // db：text 是貼上的連線字串、輸入的查詢；id 是存著的連線。
  addDbConnection: (text: string) => unknown
  // 刪連線：按第一次只是待確認（打勾），再按才刪（連 Keychain 裡的密碼）。
  deleteDbConnection: (id: string) => unknown
  openDbConnection: (id: string) => unknown
  closeDbConnection: () => unknown
  // 點資料表：展開它的欄位、查詢框換成看它前幾列並執行；再點一次收起來。
  toggleDbTable: (t: DbTable) => unknown
  setDbQuery: (text: string) => unknown
  // text：按 Enter 時框裡的字。
  runDbQuery: (text: string) => unknown
  // 合併（畫在 Soap Panel 裡）
  editChunks: (edit: (chunks: MergeChunk[]) => MergeChunk[]) => unknown
  jumpConflict: (step: 1 | -1) => unknown
  takeSide: (side: 'ours' | 'theirs' | 'as-is') => unknown
  applyMerge: () => unknown
  askClaude: () => unknown
}

// Soap Panel 畫一次要的全部資料。
export type PanelData = {
  surface: RenderSurface
  bodyRows: number
  tab: TabId
  subTab: GitSubTab
  view: GitView
  showRemote: boolean
  branchFolders: Readonly<Record<string, boolean>>
  branchQuery: string
  fileLimit: number
  // 正在跑的 Fetch／Pull，'' 是沒有。
  syncing: GitSync | ''
  services: ServicesView
  files: FilesView
  spec: SpecView
  db: DbView
  dbBusy: DbBusy
  // 正在停掉／重跑的服務。
  servicePending: readonly ServicePending[]
  log: LogView
  logQuery: string
  // 蓋住分頁的差異、三欄合併或檔案內容；kind 是 none 時畫分頁。isMergeBusy：合併正在套用。
  cover: Cover
  isMergeBusy: boolean
  usage: readonly UsageReading[]
  now: number
}
