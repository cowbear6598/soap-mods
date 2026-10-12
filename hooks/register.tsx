// 進入點：狀態（atom）、所有碰到 $ 的動作，和引擎事件的接線。
// 引擎只讓這個檔案碰 $ 和 atom（傳 $ 給 import 進來的函式、用別的檔案的 atom 都會被擋），
// 所以這裡只放「跑 git、讀寫狀態、開關面板」；其餘都是 import 進來的純函式：
//   config.ts      常數（面板、分頁、顏色、時間）
//   defaults.ts    狀態的初始值
//   patch.ts       改物件 atom 的幾個欄位（沒變就不寫）
//   git/           解析 git 輸出（parse）、repo 的參數和解析（repo）
//   merge/algo.ts  三方合併
//   services/      找服務（scan）
//   ui/            畫面：拿到資料和 Actions 畫出樹（panel、tabs/、diffPane、mergePane）

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, ProcessRunInit, Register, RenderSurface, Timer } from 'claude-code'

import type {
  CommitFile,
  DiffPaneView,
  GitCommit,
  GitBranch,
  GitFile,
  GitSubTab,
  GitSync,
  GitView,
  LogView,
  MergeChunk,
  MergeOp,
  MergeView,
  RepoSummary,
  ScanResult,
  Service,
  ServiceAction,
  ServicePending,
  ServicesView,
  TabId,
} from '../types'
import {
  COPIED_MS,
  DELETE_ARM_MS,
  FILE_PAGE,
  FOCUS_WATCH_MS,
  LOG_PAGE,
  MERGE_COLUMNS,
  OP_LABEL,
  PANEL_TITLE,
  REFOCUS_AFTER_PRESS_MS,
  RESTART_CHECK_MS,
  RESTART_GAP_MS,
  SERVICES_SCAN_MS,
  SYNC_TIMEOUT_MS,
  USAGE_TICK_MS,
} from './config'
import { EMPTY, EMPTY_DIFF, EMPTY_LOG, EMPTY_MERGE, EMPTY_SERVICES, NO_MESSAGES } from './defaults'
import { errorText, failure, isMissingCommand } from './errors'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  branchRef,
  commitRange,
  commitsLabel,
  fileKind,
  filterCommits,
  hasQuery,
  isConflict,
  isPromptSafePath,
  letterKind,
  logBranch,
  parseBranches,
  parseCommitFiles,
  parseLog,
  parseStatus,
  splitPath,
  toHunks,
} from './git/parse'
import type { Repo } from './git/repo'
import { GIT_ENV, REPO_ARGS, STATUS_ARGS, SUMMARY_ARGS, SYNC_ARGS, gitErrorText, isNotRepo, parseRepo, toSummary } from './git/repo'
import { buildResult, detectOp, isResolved, keepChoices, merge3, nextConflict, parseConflicts, splitLines } from './merge/algo'
import {
  MAC_ENV,
  MAC_LAUNCH_ARGV,
  MAC_PPIDS_ARGV,
  MAC_SCAN_ARGV,
  descendants,
  isShellSafe,
  macFilesArgv,
  parseMacFiles,
  parseMacScan,
  wantedPids,
  withFiles,
} from './services/mac'
import { KILL_ARGV, LAUNCH_ARGV, SCAN_ARGV, findServices } from './services/scan'
import type { Actions } from './ui/actions'
import { renderDiffPane } from './ui/diffPane'
import { renderMergePane } from './ui/mergePane'
import { renderPanel } from './ui/panel'
import { patch } from './patch'

// ───── 面板 id（引擎要在這個檔案裡直接看到值，不能 import）─────

const PANE = 'soap-panel'
const DIFF_PANE = 'soap-diff'
// 解衝突的三欄面板（左 Ours、中 Result、右 Theirs）。
const MERGE_PANE = 'soap-merge'
const PANE_ARGS: PaneOpenArgs = { id: PANE, title: PANEL_TITLE }

// ───── 狀態 ─────

const tab = atom({ plugin: 'soap-mods', key: 'tab' } as const, 'git')
const subTab = atom({ plugin: 'soap-mods', key: 'subTab' } as const, 'diff')
const view = atom({ plugin: 'soap-mods', key: 'view' } as const, EMPTY)
const showRemote = atom({ plugin: 'soap-mods', key: 'showRemote' } as const, false)
// branch 分頁資料夾的開合，key 是「l:路徑」或「r:路徑」；沒有的照預設。
const branchFolders = atom({ plugin: 'soap-mods', key: 'branchFolders' } as const, {})
// branch 分頁搜尋框裡的字，換分頁就清掉。
const branchQuery = atom({ plugin: 'soap-mods', key: 'branchQuery' } as const, '')
// log 分頁搜尋框裡的字，一樣換分頁就清掉。
const logQuery = atom({ plugin: 'soap-mods', key: 'logQuery' } as const, '')
const fileLimit = atom({ plugin: 'soap-mods', key: 'fileLimit' } as const, FILE_PAGE)
const services = atom({ plugin: 'soap-mods', key: 'services' } as const, EMPTY_SERVICES)
const merge = atom({ plugin: 'soap-mods', key: 'merge' } as const, EMPTY_MERGE)
const log = atom({ plugin: 'soap-mods', key: 'log' } as const, EMPTY_LOG)
const diffPane = atom({ plugin: 'soap-mods', key: 'diffPane' } as const, EMPTY_DIFF)

// 改一個物件 atom 的其中幾個欄位；改的欄位內容都沒變就不寫（patch），面板不會白白重畫。
// 引擎要看得出改的是哪個 atom，所以每個 atom 一個，不能寫成通用的。
async function setView($: EngineInterface, change: Partial<GitView>) {
  await update($, view, v => patch(v, change))
}

async function setLog($: EngineInterface, change: Partial<LogView>) {
  await update($, log, l => patch(l, change))
}

async function setMerge($: EngineInterface, change: Partial<MergeView>) {
  await update($, merge, m => patch(m, change))
}

async function setServices($: EngineInterface, change: Partial<ServicesView>) {
  await update($, services, s => patch(s, change))
}

// ───── 跑 git ─────

// current：Git 分頁正在看的 repo。
// list：那排 repo 按鈕。session 資料夾本身是 repo 時只有它一個；不是的話（例如在 company/ 開，底下 a、b、c
// 各是一個 repo）是下一層找到的 repo，照名稱排。每次 refresh 重找，新 clone 的也會出現。
const repos: { current: Repo | undefined; list: Repo[] } = { current: undefined, list: [] }

type GitInit = { cwd?: string; env?: Record<string, string>; timeoutMs?: number }

