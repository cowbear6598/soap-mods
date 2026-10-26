// 畫面和動作之間的約定。畫面（ui/）是純函式：拿到資料和這些動作，畫出樹；
// 動作的實作在 register.tsx（引擎只讓那裡碰 $），畫面不知道背後怎麼做。

import type { Elements, RenderSurface, SessionUsage, UiPressArgument } from 'claude-code'

import type {
  CiJob,
  CiJobAction,
  CiPipeline,
  CiView,
  MrSuggestion,
  MrView,
  CommitFile,
  Cover,
  DbTable,
  DbView,
  FilesView,
  GitBranch,
  GitCommit,
  GitFile,
  GitSync,
  GitView,
  HttpPage,
  HttpView,
  LogView,
  MergeChunk,
  Service,
  ServiceAction,
  ServicePending,
  ServicesView,
  SubTabs,
  SpecView,
  TabId,
  WikiModel,
  WikiView,
  DiffPage,
} from '../../types'

// $.ui.resolve(e) 給的元件表。
export type Ui = Elements[RenderSurface]

// 包住按鈕的動作：做完後丟了焦點會補回來。ringKey：按的按鈕會被換掉時，做完把焦點圈移到換上來的那顆。
export type Press = (fn: () => unknown, ringKey?: string) => (e: UiPressArgument) => Promise<void>

// DB 分頁正在做的事：存連線、跑查詢；'' 是沒有。
export type DbBusy = '' | 'adding' | 'query'

// HTTP 子分頁正在做的事：送出請求、存貼上的機密、把草稿寫進檔案；'' 是沒有。
export type HttpBusy = '' | 'send' | 'secret' | 'draft'

export type UsageReading = SessionUsage['rateLimits'][number]

