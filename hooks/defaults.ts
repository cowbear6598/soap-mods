// 各個狀態的初始值，和換分頁時要清掉的訊息。狀態本身（atom）在 register.tsx：引擎只認得那裡宣告的。

import type { DbView, DiffPaneView, FileView, FilesView, GitView, LogView, MergeView, Plan, ServicesView, SpecView } from '../types'
import { LOG_PAGE } from './config'

export const EMPTY: GitView = {
  isLoaded: false,
  isRepo: true,
  files: [],
  branches: [],
  error: '',
  branchError: '',
  deleteArmed: null,
  switchArmed: '',
  copied: '',
  op: '',
  opError: '',
  isAbortArmed: false,
  repos: [],
  repo: '',
}

export const EMPTY_SERVICES: ServicesView = { isLoaded: false, items: [], error: '', actionError: '' }

export const NO_FILE_MENU = { menu: '', isDeleteArmed: false, menuError: '' } satisfies Partial<FilesView>

export const EMPTY_FILES: FilesView = { dir: '', isLoaded: false, entries: [], total: 0, error: '', query: '', found: null, ...NO_FILE_MENU }

export const EMPTY_FILE_VIEW: FileView = { path: '', text: '', isTruncated: false, note: '', error: '', stamp: '' }

export const EMPTY_PLAN: Plan = { branch: '', issueNumber: '', description: '', goals: [], constraints: [], related: [], verify: [] }

export const EMPTY_SPEC: SpecView = { isLoaded: false, specs: [], error: '', open: '', deleteArmed: '', deleteError: '', plan: EMPTY_PLAN, problems: [], stamp: '' }

// 離開打開的連線（回清單、換連線）時清掉的東西。
export const NO_DB_CONNECTION = { open: '', tables: null, table: '', columns: [], query: '', result: null, error: '', queryError: '' } satisfies Partial<DbView>

export const EMPTY_DB: DbView = { isLoaded: false, connections: [], deleteArmed: '', ...NO_DB_CONNECTION }

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
  limit: LOG_PAGE,
  hasMore: false,
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

// 切換／刪除分支、abort／continue 失敗的訊息和待確認的切換、刪除、abort：換分頁、換 repo 時清掉。
export const NO_MESSAGES = { branchError: '', deleteArmed: null, switchArmed: '', opError: '', isAbortArmed: false } as const
