// 各個狀態的初始值，和換分頁時要清掉的訊息。狀態本身（atom）在 register.tsx：引擎只認得那裡宣告的。

import type { DiffPaneView, FileView, FilesView, GitView, LogView, MergeView, Plan, ServicesView, SpecView } from '../types'
import { LOG_PAGE } from './config'

export const EMPTY: GitView = {
  isLoaded: false,
  isRepo: true,
  files: [],
  branches: [],
  error: '',
  branchError: '',
  deleteArmed: null,
  copied: '',
  op: '',
  opError: '',
  isAbortArmed: false,
  repos: [],
  repo: '',
}

export const EMPTY_SERVICES: ServicesView = { isLoaded: false, items: [], error: '', actionError: '' }

export const EMPTY_FILES: FilesView = { dir: '', isLoaded: false, entries: [], total: 0, error: '' }

export const EMPTY_FILE_VIEW: FileView = { path: '', text: '', isTruncated: false, note: '', error: '', stamp: '' }

export const EMPTY_PLAN: Plan = { branch: '', issueNumber: '', description: '', goals: [], constraints: [], related: [], verify: [] }

export const EMPTY_SPEC: SpecView = { isLoaded: false, specs: [], error: '', open: '', plan: EMPTY_PLAN, problems: [], stamp: '' }

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

// 切換／刪除分支、abort／continue 失敗的訊息和待確認的刪除、abort：換分頁、換 repo 時清掉。
export const NO_MESSAGES = { branchError: '', deleteArmed: null, opError: '', isAbortArmed: false } as const
