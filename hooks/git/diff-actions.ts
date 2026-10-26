// 差異（畫在 Soap Panel 裡）：工作區檔案、commit 裡的檔案，和 diff 分頁的刪除、rollback。

import type { CommitFile, DiffPaneView, GitCommit, GitFile } from '../../types'
import { coverData, showCover } from '../cover'
import { EMPTY_DIFF, NO_MESSAGES } from '../defaults'
import { errorText } from '../errors'
import { neighbour } from '../neighbour'
import { removePath } from '../shell'
import { commitRange, diffSteps, fileKind, letterKind, toHunks } from './parse'
import { gitErrorText } from './repo'
import { type GitIo, git, gitOk, inRepo, isGitConfirmed } from './run'

// 開著的差異；開著的不是它就是空的（path 是 ''）。
async function readDiffCover(io: GitIo) {
  return coverData(await io.getCover(), 'diff') ?? EMPTY_DIFF
}

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']

// 跑一次 diff，只留 hunk（w.diff 畫的）；讀不到就帶著錯誤訊息。
// fallback：結束碼不是 0 時改跑的另一個 diff（還沒有任何 commit 時沒有 HEAD，改看已暫存的內容）。
async function runDiff(io: GitIo, args: string[], fallback?: string[]) {
  let out = ''
  let isTruncated = false
  let error = ''
  try {
    const r = await git(io, args)
    if (r.exitCode === 0 || fallback === undefined) {
      out = r.stdout
      isTruncated = r.isStdoutTruncated
      if (r.exitCode !== 0) error = r.stderr.trim()
    } else {
      const again = await git(io, fallback)
      out = again.stdout
      isTruncated = again.isStdoutTruncated
      if (again.exitCode !== 0) error = again.stderr.trim() || r.stderr.trim()
    }
  } catch (err) {
    error = `Failed to read diff: ${errorText(err)}`
  }

  return { diff: toHunks(out), isTruncated, error }
}

// 讀工作區一個檔案的 diff：已追蹤的對 HEAD，未追蹤的對空檔案。
// Previous／Next 照 diff 分頁的檔案順序走（diffSteps）；每次 refresh 都會重讀，清單跟著更新。
export async function readDiff(io: GitIo, files: GitFile[], path: string): Promise<DiffPaneView> {
  const file = files.find(f => f.path === path)
  if (file === undefined) return EMPTY_DIFF
  const result = await (file.x === '?'
    ? runDiff(io, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path])
    : runDiff(io, ['diff', ...DIFF_FLAGS, 'HEAD', '--', path], ['diff', ...DIFF_FLAGS, '--cached', '--', path]))

  return { ...EMPTY_DIFF, path, kind: fileKind(file), ...result, files: diffSteps(files) }
}

// 在 Soap Panel 裡看這個檔案的差異（蓋掉分頁），捲回最上面從頭看。按的那列不見了，焦點圈由 checkPressed 移到 Back。
async function showDiff(io: GitIo, pane: DiffPaneView) {
  await io.updateCover(c => showCover(c, 'diff', pane))
  await io.scrollTop()
}

// diff 分頁的垃圾桶和 rollback 都要按兩次：按了換成打勾，DELETE_ARM_MS 內再按同一顆才做（Staged、Unstaged 都列著的兩列一起打勾，做的事一樣）。
// delete 只刪工作區的檔案，index 不動：有追蹤的之後列成刪除。未追蹤的巢狀 repo 列成「sub/」，canDelete 不給刪。
// rollback 只把 index 和工作區都還原成 HEAD 的樣子，不刪 HEAD 沒有的檔案。不經過資源回收筒，也沒有 undo。
export async function changeFile(io: GitIo, file: GitFile, action: 'delete' | 'rollback') {
  if (!(await isGitConfirmed(io, `file:${action}:${file.path}`))) return
  try {
    if (action === 'delete') await removePath(io, inRepo(file.path))
    else await gitOk(io, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path])
  } catch (err) {
    await io.setView({ ...NO_MESSAGES, fileError: `Couldn't ${action === 'delete' ? 'delete' : 'roll back'} ${file.path}: ${gitErrorText(err)}` })

    return
  }

  // 不跳 toast：那顆按鈕不見就是做完了。
  await io.leaveRow()
  await io.setView(NO_MESSAGES)
  await io.refresh()
}

export async function openDiff(io: GitIo, path: string) {
  await showDiff(io, await readDiff(io, (await io.getView()).files, path))
}

// 讀 commit 裡一個檔案在這（幾）個 commit 的差異。改名的檔案兩個路徑都要給，git 才認得出是改名。
// files 是同一批的全部檔案，Previous／Next 照它走。
async function readCommitDiff(io: GitIo, commits: GitCommit[], f: CommitFile, files: CommitFile[]): Promise<DiffPaneView> {
  const paths = f.oldPath === '' ? [f.path] : [f.oldPath, f.path]
  const result = await runDiff(io, ['diff-tree', '-p', '-M', ...DIFF_FLAGS, '--no-commit-id', ...commitRange(commits), '--', ...paths])

  return { ...EMPTY_DIFF, path: f.path, kind: letterKind(f.letter), ...result, commits, files }
}

export async function openCommitDiff(io: GitIo, commits: GitCommit[], f: CommitFile, files: CommitFile[]) {
  await showDiff(io, await readCommitDiff(io, commits, f, files))
}

export async function stepDiffFile(io: GitIo, step: 1 | -1) {
  const d = await readDiffCover(io)
  const next = neighbour(d.files, f => f.path === d.path, step)
  if (next === undefined) return
  const isWorkTree = d.commits.length === 0
  await showDiff(io, await (isWorkTree ? readDiff(io, (await io.getView()).files, next.path) : readCommitDiff(io, d.commits, next, d.files)))
}
