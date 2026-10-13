// 畫面和動作之間的約定。畫面（ui/）是純函式：拿到資料和這些動作，畫出樹；
// 動作的實作在 register.tsx（引擎只讓那裡碰 $），畫面不知道背後怎麼做。

import type { Elements, RenderSurface, SessionUsage, UiPressArgument } from 'claude-code'

import type {
  CommitFile,
  DiffPaneView,
  FilesView,
  GitBranch,
  GitCommit,
  GitSubTab,
  GitSync,
  GitView,
  LogView,
  MergeChunk,
  MergeView,
  Service,
  ServiceAction,
  ServicePending,
  ServicesView,
  TabId,
} from '../../types'

// $.ui.resolve(e) 給的元件表。
export type Ui = Elements[RenderSurface]

// 包住按鈕的動作：做完後丟了焦點會補回來。ringKey：按的按鈕會被換掉時，做完把焦點圈移到換上來的那顆。
export type Press = (fn: () => unknown, ringKey?: string) => (e: UiPressArgument) => Promise<void>

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
  closeDiff: () => unknown
  // conflict
  abortOp: () => unknown
  cancelAbort: () => unknown
  continueOp: () => unknown
  // files
  // dir：相對 session 資料夾，'' 是它本身。
  openDir: (dir: string) => unknown
  // services
  runServiceAction: (s: Service, action: ServiceAction) => unknown
  // 合併（畫在 Soap Panel 裡）
  editChunks: (edit: (chunks: MergeChunk[]) => MergeChunk[]) => unknown
  jumpConflict: (step: 1 | -1) => unknown
  takeSide: (side: 'ours' | 'theirs' | 'as-is') => unknown
  applyMerge: () => unknown
  askClaude: () => unknown
  closeMerge: () => unknown
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
  // 正在停掉／重跑的服務。
  servicePending: readonly ServicePending[]
  log: LogView
  logQuery: string
  // 打開的檔案差異；path 不是 '' 時蓋掉分頁，畫差異。
  diff: DiffPaneView
  // 打開的衝突檔案；path 不是 '' 時蓋掉分頁，畫三欄合併。isMergeBusy：正在套用。
  merge: MergeView
  isMergeBusy: boolean
  usage: readonly UsageReading[]
  now: number
}
