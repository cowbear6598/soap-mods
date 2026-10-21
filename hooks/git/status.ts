// Git 分頁的狀態：找 repo、讀狀態、分支和其他 repo 的摘要，換 repo。

import type { GitFile, RepoSummary, TabId } from '../../types'
import { NO_COVER, coverData, showCover } from '../cover'
import { EMPTY, EMPTY_LOG, NO_MESSAGES } from '../defaults'
import { coalesce } from '../latest'
import { detectOp } from '../merge/algo'
import { mergeBusy, syncMerge } from '../merge/actions'
import { readDiff } from './diff-actions'
import { dropLog, loadLog } from './log-actions'
import { BRANCH_FORMAT, parseBranches, parseStatus } from './parse'
import type { Repo } from './repo'
import { REPO_ARGS, STATUS_ARGS, SUMMARY_ARGS, gitErrorText, isNotRepo, parseRepo, toSummary } from './repo'
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

  return found.filter(c => c !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

// 重找 repo：選中的那個還在就留著，不在了（或還沒選過）就換成第一個。
async function reloadRepos(io: GitIo) {
  repos.list = await findRepos(io)
  repos.current = repos.list.find(c => c.root === repos.current?.root) ?? repos.list[0]
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

export function refresh(io: GitIo): Promise<void> {
  return gitReads.run(() => readGit(io))
}

// 畫得到 git 的分頁要讀的：Git 讀完整的狀態；Services 只照 repo 分組，只重找 repo，不讀狀態、分支、其他 repo 的摘要。
// 新分頁預設不讀 git。
export function refreshTab(io: GitIo, t: TabId): Promise<void> | undefined {
  if (t === 'git') return refresh(io)
  if (t === 'services') return gitReads.run(() => readRepoList(io))

  return undefined
}

// 重找 repo，那排 repo 已經讀過的摘要留著，新的當作沒有變更（換到 Git 分頁時整個重讀）。
async function readRepoList(io: GitIo) {
  await reloadRepos(io)
  const shown = (await io.getView()).repos
  await io.setView({ repos: repos.list.map(r => shown.find(s => s.root === r.root) ?? toSummary(r, [])) })
}

// 選中的 repo 的狀態、分支、.git 裡的檔案，和其他 repo 的摘要，一起讀。
// 這次讀的 repo 固定下來：中途換了 repo，也不會把這個 repo 的狀態算到別的 repo 頭上。
async function readRepos(io: GitIo, active: Repo) {
  const [status, refs, names, others] = await Promise.all([
    git(io, STATUS_ARGS, { cwd: active.root }),
    git(io, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { cwd: active.root }),
    readGitDir(io, active),
    Promise.all(repos.list.map(c => (c === active ? undefined : summarize(io, c)))),
  ])

  return { status, refs, names, others }
}

// 重新讀 git 狀態、檔案清單、分支清單，保留原本點開的檔案；最後只寫一次 view，只重畫一次。
async function readGit(io: GitIo) {
  const isStale = gitReads.isWanted
  let snap
  try {
    await reloadRepos(io)
    const active = repos.current
    if (active === undefined) {
      if (!isStale()) await io.setView({ ...EMPTY, isLoaded: true, isRepo: false })

      return
    }
    snap = { active, ...(await readRepos(io, active)) }
  } catch (err) {
    if (!isStale()) await io.setView({ isLoaded: true, isRepo: false, error: gitErrorText(err) })

    return
  }
  if (isStale()) return

  const { active, status, refs, names, others } = snap
  // 那排 repo：選中的那個用下面完整讀到的狀態，其他的用 summarize 的。
  const repoBar = (changes: GitFile[]) => others.map(o => o ?? toSummary(active, changes))

  if (status.exitCode !== 0) {
    // 開著工作區檔案的差異就關掉；commit 裡的檔案不受影響。
    await io.updateCover(c => (coverData(c, 'diff')?.commits.length === 0 ? NO_COVER : c))
    await io.setView({
      isLoaded: true,
      isRepo: false,
      error: isNotRepo(status) ? '' : status.stderr.trim(),
      files: [],
      branches: [],
      repos: repoBar([]),
      repo: active.name,
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
      repos: repoBar(changes),
      repo: active.name,
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
export async function selectRepo(io: GitIo, name: string) {
  const next = repos.list.find(c => c.name === name)
  if (next === undefined || next === repos.current || mergeBusy()) return
  repos.current = next
  dropLog()
  await Promise.all([
    io.setView({ repo: name, ...NO_MESSAGES }),
    io.closeCover(),
    // log 換成新 repo 的目前分支。
    io.updateLog(() => EMPTY_LOG),
  ])
  await refresh(io)
}