export type Actions = {
  selectTab: (id: TabId) => unknown
  selectSubTab: <T extends keyof SubTabs>(tab: T, id: SubTabs[T]) => unknown
  selectRepo: (name: string) => unknown
  // diff
  openDiff: (path: string) => unknown
  openMerge: (path: string) => unknown
  showFilePage: (page: number) => unknown
  deleteChange: (file: GitFile) => unknown
  rollbackChange: (file: GitFile) => unknown
  // branch
  searchBranches: (text: string) => unknown
  toggleRemote: () => unknown
  toggleBranchFolder: (key: string, isOpen: boolean) => unknown
  switchBranch: (name: string, isRemote: boolean) => unknown
  deleteBranch: (name: string, isRemote: boolean) => unknown
  syncBranches: (kind: GitSync) => unknown
  viewLog: (b: GitBranch) => unknown
  copyBranchName: (name: string) => unknown
  // log
  searchLog: (text: string) => unknown
  showLogPage: (page: number) => unknown
  // 長的差異換頁：place 是哪裡的差異（diffpage 蓋版、wikidiff 草稿），id 是哪一份。
  showDiffPage: (place: string, id: string, page: number) => unknown
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
  // 一列最右邊的 ⋯：打開那列的選單，再按收起來；path 相對 session 資料夾。
  toggleFileMenu: (path: string) => unknown
  // 在檔案總管（macOS 是 Finder）裡選起它。
  revealFile: (path: string) => unknown
  // 刪掉檔案或整個資料夾：按第一次只是待確認，再按才刪。
  deleteFile: (path: string) => unknown
  // spec：name 是 .soap/tasks 底下的 feature 資料夾。
  openSpec: (name: string) => unknown
  closeSpec: () => unknown
  // 叫 Claude 照打開的那份 plan.yaml 做。
  doSpec: () => unknown
  // 刪掉整個 feature 資料夾：按第一次只是待確認（打勾），再按才刪。
  deleteSpec: (name: string) => unknown
  // wiki：path 是 .soap/wiki 底下的頁面，id 是 .soap/wiki/.drafts 底下的草稿檔名。
  // 勾選框：選要 Send 的頁面（存在 mod 的 store，依 session 資料夾分開，下次開還勾著）。
  toggleWikiPage: (path: string) => unknown
  uncheckAllWikiPages: () => unknown
  // 把 session 資料夾底下的路徑當 @ 引用插進聊天框的游標位置。
  mentionPath: (path: string) => unknown
  // 開合資料夾，path 含結尾的 /。
  toggleWikiFolder: (path: string, isOpen: boolean) => unknown
  openWikiPage: (path: string) => unknown
  // 關掉打開的頁面或草稿，回清單。
  closeWiki: () => unknown
  // 刪 .soap/wiki 底下的頁面或草稿（.drafts/<id>）：按第一次只是待確認（打勾），再按才刪；頁面也從勾選清單拿掉。
  deleteWikiFile: (path: string) => unknown
  openWikiDraft: (id: string) => unknown
  // 照打開的草稿改 wiki（寫整頁、搬移、刪除）並刪掉草稿；捨棄只刪草稿。
  acceptWikiDraft: () => unknown
  discardWikiDraft: () => unknown
  // 請 Claude 把這段對話值得留下的整理成草稿。
  distillWiki: () => unknown
  // 把勾了的頁面送給 Claude（加進這段對話）。
  sendWikiPages: () => unknown
  // Summary Conversation 問哪個模型。
  selectWikiModel: (model: WikiModel) => unknown
  // 終端機的模型選單打開、收起。
  toggleWikiModel: (isOpen: boolean) => unknown
  // services
  runServiceAction: (s: Service, action: ServiceAction) => unknown
  // 關掉停止／重跑失敗的提示（定時掃描不會洗掉它）。
  dismissServiceError: () => unknown
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
  // http：id 是請求（<檔名>#<第幾個>），name 是請求用到的變數。
  openHttpRequest: (id: string) => unknown
  closeHttpRequest: () => unknown
  // 送出點開的請求：任何環境都按一次就送。
  sendHttp: () => unknown
  // 貼上的機密存進 Keychain／DPAPI（依 session 資料夾和環境）；刪除要按兩次；editHttpSecret 打開（'' 收起）換值的框。
  saveHttpSecret: (name: string, text: string) => unknown
  deleteHttpSecret: (name: string) => unknown
  editHttpSecret: (name: string) => unknown
  toggleHttpHeaders: (isOpen: boolean) => unknown
  // HTTP 底下那排：API（請求）或 Environment（環境、變數、機密）。
  selectHttpPage: (page: HttpPage) => unknown
  // 在面板上寫 .soap/http：新請求、編輯點開的請求（那段原文）；打字跟著存草稿，Save 寫檔，刪請求要按兩次。
  newHttpRequest: () => unknown
  editHttpRequest: () => unknown
  typeHttpDraft: (change: { text?: string; file?: string }) => unknown
  saveHttpDraft: (text?: string) => unknown
  cancelHttpDraft: () => unknown
  deleteHttpRequest: () => unknown
  // Environment：+ New 打開（false 收起）新環境名稱的框、新增、刪那一列的環境（兩次）；
  // 變數：+ New 或點一列打開名稱、值兩行的框，打字跟著存，Enter 或 Save 寫檔；刪除兩次。
  openAddHttpEnv: (isOpen: boolean) => unknown
  addHttpEnv: (name?: string) => unknown
  typeHttpEnvName: (name: string) => unknown
  deleteHttpEnv: (env: string) => unknown
  // 點環境：選它（Send 用它）並打開它的變數；closeHttpEnv 回環境清單。
  openHttpEnv: (env: string) => unknown
  closeHttpEnv: () => unknown
  newHttpVar: () => unknown
  editHttpVar: (name: string) => unknown
  typeHttpVar: (change: { name?: string; value?: string }) => unknown
  saveHttpVar: (change?: { name?: string; value?: string }) => unknown
  cancelHttpVar: () => unknown
  deleteHttpVar: (name: string) => unknown
  // ci（GitLab）：搜尋分支、換頁，點分支看它的 pipeline、點 pipeline 看 job、點 job 看 log，Back 回上一層；Refresh 重讀看得到的那層。
  showCiPage: (page: number) => unknown
  searchCi: (text: string) => unknown
  openCiRef: (ref: string) => unknown
  closeCiRef: () => unknown
  openPipeline: (p: CiPipeline) => unknown
  closeCiPipeline: () => unknown
  openCiJob: (j: CiJob) => unknown
  closeCiJob: () => unknown
  refreshCi: () => unknown
  // 貼上的 GitLab token：GitLab 認得才存（Keychain／DPAPI），換掉舊的；打開、收起換 token 的框。
  saveCiToken: (text: string) => unknown
  toggleCiToken: (isOpen: boolean) => unknown
  // 跑、重跑：都要按兩次。pipeline 的 Retry 重跑裡面失敗的 job；job 的 Run（play）跑 manual job、Retry 重跑跑完的。
  retryCiPipeline: () => unknown
  actOnCiJob: (j: CiJob, kind: CiJobAction) => unknown
  // mr（GitLab）：點 MR 看它的狀態和建議，Back 回清單；Refresh 重讀看得到的那層。
  openMr: (iid: number) => unknown
  closeMr: () => unknown
  refreshMr: () => unknown
  // Approve（false 是取消）一按就做；Merge、套用建議要按兩次。
  approveMr: (isApprove: boolean) => unknown
  mergeMr: () => unknown
  applyMrSuggestion: (s: MrSuggestion) => unknown
  toggleMrResolved: () => unknown
  // 在瀏覽器打開 GitLab 的頁面。
  openMrLink: (url: string) => unknown
  // 合併（畫在 Soap Panel 裡）
  editChunks: (edit: (chunks: MergeChunk[]) => MergeChunk[]) => unknown
  jumpConflict: (step: 1 | -1) => unknown
  takeSide: (side: 'ours' | 'theirs' | 'as-is') => unknown
  applyMerge: () => unknown
  askClaude: () => unknown
  // 把焦點圈移到這個輸入框（終端機點框裡的空白時）。
  focusInput: (key: string) => unknown
}

