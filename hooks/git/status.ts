// Git 分頁的狀態：找 repo 和它的 worktree、讀狀態、分支和其他 repo 的摘要，換 repo、換 worktree。

import type { GitFile, GitView, RepoSummary, TabId } from '../../types'
import { WORKTREE_MENU } from '../config'
import { NO_COVER, coverData, showCover } from '../cover'
import { EMPTY, EMPTY_LOG, NO_MESSAGES } from '../defaults'
import { coalesce } from '../latest'
import { detectOp } from '../merge/algo'
import { mergeBusy, syncMerge } from '../merge/actions'
import { disarm } from '../shell'
import { readDiff } from './diff-actions'
import { dropLog, loadLog } from './log-actions'
import { BRANCH_FORMAT, parseBranches, parseStatus } from './parse'
import type { Repo } from './repo'
import { REPO_ARGS, STATUS_ARGS, SUMMARY_ARGS, WORKTREE_ARGS, gitErrorText, isNotRepo, parseRepo, parseWorktrees, toSummary } from './repo'
import { type GitIo, git, repos } from './run'

// 找 repo：session 資料夾本身是 repo 就只有它；不是的話看下一層有 .git 的資料夾。
// 已經找過的不再問 git，只有新的才跑一次 rev-parse。
// 用 session.root 不用 session.cwd：cwd 會跟著 Bash 的 cd 跑（例如 cd 進 a 去 commit），其他 repo 就不見了。
async function findRepos(io: GitIo): Promise<Repo[]> {
  const cwd = await io.root()
  const self = parseRepo(await git(io, REPO_ARGS, { cwd }))
  if (self !== undefined) return [self]
  const entries = await io.list(cwd).catch(() => [])
  const found = await Promise.all(
    entries
      .filter(e => e.kind === 'dir' && !e.name.startsWith('.'))
      .map(async e => {
        const dir = `${cwd}/${e.name}`
        if (!(await io.exists(`${dir}/.git`).catch(() => false))) return undefined

        return repos.list.find(c => c.name === e.name) ?? parseRepo(await git(io, REPO_ARGS, { cwd: dir }))
      }),
  )

  return byName(found)
}

const byName = (found: (Repo | undefined)[]) => found.filter(c => c !== undefined).sort((a, b) => a.name.localeCompare(b.name))

// 這個 repo 屬於哪個專案（repo bar 的哪一顆）：專案本身，或 .git 資料夾在專案的 .git/worktrees/ 底下的 worktree。
const projectOf = (r: Repo | undefined) =>
  r === undefined ? undefined : repos.list.find(p => p.root === r.root || r.gitDir.startsWith(`${p.gitDir}/worktrees/`))

// 重找 repo 和選中專案的 worktree，再找回看的那個：還在就留著；選的 worktree 不在了（被刪）回到它的專案，
// 專案也不在了（或還沒選過）就換成第一個。熱重載後模組變數從頭來，看的那個從畫面狀態（view.repo、view.worktree，
// 重載後還在）找回來，不會跳回第一個。
async function reloadRepos(io: GitIo) {
  const saved = repos.current === undefined ? await io.getView() : undefined
  const projectName = saved?.repo ?? projectOf(repos.current)?.name
  const shownRoot = saved?.worktree ?? repos.current?.root
  repos.list = await findRepos(io)
  const project = repos.list.find(p => p.name === projectName) ?? repos.list[0]
  repos.worktrees = project === undefined ? [] : await findWorktrees(io, project)
  repos.current = repos.worktrees.find(w => w.root === shownRoot) ?? project
}

// 選中的專案的 worktree，照名稱排：Claude Code 開在 .claude/worktrees 底下的，和 Claude 用 git worktree add 開在別處（例如它的暫存資料夾）的。
// 已經找過的不再問 git，只有新的才跑一次 rev-parse（.git 資料夾是 .git/worktrees/ 底下那個）。
// 從沒開過 worktree 的專案沒有 .git/worktrees，不用每次 refresh 都跑 git worktree list。
async function findWorktrees(io: GitIo, project: Repo): Promise<Repo[]> {
  if (!(await io.exists(`${project.gitDir}/worktrees`).catch(() => false))) return []
  const listed = await git(io, WORKTREE_ARGS, { cwd: project.root })
  if (listed.exitCode !== 0) return []
  const found = await Promise.all(
    parseWorktrees(listed.stdout)
      .filter(path => path !== project.root)
      .map(async path => repos.worktrees.find(w => w.root === path) ?? parseRepo(await git(io, REPO_ARGS, { cwd: path }))),
  )

  return byName(found)
}

