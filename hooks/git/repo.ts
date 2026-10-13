// 找 repo、讀 status 用的 git 參數，和解析它們的純函式。

import type { ProcessRunResult } from 'claude-code'

import type { GitFile, GitSync, RepoSummary } from '../../types'
import { errorText, isMissingCommand } from '../errors'
import { isConflict, splitPath } from './parse'

// 一個 repo：根目錄、.git 資料夾、資料夾名稱。status 給的路徑都相對根目錄，
// 所以知道根目錄之後 git 一律在根目錄跑，讀寫檔案也接在根目錄後面。
export type Repo = { name: string; root: string; gitDir: string }

export const REPO_ARGS = ['rev-parse', '--show-toplevel', '--absolute-git-dir']
export const STATUS_ARGS = ['status', '--porcelain=v1', '-b', '-z', '-uall']
// 其他 repo 只看有沒有變更、有沒有衝突：不用分支、不展開未追蹤的資料夾，比較快。
export const SUMMARY_ARGS = ['status', '--porcelain=v1', '-z']

// branch 分頁的 Fetch／Pull。fetch 抓所有遠端、清掉遠端已經刪的分支；pull 只快轉，跟遠端分岔了就失敗，
// 讓人自己決定 merge 還是 rebase。
export const SYNC_ARGS: Record<GitSync, string[]> = {
  fetch: ['fetch', '--all', '--prune'],
  pull: ['pull', '--ff-only'],
}

const NO_GIT = 'git not found. Make sure it is installed and on your PATH.'

// 每次跑 git 都帶的環境變數。repo 自己的設定（.git/config）可以讓 git 執行指令：core.fsmonitor、
// log.showSignature 搭 gpg.program。面板每個回合都會自己跑 git，資料夾裡有別人給的 repo 時不能讓它決定要跑什麼，
// 所以用 GIT_CONFIG_COUNT 蓋過去（優先權跟 -c 一樣，git 2.31 起）。
// GIT_OPTIONAL_LOCKS=0：背景讀 status 時不搶 index.lock，不會跟使用者自己跑的 git 撞在一起。
export const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'log.showSignature',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_OPTIONAL_LOCKS: '0',
}

// 跑 git 失敗時給人看的訊息：git 根本跑不起來就說沒裝，其餘照錯誤原文。
export const gitErrorText = (err: unknown) => (isMissingCommand(err) ? NO_GIT : errorText(err))

export const isNotRepo = (r: ProcessRunResult) => r.stderr.includes('not a git repository')

// rev-parse 的輸出（根目錄一行、.git 資料夾一行）；不是 repo 或讀不到就是 undefined。名稱是根目錄的資料夾名。
export function parseRepo(r: ProcessRunResult): Repo | undefined {
  const [root = '', gitDir = ''] = r.exitCode === 0 ? r.stdout.split('\n').map(s => s.trim()) : []

  return root === '' || gitDir === '' ? undefined : { name: splitPath(root).name, root, gitDir }
}

export const toSummary = (r: Repo, files: GitFile[]): RepoSummary => ({
  name: r.name,
  root: r.root,
  isDirty: files.length > 0,
  hasConflict: files.some(isConflict),
})