// Soap Panel 畫一次要的全部資料。
export type PanelData = {
  surface: RenderSurface
  bodyRows: number
  tab: TabId
  // 有子分頁的 Tab 各自看的子分頁。
  subTabs: SubTabs
  view: GitView
  showRemote: boolean
  branchFolders: Readonly<Record<string, boolean>>
  branchQuery: string
  // diff 分頁看的第幾頁（從 0 開始；檔案變少時畫的那邊會夾回最後一頁）。
  filePage: number
  // 每個地方的長差異看到第幾頁（ui/widgets 的 w.diff 用）。
  diffPages: Readonly<Record<string, DiffPage>>
  // 正在跑的 Fetch／Pull，'' 是沒有。
  syncing: GitSync | ''
  services: ServicesView
  files: FilesView
  // Files 的選單寫 Show in Explorer 還是 Show in Finder；選單沒開時沒問，一律 false。
  isWindows: boolean
  spec: SpecView
  wiki: WikiView
  // Wiki 子分頁資料夾的開合；沒有的是打開。
  wikiFolders: Readonly<Record<string, boolean>>
  // 對話目前用的模型種類；讀不到是 ''。
  currentModel: WikiModel | ''
  // 這段對話已經送過的 wiki 頁面。
  wikiSent: readonly string[]
  /** Distill is waiting on Claude. */
  isDistilling: boolean
  db: DbView
  dbBusy: DbBusy
  http: HttpView
  // HTTP 正在送出請求、存貼上的機密，或把草稿寫進檔案。
  httpBusy: HttpBusy
  // @capture 取到的、選中環境的變數（只放記憶體）。
  httpCaptured: Readonly<Record<string, string>>
  ci: CiView
  // 正在檢查、存貼上的 GitLab token。
  ciSaving: boolean
  // 正在跑、重跑（等 GitLab 回）。
  ciActing: boolean
  mr: MrView
  // 正在 approve、merge、套用建議（等 GitLab 回）。
  mrActing: boolean
  // 正在停掉／重跑的服務。
  servicePending: readonly ServicePending[]
  // 等著再按一次的按鈕的 key（見 shell.ts 的 isConfirmed），'' 是沒有。
  armed: string
  log: LogView
  logQuery: string
  // 蓋住分頁的差異、三欄合併或檔案內容；kind 是 none 時畫分頁。isMergeBusy：合併正在套用。
  cover: Cover
  isMergeBusy: boolean
  usage: readonly UsageReading[]
  now: number
}
