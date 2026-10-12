// 各個狀態的初始值，和換分頁時要清掉的訊息。狀態本身（atom）在 register.tsx：引擎只認得那裡宣告的。

import type { DiffPaneView, GitView, LogView, MergeView, ServicesView } from '../types'
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
  commit: null,
  files: null,
  commitError: '',
}

export const EMPTY_DIFF: DiffPaneView = { path: '', kind: 'modified', at: '', diff: '', isTruncated: false, error: '' }

// 切換／刪除分支、abort／continue 失敗的訊息和待確認的刪除、abort：換分頁、換 repo 時清掉。
export const NO_MESSAGES = { branchError: '', deleteArmed: null, opError: '', isAbortArmed: false } as const
