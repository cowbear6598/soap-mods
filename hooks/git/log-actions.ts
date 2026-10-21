// log 分頁：讀 commit（分頁、搜尋）、點開 commit 或一段範圍。

import type { GitCommit, LogView } from '../../types'
import { LOG_PAGE } from '../config'
import { NO_COMMIT } from '../defaults'
import { latestOnly } from '../latest'
import { patch } from '../patch'
import { hasQuery } from '../search'
import { clampPage } from '../text'
import { LOG_FORMAT, branchRef, commitRange, filterCommits, logBranch, parseCommitFiles, parseLog } from './parse'
import { gitErrorText } from './repo'
import { type GitIo, git, repos } from './run'

type LogRead = { commits: GitCommit[]; unpushed: string[]; isTruncated: boolean; error: string }

// 讀 ref 的 commit（page 沒給就是整條；給了是跳過 skip 筆後的 count 筆，多讀一筆看還有沒有下一頁），
// 和其中哪些還沒 push（rev-list 只列領先的 commit，跟 log 的順序對不上，不能一樣 --skip，只好從頭讀到這頁）：有 upstream 比 upstream；沒有的話比所有遠端分支，新分支從 main 分出來後加的才算。
// 遠端分支本身都在遠端上，不會有標記。
async function readLog(io: GitIo, ref: string, upstream: string, page?: { skip: number; count: number }): Promise<LogRead> {
  const [r, ahead] = await Promise.all([
    // 結尾的 -- ：工作區剛好有叫 HEAD（或跟分支同名）的檔案時，git 才不會分不出是分支還是路徑。
    git(io, ['log', ref, ...(page === undefined ? [] : [`--skip=${page.skip}`, `--max-count=${page.count + 1}`]), `--format=${LOG_FORMAT}`, '--']),
    git(io, ['rev-list', ...(page === undefined ? [] : [`--max-count=${page.skip + page.count}`]), ref, '--not', upstream === '' ? '--remotes' : upstream, '--']),
  ])
  if (r.exitCode !== 0) {
    // 還沒有任何 commit 不算錯。
    const isEmpty = r.stderr.includes('does not have any commits')

    return { commits: [], unpushed: [], isTruncated: false, error: isEmpty ? '' : r.stderr.trim() }
  }
  // 輸出被截斷時最後一行可能不完整，丟掉。
  const out = r.isStdoutTruncated ? r.stdout.slice(0, r.stdout.lastIndexOf('\n') + 1) : r.stdout
  const unpushed = ahead.exitCode === 0 ? ahead.stdout.split('\n').map(s => s.trim()).filter(s => s !== '') : []

  return { commits: parseLog(out), unpushed, isTruncated: r.isStdoutTruncated, error: '' }
}

// 搜尋用的整條分支歷史：打字、換頁時從這裡過濾，不用每次都跑 git。換 repo 或分支就重讀；
// refresh（回合結束）時先問分支和比較對象的 tip（tips），都沒動就沿用，動了才重讀。
// git 最多給 4 MiB（大約兩萬多筆），超過的只搜最新的那些。
let history: { base: string; tips: string; load: Promise<LogRead> } | undefined

async function readHistory(io: GitIo, ref: string, upstream: string, isFresh: boolean) {
  const base = `${repos.current?.root ?? ''}\n${ref}\n${upstream}`
  if (!isFresh && history?.base === base) return history.load
  const tips = (await git(io, ['rev-parse', ref, upstream === '' ? '--remotes' : upstream, '--'])).stdout
  if (history?.base !== base || history.tips !== tips) history = { base, tips, load: readLog(io, ref, upstream) }

  return history.load
}

// 讀完時已經有更新的讀取開始了（打字、換頁、refresh），或中途換了分支、repo、分頁（logLoads.drop），
// 這次讀到的就不寫，免得蓋掉新的。
const logLoads = latestOnly()

// 換了分支、repo 或分頁：讀到一半的不寫。
export function dropLog() {
  logLoads.drop()
}

