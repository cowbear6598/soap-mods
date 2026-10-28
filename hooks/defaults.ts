// 各個狀態的初始值，和換分頁時要清掉的訊息。狀態本身（atom）在 register.tsx：引擎只認得那裡宣告的。

import type { CiView, MrView, DbView, HttpView, DiffPaneView, FileView, FilesView, GitView, LogView, MergeView, Plan, ServicesView, SpecView, WikiSent, WikiView } from '../types'

export const EMPTY: GitView = {
  isLoaded: false,
  isRepo: true,
  files: [],
  branches: [],
  error: '',
  branchError: '',
  op: '',
  opError: '',
  fileError: '',
  repos: [],
  repo: '',
}

export const EMPTY_CI: CiView = {
  isLoaded: false,
  host: '',
  hasToken: false,
  user: '',
  isTokenOpen: false,
  tokenError: '',
  query: '',
  branches: [],
  page: 0,
  error: '',
  ref: null,
  pipelines: null,
  pipelinePage: 0,
  hasNext: false,
  pipelinesError: '',
  actionError: '',
  open: null,
  jobs: null,
  jobsError: '',
  job: null,
  trace: null,
  isTraceTruncated: false,
  traceError: '',
}

export const EMPTY_MR: MrView = {
  isLoaded: false,
  host: '',
  hasToken: false,
  list: [],
  error: '',
  open: null,
  opening: 0,
  detailError: '',
  suggestions: null,
  showResolved: false,
  actionError: '',
}

export const EMPTY_SERVICES: ServicesView = { isLoaded: false, items: [], error: '', actionError: '' }

export const NO_FILE_MENU = { menu: '', menuError: '' } satisfies Partial<FilesView>

export const EMPTY_FILES: FilesView = { dir: '', isLoaded: false, entries: [], total: 0, error: '', query: '', found: null, ...NO_FILE_MENU }

export const EMPTY_FILE_VIEW: FileView = { path: '', text: '', isTruncated: false, note: '', error: '', stamp: '' }

export const EMPTY_PLAN: Plan = { branch: '', issueNumber: '', description: '', goals: [], constraints: [], related: [], verify: [] }

export const EMPTY_SPEC: SpecView = { isLoaded: false, specs: [], error: '', open: '', deleteError: '', plan: EMPTY_PLAN, problems: [], stamp: '' }

// 關掉 Wiki 子分頁打開的頁面或草稿，回到清單。
export const NO_WIKI_OPEN = { open: '', draft: '', text: '', diff: '', isTruncated: false, readError: '' } satisfies Partial<WikiView>

export const EMPTY_WIKI: WikiView = {
  isLoaded: false,
  pages: [],
  checked: [],
  drafts: [],
  error: '',
  deleteError: '',
  model: '',
  isModelOpen: false,
  distillNote: '',
  ...NO_WIKI_OPEN,
}

export const NO_WIKI_SENT: WikiSent = { conversation: '', pages: [] }

// 離開打開的連線（回清單、換連線）時清掉的東西。
export const NO_DB_CONNECTION = { open: '', tables: null, table: '', columns: [], query: '', result: null, error: '', queryError: '' } satisfies Partial<DbView>

export const EMPTY_DB: DbView = { isLoaded: false, connections: [], ...NO_DB_CONNECTION }

export const EMPTY_HTTP: HttpView = {
  isLoaded: false,
  page: 'api',
  requests: [],
  error: '',
  envs: [],
  env: '',
  vars: {},
  ownVars: {},
  envError: '',
  secrets: [],
  open: '',
  result: null,
  sendError: '',
  editing: '',
  secretError: '',
  showHeaders: false,
  draft: null,
  draftError: '',
  varDraft: null,
  isAddingEnv: false,
  newEnvName: '',
  isEnvOpen: false,
  envFormError: '',
}

export const EMPTY_MERGE: MergeView = {
  path: '',
  hasMarkers: false,
  chunks: [],
  eol: '\n',
  hasFinalEol: true,
  oursLabel: '',
  theirsLabel: '',
  error: '',
}

export const EMPTY_LOG: LogView = {
  ref: '',
  isLoaded: false,
  commits: [],
  unpushed: [],
  page: 0,
  hasNext: false,
  isTruncated: false,
  error: '',
  isPicking: false,
  rangeStart: '',
  opened: [],
  files: null,
  commitError: '',
}

export const EMPTY_DIFF: DiffPaneView = {
  path: '',
  kind: 'modified',
  diff: '',
  isTruncated: false,
  error: '',
  commits: [],
  files: [],
}

// 關掉 log 分頁打開的 commit；選範圍也一起結束。
export const NO_COMMIT: Partial<LogView> = { opened: [], files: null, commitError: '', isPicking: false, rangeStart: '' }

// Git 分頁的錯誤訊息：換分頁、換 repo 時清掉。
export const NO_MESSAGES = { branchError: '', opError: '', fileError: '' } as const