// 預設在選中的 repo 根目錄跑；init.cwd 指定別的資料夾（找 repo、看其他 repo 的狀態）。
// LC_ALL=C：有些錯誤是看 git 的英文訊息判斷的（not a git repository、not fully merged），不能被翻譯。
// GIT_ENV：面板每個回合都自己跑 git，repo 的設定不能讓它執行別的指令（見 git/repo.ts）。
async function git($: EngineInterface, args: string[], init: GitInit = {}) {
  return $.process.run(['git', '-c', 'core.quotepath=false', ...args], {
    cwd: init.cwd ?? repos.current?.root,
    env: { ...GIT_ENV, LC_ALL: 'C', ...init.env },
    timeoutMs: init.timeoutMs,
  })
}

// 跑 git，結束碼不是 0 就丟出它的錯誤訊息。
async function gitOk($: EngineInterface, args: string[], init?: GitInit) {
  const r = await git($, args, init)
  if (r.exitCode !== 0) throw failure(r, `git ${args.join(' ')}`)

  return r
}

// 跑其他指令（掃描、停止、重跑服務），一樣結束碼不是 0 就丟出錯誤；what 是錯誤訊息裡的名稱。
async function runOk($: EngineInterface, argv: string[], what: string, init?: ProcessRunInit) {
  const r = await $.process.run(argv, init)
  if (r.exitCode !== 0) throw failure(r, what)

  return r
}

// repo 裡的相對路徑 → 絕對路徑（讀寫檔案用）。
const inRepo = (path: string) => (repos.current === undefined ? path : `${repos.current.root}/${path}`)

// ───── 面板與焦點 ─────

// 每個面板 open 時要給的標題和寬度；每次 open 都會重設它們，所以一律從這裡拿。
async function paneArgs($: EngineInterface, id: string): Promise<PaneOpenArgs> {
  if (id === MERGE_PANE) return { id, title: `Merge · ${splitPath((await read($, merge)).path).name}`, columns: MERGE_COLUMNS }
  if (id === DIFF_PANE) {
    const d = await read($, diffPane)

    return { id, title: d.commits.length === 0 ? d.path : `${d.path} @ ${commitsLabel(d.commits)}` }
  }

  return PANE_ARGS
}

// 開（或切到）一個面板並要焦點：已經開著的話先關再開，才會跳到最前面，而不是躲在別的分頁後面。
async function bringToFront($: EngineInterface, id: string) {
  const [panes, args] = await Promise.all([$.ui.panes(), paneArgs($, id)])
  if (panes.some(p => p.id === id)) await $.ui.close({ id })
  await $.ui.open({ ...args, focus: true })
}

// 桌面版的面板沒有焦點時，按下滑鼠會先拿焦點、整個面板重畫，按到的按鈕被換掉，那一下就不算。
// 點分頁標籤切到 Soap Panel 或合併面板時引擎不會通知、也不給焦點，所以定時看一下：
// 它「剛被切到前面」又沒焦點，就先把焦點給它，第一下點擊才點得到。
// 只在從看不見變成看得見的那一刻給，平常在輸入框打字不會被搶。
// 按完按鈕也可能丟焦點（切分支時被點的那列搬位置、abort 後整區消失），
// 所以每個按鈕的動作做完後的一小段時間內也補（act）。
// 要補焦點的面板。diff 面板看 commit 的檔案時有 Previous／Next。
const FOCUS_PANES = [PANE, MERGE_PANE, DIFF_PANE]
// 上一輪看的時候在不在前面；沒記錄當作在（剛啟動不搶焦點）。
const wasShown = new Map<string, boolean>()
let isWatching = false
// 按完按鈕後，到這個時間點之前丟了焦點就補回來；沒有記錄是沒有要補。
const refocusUntil = new Map<string, number>()

async function focusPane($: EngineInterface, id: string) {
  await $.ui.open({ ...(await paneArgs($, id)), focus: true })
}

async function focusPanel($: EngineInterface) {
  await focusPane($, PANE)
}

// 包住面板上按鈕的動作：動作做完（可能要跑 git 很久）才開始算補焦點的那段時間。
function act($: EngineInterface, id: string, fn: () => unknown) {
  return async () => {
    try {
      await fn()
    } finally {
      refocusUntil.set(id, (await $.clock.now()) + REFOCUS_AFTER_PRESS_MS)
    }
  }
}

async function focusWhenShown($: EngineInterface) {
  if (isWatching) return
  isWatching = true
  try {
    const panes = await $.ui.panes()
    for (const id of FOCUS_PANES) {
      const pane = panes.find(p => p.id === id)
      const isShown = pane?.isShown === true
      if (isShown && pane?.isFocused === false) {
        const until = refocusUntil.get(id)
        const isJustPressed = until !== undefined && (await $.clock.now()) < until
        if (wasShown.get(id) === false || isJustPressed) {
          await focusPane($, id)
          refocusUntil.delete(id)
        }
      }
      wasShown.set(id, isShown)
    }
  } catch {
    // 讀不到就等下一輪。
  } finally {
    isWatching = false
  }
}

// ───── 找 repo、重讀 Git 分頁 ─────