// 其他 repo 有沒有變更、有沒有衝突；讀不到就當作沒有變更。
async function summarize(io: GitIo, r: Repo): Promise<RepoSummary> {
  const status = await git(io, SUMMARY_ARGS, { cwd: r.root }).catch(() => undefined)

  return toSummary(r, status?.exitCode === 0 ? parseStatus(status.stdout) : [])
}

// .git 資料夾裡有哪些檔案（看得出停在 merge 還是 rebase）。
async function readGitDir(io: GitIo, r: Repo): Promise<string[]> {
  return io.list(r.gitDir).then(
    entries => entries.map(entry => entry.name),
    () => [],
  )
}

// 上一次解析的 git 輸出：輸出一字不差就沿用上次的結果，不重新解析、排序。
function parseOnce<T>(parse: (out: string) => T) {
  let last: { out: string; value: T } | undefined

  return (out: string) => {
    if (last?.out !== out) last = { out, value: parse(out) }

    return last.value
  }
}

const parseActiveStatus = parseOnce(parseStatus)
const parseActiveBranches = parseOnce(parseBranches)

// 讀到一半又被叫（回合結束、按了按鈕、換了 repo）就讀完再補讀一次；有補讀排著時，這次讀到的可能是舊的，就不寫，交給補讀。
const gitReads = coalesce()

// worktree 選單正要打開：這次讀要連各 worktree 有沒有變更一起讀（readWorktreeMenu）。
let isOpeningMenu = false

export function refresh(io: GitIo): Promise<void> {
  return gitReads.run(() => readGit(io))
}

// 畫得到 git 的分頁要讀的：Git 讀完整的狀態；Tools 的 Services 子分頁只照 repo 分組，只重找 repo，不讀狀態、分支、其他 repo 的摘要。
// sub 是 Tab 看著的子分頁。新分頁預設不讀 git。
export function refreshTab(io: GitIo, t: TabId, sub?: string): Promise<void> | undefined {
  if (t === 'git') return refresh(io)
  if (t === 'tools' && sub === 'services') return refreshRepoList(io)

  return undefined
}

// 只重找 repo：Services 分頁照 repo 分組，Git 的 CI 子分頁只要知道選中的 repo。
export const refreshRepoList = (io: GitIo) => gitReads.run(() => readRepoList(io))

// 重找 repo，那排 repo 已經讀過的摘要留著，新的當作沒有變更（換到 Git 分頁時整個重讀）。
async function readRepoList(io: GitIo) {
  await reloadRepos(io)
  const shown = (await io.getView()).repos
  await io.setView({ repos: repos.list.map(r => shown.find(s => s.root === r.root) ?? toSummary(r, [])) })
}

// 看的 repo 的狀態、分支、.git 裡的檔案。讀的 repo 固定下來：中途換了 repo，也不會把這個 repo 的狀態算到別的 repo 頭上。
async function readShown(io: GitIo, r: Repo) {
  const [status, refs, names] = await Promise.all([
    git(io, STATUS_ARGS, { cwd: r.root }),
    git(io, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { cwd: r.root }),
    readGitDir(io, r),
  ])

  return { status, refs, names }
}

// 那排 repo 和 worktree 選單上其他的 repo 有沒有變更；看的那個是 undefined（用完整讀到的狀態）。
// worktree 的只在選單打開時（和正要打開時）讀：收著時只看得到選的那個；沒讀的沿用上次畫的。
async function readOthers(io: GitIo, active: Repo) {
  const v = await io.getView()
  const isFresh = (await io.getOpenMenu()) === WORKTREE_MENU || isOpeningMenu
  const other = (c: Repo, read: () => Promise<RepoSummary> | RepoSummary) => (c.root === active.root ? undefined : read())
  const kept = (c: Repo) => v.worktrees.find(s => s.root === c.root) ?? toSummary(c, [])

  return Promise.all([
    Promise.all(repos.list.map(c => other(c, () => summarize(io, c)))),
    Promise.all(repos.worktrees.map(c => other(c, () => (isFresh ? summarize(io, c) : kept(c))))),
  ])
}