// 讀 log 分頁第 page 頁的 commit（沒給就是目前那頁）；有搜尋時從整條分支的歷史裡挑出符合的再切頁。
// isFresh 是 false 時（打字、換頁）沿用讀過的歷史。
export async function loadLog(io: GitIo, { isFresh = true, page }: { isFresh?: boolean; page?: number } = {}) {
  const isStale = logLoads.start()
  const [v, l, query] = await Promise.all([io.getView(), io.getLog(), io.getLogQuery()])
  const branch = logBranch(v, l)
  // 按過的分支已經不在了：回到目前分支。
  const isPicked = branch !== undefined && l.ref !== '' && branchRef(branch) === l.ref
  const ref = isPicked ? l.ref : 'HEAD'
  const upstream = branch !== undefined && !branch.isRemote && branch.track !== '[gone]' ? branch.upstream : ''
  const wanted = page ?? l.page
  const isSearching = hasQuery(query)
  if (!isSearching) history = undefined
  try {
    const found = isSearching
      ? await readHistory(io, ref, upstream, isFresh).then(h => ({ ...h, commits: filterCommits(h.commits, query) }))
      : await readLog(io, ref, upstream, { skip: wanted * LOG_PAGE, count: LOG_PAGE })
    if (isStale()) return
    // 搜尋拿到的是整條：自己切，符合的變少了就夾回最後一頁（跟 diff 分頁一樣）。沒搜尋時 git 已經跳過前面幾頁。
    const index = isSearching ? clampPage(wanted, found.commits.length, LOG_PAGE) : wanted
    const from = isSearching ? index * LOG_PAGE : 0
    const commits = found.commits.slice(from, from + LOG_PAGE)
    // 沒搜尋時不知道總共幾頁：歷史變短了（rebase、換分支），這頁已經沒有東西，就回到第一頁重讀。
    if (commits.length === 0 && index > 0) return await loadLog(io, { isFresh: false, page: 0 })
    const ahead = new Set(found.unpushed)
    const listed = new Set(commits.map(c => c.sha))
    // 內容沒變 patch 就不寫，停在 log 分頁時回合結束不會白白重畫。
    await io.updateLog(cur =>
      patch(cur, {
        ref: isPicked ? l.ref : '',
        isLoaded: true,
        page: index,
        commits,
        hasNext: found.commits.length > from + LOG_PAGE,
        isTruncated: found.isTruncated,
        // 只留列出來的那些，整條歷史的可能很多。
        unpushed: commits.filter(c => ahead.has(c.sha)).map(c => c.sha),
        // 選範圍點過的起點只留還列著的（搜尋濾掉、或歷史變了就不算）：範圍要靠列表的順序分出中間有哪些。
        rangeStart: listed.has(cur.rangeStart) ? cur.rangeStart : '',
        error: found.error,
      }),
    )
  } catch (err) {
    if (!isStale()) await io.setLog({ isLoaded: true, error: gitErrorText(err) })
  }
}

// log 搜尋框打字：從第一頁開始重新過濾；整條分支的歷史只在第一次搜的時候讀。清空就回到最近的 commit。
export async function searchLog(io: GitIo, text: string) {
  await io.setLogQuery(text)
  await loadLog(io, { isFresh: false, page: 0 })
}

// 換分頁時清掉搜尋；不在這裡重讀，回到 log 分頁時才讀。
export async function clearLogQuery(io: GitIo) {
  history = undefined
  logLoads.drop()
  await io.setLogQuery('')
}

// 點 commit（或選好範圍）：列表換成它們合起來改了哪些檔案，commits 是新的在前。
// 讀到的時候已經換成別筆（或按了 Back）就丟掉。
export async function openCommits(io: GitIo, commits: GitCommit[]) {
  if (commits.length === 0) return
  const key = commits.map(c => c.sha).join()
  await io.setLog({ ...NO_COMMIT, opened: commits })
  let change: Partial<LogView>
  try {
    const r = await git(io, ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-commit-id', ...commitRange(commits)])
    change = r.exitCode === 0 ? { files: parseCommitFiles(r.stdout) } : { files: [], commitError: r.stderr.trim() }
  } catch (err) {
    change = { files: [], commitError: gitErrorText(err) }
  }
  await io.updateLog(l => (l.opened.map(c => c.sha).join() === key ? { ...l, ...change } : l))
}

// 選範圍時點 commit：第一下是起點（再點一次取消），第二下是終點，兩筆之間（含）一起打開。
export async function pickRange(io: GitIo, c: GitCommit) {
  const l = await io.getLog()
  const start = l.commits.findIndex(x => x.sha === l.rangeStart)
  const end = l.commits.findIndex(x => x.sha === c.sha)
  if (start === -1 || start === end || end === -1) {
    await io.setLog({ rangeStart: start === end ? '' : c.sha })
    return
  }
  await openCommits(io, l.commits.slice(Math.min(start, end), Math.max(start, end) + 1))
}