// 找 repo：session 資料夾本身是 repo 就只有它；不是的話看下一層有 .git 的資料夾。
// 已經找過的不再問 git，只有新的才跑一次 rev-parse。
// 用 session.root 不用 session.cwd：cwd 會跟著 Bash 的 cd 跑（例如 cd 進 a 去 commit），其他 repo 就不見了。
async function findRepos($: EngineInterface): Promise<Repo[]> {
  const cwd = await $.session.root()
  const self = parseRepo(await git($, REPO_ARGS, { cwd }))
  if (self !== undefined) return [self]
  const entries = await $.fs.list(cwd).catch(() => [])
  const found = await Promise.all(
    entries
      .filter(e => e.kind === 'dir' && !e.name.startsWith('.'))
      .map(async e => {
        const dir = `${cwd}/${e.name}`
        if (!(await $.fs.exists(`${dir}/.git`).catch(() => false))) return undefined

        return repos.list.find(c => c.name === e.name) ?? parseRepo(await git($, REPO_ARGS, { cwd: dir }))
      }),
  )

  return found.filter(c => c !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

// 其他 repo 有沒有變更、有沒有衝突；讀不到就當作沒有變更。
async function summarize($: EngineInterface, r: Repo): Promise<RepoSummary> {
  const status = await git($, SUMMARY_ARGS, { cwd: r.root }).catch(() => undefined)

  return toSummary(r, status?.exitCode === 0 ? parseStatus(status.stdout) : [])
}

// .git 資料夾裡有哪些檔案（看得出停在 merge 還是 rebase）。
async function readGitDir($: EngineInterface, r: Repo): Promise<string[]> {
  return $.fs.list(r.gitDir).then(
    entries => entries.map(entry => entry.name),
    () => [],
  )
}

// 每次 refresh 拿一個號碼。讀完時已經有更新的 refresh 開始了（回合結束、按了按鈕、換了 repo），
// 這次讀到的可能是舊的，就不寫，交給後面那次。
let latestRefresh = 0

// 重新讀 git 狀態、檔案清單、分支清單，保留原本點開的檔案；最後只寫一次 view，只重畫一次。
async function refresh($: EngineInterface) {
  const ticket = (latestRefresh += 1)
  const isStale = () => ticket !== latestRefresh
  let snap
  try {
    repos.list = await findRepos($)
    // 選中的 repo 還在就留著，不在了（或還沒選過）就換成第一個。
    repos.current = repos.list.find(c => c.root === repos.current?.root) ?? repos.list[0]
    const active = repos.current
    if (active === undefined) {
      if (!isStale()) await setView($, { ...EMPTY, isLoaded: true, isRepo: false })

      return
    }
    // 這次讀的 repo 固定下來：中途換了 repo，也不會把這個 repo 的狀態算到別的 repo 頭上。
    const [status, refs, names, others] = await Promise.all([
      git($, STATUS_ARGS, { cwd: active.root }),
      git($, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { cwd: active.root }),
      readGitDir($, active),
      Promise.all(repos.list.map(c => (c === active ? undefined : summarize($, c)))),
    ])
    snap = { active, status, refs, names, others }
  } catch (err) {
    if (!isStale()) await setView($, { isLoaded: true, isRepo: false, error: gitErrorText(err) })

    return
  }
  if (isStale()) return

  const { active, status, refs, names, others } = snap
  // 那排 repo：選中的那個用下面完整讀到的狀態，其他的用 summarize 的。
  const repoBar = (files: GitFile[]) => others.map(o => o ?? toSummary(active, files))

  if (status.exitCode !== 0) {
    await update($, diffPane, d => (d.commits.length === 0 ? EMPTY_DIFF : d))
    await setView($, {
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

  const files = parseStatus(status.stdout)
  // 差異面板開著工作區的檔案就重讀；那個檔案已經沒有變更了（readDiff 給空的），把面板也關掉。
  // 開著的是 commit 裡的檔案就不用動，commit 不會變。
  const shown = await read($, diffPane)
  const pane = shown.commits.length === 0 && shown.path !== '' ? await readDiff($, files, shown.path) : shown
  if (isStale()) return
  await Promise.all([
    setView($, {
      isLoaded: true,
      isRepo: true,
      error: '',
      files,
      repos: repoBar(files),
      repo: active.name,
      branches: refs.exitCode === 0 ? parseBranches(refs.stdout) : [],
      op: detectOp(names),
    }),
    pane === shown ? undefined : update($, diffPane, () => pane),
  ])
  if (shown.path !== '' && pane.path === '') await $.ui.close({ id: DIFF_PANE })
  // log 只在看得到時重讀（換到 log 分頁時也會讀）。
  await Promise.all([syncMerge($, files), (await read($, subTab)) === 'log' ? loadLog($) : undefined])
}

// 換 Git 分頁看的 repo：開著的 diff／合併面板是上一個 repo 的檔案，關掉；合併面板正在寫檔時不換。
async function selectRepo($: EngineInterface, name: string) {
  const next = repos.list.find(c => c.name === name)
  if (next === undefined || next === repos.current || isMergeBusy) return
  repos.current = next
  dropLogLoads()
  await Promise.all([
    setView($, { repo: name, ...NO_MESSAGES }),
    update($, diffPane, () => EMPTY_DIFF),
    // log 換成新 repo 的目前分支。
    update($, log, () => EMPTY_LOG),
  ])
  await Promise.all([closeMerge($), $.ui.close({ id: DIFF_PANE })])
  await refresh($)
}

// 換分頁時清掉切換／刪除分支、abort／continue 失敗的訊息和待確認的刪除、abort；沒有要清的就不寫，免得面板白白重畫。
async function clearGitMessages($: EngineInterface) {
  await setView($, NO_MESSAGES)
}

// ───── 差異面板 ─────

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']

// 跑一次 diff，只留 hunk（Code format="diff" 要的）；讀不到就帶著錯誤訊息。
// fallback：結束碼不是 0 時改跑的另一個 diff（還沒有任何 commit 時沒有 HEAD，改看已暫存的內容）。
async function runDiff($: EngineInterface, args: string[], fallback?: string[]) {
  let out = ''
  let error = ''
  try {
    const r = await git($, args)
    if (r.exitCode === 0 || fallback === undefined) {
      out = r.stdout
      if (r.exitCode !== 0) error = r.stderr.trim()
    } else {
      const again = await git($, fallback)
      out = again.stdout
      if (again.exitCode !== 0) error = again.stderr.trim() || r.stderr.trim()
    }
  } catch (err) {
    error = `Failed to read diff: ${errorText(err)}`
  }
  const { source, isTruncated } = toHunks(out)

  return { diff: source, isTruncated, error }
}

// 讀工作區一個檔案的 diff，給差異面板：已追蹤的對 HEAD，未追蹤的對空檔案。
async function readDiff($: EngineInterface, files: GitFile[], path: string): Promise<DiffPaneView> {
  const file = files.find(f => f.path === path)
  if (file === undefined) return EMPTY_DIFF
  const result = await (file.x === '?'
    ? runDiff($, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path])
    : runDiff($, ['diff', ...DIFF_FLAGS, 'HEAD', '--', path], ['diff', ...DIFF_FLAGS, '--cached', '--', path]))

  return { ...EMPTY_DIFF, path, kind: fileKind(file), ...result }
}

// 換掉差異面板的內容並切過去。isFront：面板已經在前面（Previous／Next），重新 open 只為了換標題。
async function showDiff($: EngineInterface, pane: DiffPaneView, isFront = false) {
  await update($, diffPane, () => pane)
  await (isFront ? focusPane($, DIFF_PANE) : bringToFront($, DIFF_PANE))
}

// 點檔案：一定開一個獨立的 diff 面板並切過去；關掉面板交給面板自己的關閉鈕。
async function openDiff($: EngineInterface, path: string) {
  await showDiff($, await readDiff($, (await read($, view)).files, path))
}

// 讀 commit 裡一個檔案在這（幾）個 commit 的差異。改名的檔案兩個路徑都要給，git 才認得出是改名。
// files 是同一批的全部檔案，差異面板的 Previous／Next 照它走。
async function readCommitDiff($: EngineInterface, commits: GitCommit[], f: CommitFile, files: CommitFile[]): Promise<DiffPaneView> {
  const paths = f.oldPath === '' ? [f.path] : [f.oldPath, f.path]
  const result = await runDiff($, ['diff-tree', '-p', '-M', ...DIFF_FLAGS, '--no-commit-id', ...commitRange(commits), '--', ...paths])

  return { path: f.path, kind: letterKind(f.letter), ...result, commits, files }
}

// 點 commit 裡的檔案：在 diff 面板看它的差異。
async function openCommitDiff($: EngineInterface, commits: GitCommit[], f: CommitFile, files: CommitFile[]) {
  await showDiff($, await readCommitDiff($, commits, f, files))
}

// 差異面板的 Previous／Next：換成同一批 commit 的上一個／下一個檔案。
async function stepCommitFile($: EngineInterface, step: 1 | -1) {
  const d = await read($, diffPane)
  const next = d.files[d.files.findIndex(f => f.path === d.path) + step]
  if (next === undefined) return
  await showDiff($, await readCommitDiff($, d.commits, next, d.files), true)
}

// ───── branch 分頁 ─────

async function switchBranch($: EngineInterface, name: string, isRemote: boolean) {
  try {
    await gitOk($, isRemote ? ['switch', '--track', name] : ['switch', name])
  } catch (err) {
    await setView($, { branchError: gitErrorText(err) })

    return
  }

  // 不跳 toast：目前分支的 ● 本來就會移過去。丟掉的焦點交給 focusWhenShown 補。
  await clearGitMessages($)
  await refresh($)
}

// 打勾 DELETE_ARM_MS 後收回去的計時；再按（刪掉或按了別的垃圾桶）就先停掉舊的。
let disarmTimer: Timer | undefined

async function armDelete($: EngineInterface, name: string, isForce: boolean) {
  disarmTimer?.cancel()
  await setView($, { ...NO_MESSAGES, deleteArmed: { name, isForce } })
  disarmTimer = $.clock.after(DELETE_ARM_MS, () => void setView($, { deleteArmed: null }))
}

// 刪本地分支要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才真的刪；按別的垃圾桶，原本的就收回。
// 用 -d，有沒合併的 commit 時 git 不肯刪，換成強制刪除的打勾（-D），讓人決定要不要連那些 commit 一起丟掉。
async function deleteBranch($: EngineInterface, name: string) {
  const armed = (await read($, view)).deleteArmed
  if (armed?.name !== name) {
    await armDelete($, name, false)

    return
  }
  disarmTimer?.cancel()
  try {
    await gitOk($, ['branch', armed.isForce ? '-D' : '-d', name])
  } catch (err) {
    const message = errorText(err)
    if (!armed.isForce && message.includes('not fully merged')) await armDelete($, name, true)
    else await setView($, { ...NO_MESSAGES, branchError: message })

    return
  }

  $.ui.toast(`Deleted ${name}`)
  await clearGitMessages($)
  await refresh($)
}

// 正在跑的 Fetch／Pull，'' 是沒有。放模組變數不放 atom：atom 熱重載後還在，跑到一半被重載中斷的話
// 會一直停在「Pulling…」；模組變數跟著重載歸零。也順便擋住連按兩下。
let syncing: GitSync | '' = ''

function setSyncing($: EngineInterface, kind: GitSync | '') {
  syncing = kind
  $.ui.invalidate('ui.render')
}

// branch 分頁上方的 Fetch／Pull，按了才跑。跑的時候那顆按鈕寫「Pulling…」、再按不理，跑完重讀分支（ahead／behind 跟著更新）。
// 要帳密時 git 不能停下來問（沒有地方打字），GIT_TERMINAL_PROMPT=0 讓它直接失敗；Windows 的認證視窗照常會跳。
async function syncBranches($: EngineInterface, kind: GitSync) {
  if (syncing !== '') return
  setSyncing($, kind)
  disarmTimer?.cancel()
  await clearGitMessages($)
  try {
    const r = await gitOk($, SYNC_ARGS[kind], { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: SYNC_TIMEOUT_MS })
    $.ui.toast(kind === 'fetch' ? 'Fetched' : r.stdout.includes('Already up to date') ? 'Already up to date' : 'Pulled')
  } catch (err) {
    await setView($, { branchError: gitErrorText(err) })
  } finally {
    setSyncing($, '')
  }
  await refresh($)
}

// ───── log 分頁 ─────

// 關掉打開的 commit；選範圍也一起結束。
const NO_COMMIT: Partial<LogView> = { opened: [], files: null, commitError: '', isPicking: false, rangeStart: '' }

type LogRead = { commits: GitCommit[]; unpushed: string[]; isTruncated: boolean; error: string }

// 讀 ref 的 commit（limit 沒給就是整條），和其中哪些還沒 push：有 upstream 比 upstream；
// 沒有的話比所有遠端分支，新分支從 main 分出來後加的才算。遠端分支本身都在遠端上，不會有標記。
async function readLog($: EngineInterface, ref: string, upstream: string, limit?: number): Promise<LogRead> {
  const [r, ahead] = await Promise.all([
    // 結尾的 -- ：工作區剛好有叫 HEAD（或跟分支同名）的檔案時，git 才不會分不出是分支還是路徑。
    git($, ['log', ref, ...(limit === undefined ? [] : [`--max-count=${limit + 1}`]), `--format=${LOG_FORMAT}`, '--']),
    git($, ['rev-list', ...(limit === undefined ? [] : [`--max-count=${limit}`]), ref, '--not', upstream === '' ? '--remotes' : upstream, '--']),
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

// 搜尋用的整條分支歷史：打字、Load more 時從這裡過濾，不用每次都跑 git。換 repo 或分支就重讀；
// refresh（回合結束）時先問分支和比較對象的 tip（tips），都沒動就沿用，動了才重讀。
// git 最多給 4 MiB（大約兩萬多筆），超過的只搜最新的那些。
let history: { base: string; tips: string; load: Promise<LogRead> } | undefined

async function readHistory($: EngineInterface, ref: string, upstream: string, isFresh: boolean) {
  const base = `${repos.current?.root ?? ''}\n${ref}\n${upstream}`
  if (!isFresh && history?.base === base) return history.load
  const tips = (await git($, ['rev-parse', ref, upstream === '' ? '--remotes' : upstream, '--'])).stdout
  if (history?.base !== base || history.tips !== tips) history = { base, tips, load: readLog($, ref, upstream) }

  return history.load
}

// 每次讀 log 拿一個號碼。讀完時已經有更新的讀取開始了（打字、Load more、refresh），
// 或中途換了分支、repo、分頁（dropLogLoads），這次讀到的就不寫，免得蓋掉新的。
let latestLog = 0

function dropLogLoads() {
  latestLog += 1
}

// 讀 log 分頁的 commit，列前 limit 筆（沒給就是目前的筆數）；有搜尋時從整條分支的歷史裡挑出符合的。
// isFresh 是 false 時（打字、Load more）沿用讀過的歷史。
async function loadLog($: EngineInterface, { isFresh = true, limit }: { isFresh?: boolean; limit?: number } = {}) {
  const ticket = (latestLog += 1)
  const isStale = () => ticket !== latestLog
  const [v, l, query] = await Promise.all([read($, view), read($, log), read($, logQuery)])
  const branch = logBranch(v, l)
  // 按過的分支已經不在了：回到目前分支。
  const isPicked = branch !== undefined && l.ref !== '' && branchRef(branch) === l.ref
  const ref = isPicked ? l.ref : 'HEAD'
  const upstream = branch !== undefined && !branch.isRemote && branch.track !== '[gone]' ? branch.upstream : ''
  const count = limit ?? l.limit
  const isSearching = hasQuery(query)
  if (!isSearching) history = undefined
  try {
    const found = isSearching
      ? await readHistory($, ref, upstream, isFresh).then(h => ({ ...h, commits: filterCommits(h.commits, query) }))
      : await readLog($, ref, upstream, count)
    if (isStale()) return
    const commits = found.commits.slice(0, count)
    const ahead = new Set(found.unpushed)
    const listed = new Set(commits.map(c => c.sha))
    await update($, log, cur => ({
      ...cur,
      ref: isPicked ? l.ref : '',
      isLoaded: true,
      limit: count,
      commits,
      hasMore: found.commits.length > count,
      isTruncated: found.isTruncated,
      // 只留列出來的那些，整條歷史的可能很多。
      unpushed: commits.filter(c => ahead.has(c.sha)).map(c => c.sha),
      // 選範圍點過的起點只留還列著的（搜尋濾掉、或歷史變了就不算）：範圍要靠列表的順序分出中間有哪些。
      rangeStart: listed.has(cur.rangeStart) ? cur.rangeStart : '',
      error: found.error,
    }))
  } catch (err) {
    if (!isStale()) await setLog($, { isLoaded: true, error: gitErrorText(err) })
  }
}

// log 搜尋框打字：從第一頁開始重新過濾；整條分支的歷史只在第一次搜的時候讀。清空就回到最近的 commit。
async function searchLog($: EngineInterface, text: string) {
  await update($, logQuery, () => text)
  await loadLog($, { isFresh: false, limit: LOG_PAGE })
}

// 換分頁時清掉搜尋；不在這裡重讀，回到 log 分頁時才讀。
async function clearLogQuery($: EngineInterface) {
  history = undefined
  dropLogLoads()
  await update($, logQuery, () => '')
}

async function loadMoreLog($: EngineInterface) {
  await loadLog($, { isFresh: false, limit: (await read($, log)).limit + LOG_PAGE })
}

// 點 commit（或選好範圍）：列表換成它們合起來改了哪些檔案，commits 是新的在前。
// 讀到的時候已經換成別筆（或按了 Back）就丟掉。
async function openCommits($: EngineInterface, commits: GitCommit[]) {
  if (commits.length === 0) return
  const key = commits.map(c => c.sha).join()
  await setLog($, { ...NO_COMMIT, opened: commits })
  let change: Partial<LogView>
  try {
    const r = await git($, ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-commit-id', ...commitRange(commits)])
    change = r.exitCode === 0 ? { files: parseCommitFiles(r.stdout) } : { files: [], commitError: r.stderr.trim() }
  } catch (err) {
    change = { files: [], commitError: gitErrorText(err) }
  }
  await update($, log, l => (l.opened.map(c => c.sha).join() === key ? { ...l, ...change } : l))
}

// 選範圍時點 commit：第一下是起點（再點一次取消），第二下是終點，兩筆之間（含）一起打開。
async function pickRange($: EngineInterface, c: GitCommit) {
  const l = await read($, log)
  const start = l.commits.findIndex(x => x.sha === l.rangeStart)
  const end = l.commits.findIndex(x => x.sha === c.sha)
  if (start === -1 || start === end || end === -1) {
    await setLog($, { rangeStart: start === end ? '' : c.sha })
    return
  }
  await openCommits($, l.commits.slice(Math.min(start, end), Math.max(start, end) + 1))
}

// ───── 解衝突（合併面板） ─────

async function editChunks($: EngineInterface, edit: (chunks: MergeChunk[]) => MergeChunk[]) {
  await update($, merge, m => ({ ...m, chunks: edit(m.chunks) }))
}

// git 為這個衝突檔案留了哪幾個版本（1 共同祖先、2 ours、3 theirs）。每列是「mode sha stage<TAB>path」，
// 所以整段輸出也代表了這組版本：版本換了（例如 rebase 換到下一個 commit）它就跟著變。
async function listStages($: EngineInterface, path: string) {
  const r = await gitOk($, ['ls-files', '-u', '-z', '--', path])
  const stages = new Set(r.stdout.split('\0').map(line => Number(line.split('\t')[0]?.split(' ')[2])))

  return { key: r.stdout, stages }
}

type Stages = { path: string; key: string; base: string[] | null; ours: string[] | null; theirs: string[] | null }
// 上一次讀到的三個版本：同一個檔案、同一組版本就不用再跑三次 git show。
let stageCache: Stages | undefined

// git 留著的某一個版本；那一邊沒有這個檔案就是 null。
async function readStage($: EngineInterface, stage: 1 | 2 | 3, path: string) {
  const r = await git($, ['show', `:${stage}:${path}`]).catch(() => null)

  return r === null || r.exitCode !== 0 ? null : splitLines(r.stdout)
}

async function readStages($: EngineInterface, path: string, key: string | null): Promise<Stages> {
  if (key !== null && stageCache?.path === path && stageCache.key === key) return stageCache
  const [base, ours, theirs] = await Promise.all([readStage($, 1, path), readStage($, 2, path), readStage($, 3, path)])
  const stages = { path, key: key ?? '', base, ours, theirs }
  if (key !== null) stageCache = stages

  return stages
}

// 讀衝突的檔案。檔案裡還有衝突標記，就拿 git 留著的三個版本自己做三方比對，
// 分出沒動過的、只有一邊改（自動合入）的、真的衝突的段落；讀不到版本才退回只看衝突標記。
// 同一個檔案重讀時，沒變的段落保留已經做的選擇；結果跟現在畫的一樣就不寫，面板不會白白重畫。
async function loadMerge($: EngineInterface, path: string) {
  const [text, listed, m, v] = await Promise.all([
    $.fs.read(inRepo(path)).catch(() => null),
    listStages($, path).catch(() => null),
    read($, merge),
    read($, view),
  ])
  const parsed = text === null ? null : parseConflicts(text)
  let next: MergeView = { ...EMPTY_MERGE, path, op: v.op }
  if (parsed !== null) {
    const { base, ours, theirs } = await readStages($, path, listed?.key ?? null)
    const chunks = ours !== null && theirs !== null ? merge3(base, ours, theirs) : parsed.chunks
    next = {
      ...next,
      ...parsed,
      hasMarkers: true,
      chunks: keepChoices(m.path === path ? m.chunks : [], chunks),
    }
  }
  if (JSON.stringify(next) === JSON.stringify(m)) return
  await update($, merge, () => next)
}

// 上一次跳到的衝突（合併面板上 chunks 的位置）；換了檔案就從頭算。
let conflictCursor = { path: '', at: -1 }

// 跳到下一段（step 1）或上一段（-1）衝突：捲到那一列的頂端，焦點放在 ours 的 Accept 上。
// 捲不動、焦點移不過去（面板沒拿著鍵盤）都不算錯，下次按再試。
async function jumpConflict($: EngineInterface, step: 1 | -1) {
  const m = await read($, merge)
  const at = nextConflict(m.chunks, conflictCursor.path === m.path ? conflictCursor.at : -1, step)
  if (at === null) return
  conflictCursor = { path: m.path, at }
  await $.ui.scroll({ in: MERGE_PANE, to: { key: `conflict:${at}` }, block: 'start' }).catch(() => undefined)
  await $.ui.focus({ requestId: MERGE_PANE, key: `merge:ours:${at}` }).catch(() => undefined)
}

// 點衝突的檔案：開（或切到）三欄的合併面板。
async function openMerge($: EngineInterface, path: string) {
  await loadMerge($, path)
  await bringToFront($, MERGE_PANE)
}

// 放掉選到一半的結果（檔案沒動過，下次打開從頭選）。
async function clearMerge($: EngineInterface) {
  stageCache = undefined
  setMergeBusy($, false)
  await update($, merge, () => EMPTY_MERGE)
}

async function closeMerge($: EngineInterface) {
  await clearMerge($)
  await $.ui.close({ id: MERGE_PANE })
}

// refresh 之後：合併面板的檔案已經不是衝突了（解掉了、abort 了）就關掉，否則重讀一次（檔案可能被改過）。
async function syncMerge($: EngineInterface, files: GitFile[]) {
  if (isMergeBusy) return
  const m = await read($, merge)
  if (m.path === '') return
  const file = files.find(f => f.path === m.path)
  if (file === undefined || !isConflict(file)) {
    await closeMerge($)

    return
  }
  await loadMerge($, m.path)
}

// 合併面板正在套用或用某一邊解掉。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後一直卡著；
// 卡著的話不能再解檔案、也不能換 repo。關掉合併面板時歸零。
let isMergeBusy = false

function setMergeBusy($: EngineInterface, isBusy: boolean) {
  if (isMergeBusy === isBusy) return
  isMergeBusy = isBusy
  $.ui.invalidate('ui.render')
}

// 解掉合併面板上的檔案：做事的期間面板顯示處理中；失敗把錯誤留在面板上，
// 成功就關掉合併面板、重讀狀態，焦點交回 Soap Panel。
async function resolveFile($: EngineInterface, what: string, work: (path: string) => Promise<unknown>) {
  if (isMergeBusy) return
  const m = await read($, merge)
  if (m.path === '') return
  setMergeBusy($, true)
  await setMerge($, { error: '' })
  try {
    await work(m.path)
  } catch (err) {
    setMergeBusy($, false)
    await setMerge($, { error: `${what} failed: ${errorText(err)}` })

    return
  }
  await closeMerge($)
  await refresh($)
  await focusPanel($)
  $.ui.toast(`Resolved ${m.path}`)
}

// 把中間那欄寫回檔案並 git add（標成已解決）。每一段衝突都選好了才做。
async function applyMerge($: EngineInterface) {
  const m = await read($, merge)
  if (!m.hasMarkers || !isResolved(m.chunks)) return
  await resolveFile($, 'Apply', async path => {
    await $.fs.write(inRepo(path), buildResult(m))
    await gitOk($, ['add', '--', path])
  })
}

// 沒有衝突標記的檔案（一邊刪掉、二進位檔）：整個檔案用某一邊，或照目前的樣子標成已解決。
// 那一邊沒有這個檔案（被刪掉了）就 git rm。
async function takeSide($: EngineInterface, side: 'ours' | 'theirs' | 'as-is') {
  await resolveFile($, 'Resolve', async path => {
    if (side === 'as-is') return gitOk($, ['add', '-A', '--', path])
    const { stages } = await listStages($, path)
    if (!stages.has(side === 'ours' ? 2 : 3)) return gitOk($, ['rm', '-q', '--', path])
    await gitOk($, ['checkout', `--${side}`, '--', path])

    return gitOk($, ['add', '--', path])
  })
}

// 交給 Claude 解這個檔案：當作使用者自己打的訊息送出，session 空下來就會跑。
// 檔名來自被合併的分支，會原樣放進以使用者身分送出的訊息：有反引號、換行這些的就不送，免得檔名夾帶指令。
async function askClaude($: EngineInterface) {
  const m = await read($, merge)
  if (m.path === '') return
  if (!isPromptSafePath(m.path)) {
    await setMerge($, { error: 'Ask Claude is off for this file: its name has a backtick or a control character.' })

    return
  }
  const during = m.op === '' ? '' : ` (a ${m.op} is in progress; do not continue or abort it)`
  await $.prompt.submit({
    text: `Resolve the git conflicts in \`${inRepo(m.path)}\`${during}. Keep what both sides meant to do, remove every conflict marker, then run \`git add\` on the file.`,
    asUser: true,
  })
  $.ui.toast('Sent to Claude')
}

// ───── conflict 分頁：abort、continue ─────

// abort／continue：成功跳 toast，失敗把錯誤留在 conflict 分頁，最後重讀狀態。
async function runOp($: EngineInterface, op: Exclude<MergeOp, ''>, args: string[], done: string, env?: Record<string, string>) {
  let opError = ''
  try {
    await gitOk($, args, { env })
    $.ui.toast(`${OP_LABEL[op]} ${done}`)
  } catch (err) {
    opError = errorText(err)
  }
  await setView($, { isAbortArmed: false, opError })
  await refresh($)
}

// abort 要按兩次：第一次只把按鈕換成確認。
async function abortOp($: EngineInterface) {
  const v = await read($, view)
  if (v.op === '') return
  if (!v.isAbortArmed) {
    await setView($, { isAbortArmed: true, opError: '' })

    return
  }
  await runOp($, v.op, [v.op, '--abort'], 'aborted')
}

// 所有衝突都解完後繼續：merge 是直接 commit（用預設訊息），其他是 --continue。
// GIT_EDITOR=true 讓 git 不開編輯器、直接用預設的 commit 訊息。
async function continueOp($: EngineInterface) {
  const v = await read($, view)
  if (v.op === '') return
  const args = v.op === 'merge' ? ['commit', '--no-edit'] : [v.op, '--continue']
  await runOp($, v.op, args, 'continued', { GIT_EDITOR: 'true' })
}

// ───── Services 分頁 ─────

// Windows 用 PowerShell，其他（macOS）用 ps、lsof、kill。平台不會變，問一次就記著。
let windows: boolean | undefined

async function isWindows($: EngineInterface) {
  windows ??= (await $.env.get('OS')) === 'Windows_NT'

  return windows
}

async function scanWindows($: EngineInterface) {
  const r = await runOk($, SCAN_ARGV, 'Process scan')

  return JSON.parse(r.stdout) as ScanResult
}

// 先用 ps 列出所有程序和 port，再只對用得到的程序讀工作目錄和執行檔。
async function scanMac($: EngineInterface) {
  const r = await runOk($, MAC_SCAN_ARGV, 'Process scan', { env: MAC_ENV })
  const all = parseMacScan(r.stdout)
  const want = wantedPids(all)
  // 有讀不到的程序（root 跑的）lsof 會回 1，照樣用它讀到的。
  const files = await $.process.run(macFilesArgv(want), { env: MAC_ENV })

  return withFiles(all, want, parseMacFiles(files.stdout))
}

// 掃一次：這個資料夾的服務，和目前所有活著的 PID（重跑後的檢查用）。
async function scan($: EngineInterface) {
  const [result, cwd] = await Promise.all([(await isWindows($)) ? scanWindows($) : scanMac($), $.session.root()])

  return { items: findServices(result, cwd), alive: new Set(result.pids) }
}

// 砍整棵程序樹。子孫要比父程序晚開才算（PID 被重用的不算），兩邊都一樣：
// Windows 交給 KILL_ARGV 的 PowerShell，macOS 先用 ps 找出子孫再一起 kill -9。
async function killTree($: EngineInterface, pid: number) {
  if (await isWindows($)) {
    await runOk($, KILL_ARGV, 'Stop', { env: { SOAP_PID: String(pid) } })

    return
  }
  const ps = await runOk($, MAC_PPIDS_ARGV, 'ps', { env: MAC_ENV })
  const kill = await $.process.run(['kill', '-9', ...descendants(ps.stdout, pid).map(String)])
  // 樹裡有程序剛好自己先結束（No such process）不算失敗。
  const errors = kill.stderr.split('\n').filter(l => l.trim() !== '' && !/no such process/i.test(l))
  if (kill.exitCode !== 0 && errors.length > 0) throw failure(kill, 'kill')
}

// 同一時間只掃一次；掃到一半又被叫，掃完再補掃一次，畫面才不會停在舊的。
let isScanning = false
let isRescanWanted = false

async function refreshServices($: EngineInterface) {
  if (isScanning) {
    isRescanWanted = true

    return
  }
  isScanning = true
  try {
    do {
      isRescanWanted = false
      try {
        await setServices($, { isLoaded: true, items: (await scan($)).items, error: '' })
      } catch (err) {
        await setServices($, {
          isLoaded: true,
          error: isMissingCommand(err) ? 'Services needs PowerShell on Windows, or ps and lsof on macOS.' : `Scan failed: ${errorText(err)}`,
        })
      }
    } while (isRescanWanted)
  } finally {
    isScanning = false
  }
}

// 正在停掉／重跑的服務。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後那個 PID 的按鈕永遠按不動。
let servicePending: ServicePending[] = []

function setPending($: EngineInterface, pid: number, action: ServiceAction | undefined) {
  servicePending = [...servicePending.filter(p => p.pid !== pid), ...(action === undefined ? [] : [{ pid, action }])]
  $.ui.invalidate('ui.render')
}

// 停掉／重跑一個服務。動手前重新掃一次，確認還是同一個程序（PID 沒有被別人拿去用），才砍整棵程序樹。
async function runServiceAction($: EngineInterface, target: Service, action: ServiceAction) {
  if (servicePending.some(p => p.pid === target.pid)) return
  setPending($, target.pid, action)
  await setServices($, { actionError: '' })
  try {
    const current = (await scan($)).items.find(s => s.pid === target.pid && s.startedAt === target.startedAt)
    if (current === undefined) throw new Error(`${target.tool} · ${target.name} already exited.`)
    if (action === 'restart' && current.command === '') throw new Error(`Cannot read the command line of ${current.tool} · ${current.name}.`)
    if (action === 'restart' && !(await isWindows($)) && !isShellSafe(current.command)) {
      throw new Error(`Cannot rerun ${current.tool} · ${current.name}: its command has quotes or shell characters that ps does not keep. Restart it yourself.`)
    }

    await killTree($, current.pid)

    if (action === 'restart') {
      await $.clock.sleep(RESTART_GAP_MS)
      const argv = (await isWindows($)) ? LAUNCH_ARGV : MAC_LAUNCH_ARGV
      const launch = await runOk($, argv, 'Restart', { env: { SOAP_CMD: current.command, SOAP_DIR: current.dir } })
      watchRestart($, `${current.tool} · ${current.name}`, Number(launch.stdout.trim()))
      $.ui.toast(`Restarted ${current.tool} · ${current.name}`)
    } else {
      $.ui.toast(`Stopped ${current.tool} · ${current.name}`)
    }
  } catch (err) {
    await setServices($, { actionError: `${action === 'stop' ? 'Stop' : 'Restart'} failed: ${errorText(err)}` })
  } finally {
    setPending($, target.pid, undefined)
  }
  await refreshServices($)
}

// 重跑後的檢查：每個時間點重掃一次（順便更新清單），新程序已經不在了就算重跑失敗，在面板上提示
// （沒存 log，原因要自己跑一次看）。
function watchRestart($: EngineInterface, name: string, pid: number) {
  let isDone = false
  for (const ms of RESTART_CHECK_MS) {
    $.clock.after(ms, async () => {
      if (isDone) return
      try {
        const { items, alive } = await scan($)
        isDone = !alive.has(pid)
        await setServices($, {
          isLoaded: true,
          items,
          error: '',
          ...(isDone ? { actionError: `Restart failed: ${name} exited right after starting. Run its command yourself to see why.` } : {}),
        })
      } catch {
        // 掃不了就算了，下一個時間點再看。
      }
    })
  }
}

// Services 分頁看得到時才定時掃，看不到就不花那一秒。
async function scanWhenShown($: EngineInterface) {
  if ((await read($, tab)) !== 'services') return
  const pane = (await $.ui.panes()).find(p => p.id === PANE)
  if (pane?.isShown !== true) return
  await refreshServices($)
}

// ───── 換分頁 ─────

// 換分頁（上層 Tab 或子分頁）時清掉的東西：錯誤訊息、待確認的 abort、branch 和 log 的搜尋。
async function leaveTab($: EngineInterface) {
  await Promise.all([clearGitMessages($), update($, branchQuery, () => ''), clearLogQuery($)])
}

async function selectTab($: EngineInterface, id: TabId) {
  await Promise.all([update($, tab, () => id), leaveTab($)])
  // 掃描要一秒左右，不等它：先切過去畫「掃描中」或舊清單。
  if (id === 'services') void refreshServices($).catch(() => undefined)
}

// 換子分頁。log 不在看的時候不讀，換過來才讀。
async function selectSubTab($: EngineInterface, id: GitSubTab) {
  await Promise.all([update($, subTab, () => id), leaveTab($)])
  if (id === 'log') await loadLog($)
}

// branch 分頁的 log 按鈕：換到 log 分頁看那個分支，從最近的 LOG_PAGE 筆開始。
// 按目前分支那列就是回到「跟著目前分支」，之後切分支 log 也跟著換。
async function viewLog($: EngineInterface, b: GitBranch) {
  dropLogLoads()
  await update($, log, () => ({ ...EMPTY_LOG, ref: b.isCurrent ? '' : branchRef(b) }))
  await selectSubTab($, 'log')
}

// 複製圖示換成綠底打勾後，COPIED_MS 換回來的計時；又按了一次就先停掉舊的。
let uncopyTimer: Timer | undefined

// branch 分頁的複製按鈕：把分支名稱（遠端的含 origin/）放到按的那個畫面的剪貼簿，
// 按鈕變成綠底打勾 COPIED_MS 再換回來。
async function copyBranchName($: EngineInterface, name: string, surface: RenderSurface) {
  const r = await $.ui.copy({ text: name, surface })
  if (!r.isCopied) return setView($, { ...NO_MESSAGES, branchError: `Couldn't copy ${name} (${r.reason})` })
  uncopyTimer?.cancel()
  await setView($, { copied: name })
  uncopyTimer = $.clock.after(COPIED_MS, () => void setView($, { copied: '' }))
}

// 畫面上的按鈕能做的事（ui/actions.ts 的約定），全部接到上面的動作。
function actionsFor($: EngineInterface, surface: RenderSurface): Actions {
  return {
    selectTab: id => selectTab($, id),
    selectSubTab: id => selectSubTab($, id),
    selectRepo: name => selectRepo($, name),
    openDiff: path => openDiff($, path),
    openMerge: path => openMerge($, path),
    showMoreFiles: () => update($, fileLimit, n => n + FILE_PAGE),
    searchBranches: text => update($, branchQuery, () => text),
    toggleRemote: () => update($, showRemote, open => !open),
    toggleBranchFolder: (key, isOpen) => update($, branchFolders, folders => ({ ...folders, [key]: isOpen })),
    switchBranch: (name, isRemote) => switchBranch($, name, isRemote),
    deleteBranch: name => deleteBranch($, name),
    syncBranches: kind => syncBranches($, kind),
    viewLog: b => viewLog($, b),
    copyBranchName: name => copyBranchName($, name, surface),
    searchLog: text => searchLog($, text),
    loadMoreLog: () => loadMoreLog($),
    openCommit: c => openCommits($, [c]),
    toggleRangePick: () => update($, log, l => ({ ...l, isPicking: !l.isPicking, rangeStart: '' })),
    pickRange: c => pickRange($, c),
    closeCommit: () => setLog($, NO_COMMIT),
    openCommitDiff: (commits, f, files) => openCommitDiff($, commits, f, files),
    stepCommitFile: step => stepCommitFile($, step),
    abortOp: () => abortOp($),
    cancelAbort: () => setView($, { isAbortArmed: false }),
    continueOp: () => continueOp($),
    // 不等它做完：停掉、重跑要好幾秒，按鈕先換成「Stopping…」。
    runServiceAction: (s, action) => void runServiceAction($, s, action),
    editChunks: edit => editChunks($, edit),
    jumpConflict: step => jumpConflict($, step),
    takeSide: side => takeSide($, side),
    applyMerge: () => applyMerge($),
    askClaude: () => askClaude($),
  }
}

// ───── 事件 ─────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'soap-panel',
      description: 'Open Soap Panel (Git panel)',
    })
    // 先開面板（畫「讀取中…」），git 在背景讀，不擋住 session 開始。
    void $.ui.open(PANE_ARGS)
    void refresh($).catch(() => undefined)
    $.clock.every(FOCUS_WATCH_MS, () => void focusWhenShown($))
    // 用量直接跟引擎拿（不花錢），這裡只負責讓重置倒數每分鐘重畫一次。
    $.clock.every(USAGE_TICK_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(SERVICES_SCAN_MS, () => void scanWhenShown($).catch(() => undefined))

    return next(e)
  })

  // 某個用量視窗動了一整個百分點，就重畫底部的用量。
  on('session.measure', ($, e, next) => {
    if (e.changed.includes('rateLimits')) $.ui.invalidate('ui.render')

    return next(e)
  })

  on('command.run', { command: 'soap-panel' }, async $ => {
    await refresh($)
    await $.ui.open(PANE_ARGS)

    return { text: 'Soap Panel opened.' }
  })

  // 每個回合結束後，檔案可能已經變了，順手更新。不等它讀完，免得擋住回合結束；讀不到就維持舊畫面。
  on('turn.complete', ($, e, next) => {
    void refresh($).catch(() => undefined)

    return next(e)
  })

  // 自己按掉 diff 面板時：清掉選中的檔案，並把焦點交回 Soap Panel。
  // 桌面版的面板沒有焦點時，按下滑鼠會先拿焦點、整個面板重畫，按到的按鈕被換掉，那一下就不算；
  // 先把焦點給它，回來的第一下才點得到。
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.origin.kind !== 'person' || (e.id !== DIFF_PANE && e.id !== MERGE_PANE)) return result
    // 合併面板被按掉：放掉選到一半的結果（檔案沒動過，下次打開從頭選）。
    await (e.id === DIFF_PANE ? update($, diffPane, () => EMPTY_DIFF) : clearMerge($))
    await focusPanel($)

    return result
  }).catch(($, e, next) => next(e)) // 清不掉就算了，絕不能擋住關面板。

  // 畫面：這裡讀狀態，交給 ui/ 的純函式畫。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [activeTab, activeSub, v, isRemoteOpen, bf, bq, fl, sv, lg, lq, usage, now] = await Promise.all([
      read($, tab),
      read($, subTab),
      read($, view),
      read($, showRemote),
      read($, branchFolders),
      read($, branchQuery),
      read($, fileLimit),
      read($, services),
      read($, log),
      read($, logQuery),
      // 讀不到用量就當作還沒有讀數，不要讓整個面板畫不出來。
      $.session.usage().catch(() => undefined),
      $.clock.now(),
    ])

    return renderPanel(
      $.ui.resolve(e),
      {
        surface: e.surface,
        bodyRows: e.props.scroll.bodyRows,
        tab: activeTab,
        subTab: activeSub,
        view: v,
        showRemote: isRemoteOpen,
        branchFolders: bf,
        branchQuery: bq,
        fileLimit: fl,
        syncing,
        services: sv,
        servicePending,
        log: lg,
        logQuery: lq,
        usage: usage?.rateLimits ?? [],
        now,
      },
      actionsFor($, e.surface),
      fn => act($, PANE, fn),
    )
  })

  // 選中檔案的差異，開在自己的面板裡。
  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) =>
    renderDiffPane($.ui.resolve(e), await read($, diffPane), actionsFor($, e.surface), fn => act($, DIFF_PANE, fn)),
  )

  // 解衝突的三欄面板。按了之後按鈕被換掉會丟焦點，由 act 在之後補回來。
  on('ui.render', { component: 'Pane', requestId: MERGE_PANE }, async ($, e) => {
    return renderMergePane($.ui.resolve(e), await read($, merge), isMergeBusy, actionsFor($, e.surface), fn => act($, MERGE_PANE, fn))
  })
}