// 重新讀 git 狀態、檔案清單、分支清單，保留原本點開的檔案；最後只寫一次 view，只重畫一次。
async function readGit(io: GitIo) {
  const isStale = gitReads.isWanted
  let snap
  try {
    // 先照上次看的 repo 讀狀態，跟重找 repo 同時跑；重找完換了 repo 才重讀。
    const before = repos.current
    const early = before === undefined ? undefined : readShown(io, before)
    early?.catch(() => undefined)
    await reloadRepos(io)
    const active = repos.current
    if (active === undefined) {
      if (!isStale()) await io.setView({ ...EMPTY, isLoaded: true, isRepo: false })

      return
    }
    const isSame = before?.root === active.root
    // 看的 repo 不見了（選的 worktree 或專案被刪），換成別的：開著的差異／合併是它的檔案，回到分頁。
    if (before !== undefined && !isSame) await leaveShown(io, {})
    const [shown, [projects, worktrees]] = await Promise.all([isSame && early !== undefined ? early : readShown(io, active), readOthers(io, active)])
    snap = { project: projectOf(active) ?? active, active, projects, worktrees, ...shown }
  } catch (err) {
    if (!isStale()) await io.setView({ isLoaded: true, isRepo: false, error: gitErrorText(err) })

    return
  }
  if (isStale()) return

  const { project, active, status, refs, names, projects, worktrees } = snap
  // 那排 repo 和 worktree 選單：看的那個用下面完整讀到的狀態，其他的用 summarize 的。
  const fill = (others: (RepoSummary | undefined)[], changes: GitFile[]) => others.map(o => o ?? toSummary(active, changes))
  const bars = (changes: GitFile[]) => ({
    repos: fill(projects, changes),
    worktrees: fill(worktrees, changes),
    repo: project.name,
    worktree: active.root === project.root ? '' : active.root,
  })

  if (status.exitCode !== 0) {
    // 開著工作區檔案的差異就關掉；commit 裡的檔案不受影響。
    await io.updateCover(c => (coverData(c, 'diff')?.commits.length === 0 ? NO_COVER : c))
    await io.setView({
      isLoaded: true,
      isRepo: false,
      error: isNotRepo(status) ? '' : status.stderr.trim(),
      files: [],
      branches: [],
      ...bars([]),
    })

    return
  }

  const changes = parseActiveStatus(status.stdout)
  // 開著工作區檔案的差異就重讀；那個檔案已經沒有變更了，readDiff 給空的，就回到分頁。
  // 開著的是 commit 裡的檔案就不用動，commit 不會變。內容沒變就不寫，整個 Soap Panel 不會白白重畫；
  // 讀的時候換了畫面（按了 Back、換了檔案）也不寫。
  const shown = coverData(await io.getCover(), 'diff')
  const reread = shown !== undefined && shown.commits.length === 0 ? await readDiff(io, changes, shown.path) : undefined
  if (isStale()) return
  await Promise.all([
    io.setView({
      isLoaded: true,
      isRepo: true,
      error: '',
      files: changes,
      ...bars(changes),
      branches: refs.exitCode === 0 ? parseActiveBranches(refs.stdout) : [],
      op: detectOp(names),
    }),
    reread === undefined
      ? undefined
      : io.updateCover(c => {
          const cur = coverData(c, 'diff')
          if (cur === undefined || cur.path !== shown?.path || cur.commits.length > 0) return c

          return reread.path === '' ? NO_COVER : showCover(c, 'diff', reread)
        }),
  ])
  // log 只在看得到時重讀（換到 log 分頁時也會讀）。
  await Promise.all([syncMerge(io, changes), (await io.getSubTabs()).git === 'log' ? loadLog(io) : undefined])
}

// 換 Git 分頁看的 repo：開著的差異／合併是上一個 repo 的檔案，回到分頁；合併正在寫檔時不換。
// 換專案時 worktree 回到 main（專案本身）；refresh 讀到新專案的 worktree 才再畫選單（按 repo 時選單已經收了）。
export async function selectRepo(io: GitIo, name: string) {
  const next = repos.list.find(c => c.name === name)
  if (next === undefined || next === projectOf(repos.current) || mergeBusy()) return
  repos.current = next
  await leaveShown(io, { repo: name, worktree: '', worktrees: [] })
  await refresh(io)
}

// worktree 選單選了一個：root 是那個 worktree 的根目錄，'' 是專案本身（main）。跟換 repo 一樣，開著的差異／合併回到分頁。
export async function selectWorktree(io: GitIo, root: string) {
  const next = root === '' ? projectOf(repos.current) : repos.worktrees.find(w => w.root === root)
  if (next === undefined || next === repos.current || mergeBusy()) return
  repos.current = next
  await leaveShown(io, { worktree: root })
  await refresh(io)
}

// 各 worktree 的 * 和 ! 只在選單打開時讀（見 readOthers）：打開前先讀完再打開，一打開就是最新的，不會先閃舊的。
export async function readWorktreeMenu(io: GitIo) {
  isOpeningMenu = true
  try {
    await refresh(io)
  } finally {
    isOpeningMenu = false
  }
}

// Git 分頁換看別的 repo（換專案、換 worktree、選的 worktree 被刪）：開著的差異／合併、讀到一半的 log 是上一個的，都放掉。
async function leaveShown(io: GitIo, change: Partial<GitView>) {
  dropLog()
  disarm(io)
  await Promise.all([
    io.setView({ ...change, ...NO_MESSAGES }),
    io.closeCover(),
    // log 換成新 repo 的目前分支。
    io.updateLog(() => EMPTY_LOG),
  ])
}
