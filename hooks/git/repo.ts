// 找 repo、讀 status 用的 git 參數，和解析它們的純函式。

import type { ProcessRunResult } from 'claude-code'

import type { GitFile, GitSync, RepoSummary } from '../../types'
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

export const NO_GIT = 'git not found. Make sure it is installed and on your PATH.'

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
