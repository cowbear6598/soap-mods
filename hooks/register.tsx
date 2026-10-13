// 進入點：狀態（atom）、所有碰到 $ 的動作，和引擎事件的接線。
// 引擎只讓這個檔案碰 $ 和 atom（傳 $ 給 import 進來的函式、用別的檔案的 atom 都會被擋），
// 所以這裡只放「跑 git、讀寫狀態、開關面板」；其餘都是 import 進來的純函式：
//   config.ts      常數（面板、分頁、顏色、時間）
//   defaults.ts    狀態的初始值
//   patch.ts       改物件 atom 的幾個欄位（沒變就不寫）
//   cover.ts       蓋住分頁的畫面（差異、合併、檔案內容），一次一個
//   latest.ts      非同步讀取只寫最新的那次
//   neighbour.ts   Previous／Next 的上一個／下一個
//   git/           解析 git 輸出（parse）、repo 的參數和解析（repo）
//   merge/algo.ts  三方合併
//   services/      找服務（scan）
//   files/         Files 分頁的排序、路徑（list）
//   spec/          Spec 分頁：讀 plan.yaml、挑格式錯誤（parse）
//   db/            DB 分頁：連線字串、只准 SELECT、sqlcmd 的參數和輸出（sql），密碼存哪裡（secret）
//   ui/            畫面：拿到資料和 Actions 畫出樹（panel、tabs/、diffView、mergeView）

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PaneOpenArgs,
  ProcessRunInit,
  Register,
  RenderChildren,
  RenderSurface,
  Timer,
  ToolCallResult,
  UiPressArgument,
} from 'claude-code'

import type {
  CommitFile,
  Cover,
  DbTable,
  DbView,
  DiffPaneView,
  FileView,
  FilesView,
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
  SpecEntry,
  SpecView,
  TabId,
} from '../types'
import {
  COPIED_MS,
  DB_PROCESS_TIMEOUT_MS,
  DB_STORE_KEY,
  DELETE_ARM_MS,
  FILE_PAGE,
  FILES_ROW_LIMIT,
  FILE_VIEW_MAX_BYTES,
  FOCUS_WATCH_MS,
  LOG_PAGE,
  OP_LABEL,
  PANEL_TITLE,
  REFOCUS_AFTER_PRESS_MS,
  RESTART_CHECK_MS,
  RESTART_GAP_MS,
  SERVICES_SCAN_MS,
  SPEC_DIR,
  SYNC_TIMEOUT_MS,
  USAGE_TICK_MS,
} from './config'
import { NO_COVER, coverData, patchCover, showCover } from './cover'
import { EMPTY, EMPTY_DB, EMPTY_DIFF, EMPTY_FILE_VIEW, EMPTY_FILES, EMPTY_LOG, EMPTY_MERGE, EMPTY_PLAN, EMPTY_SERVICES, EMPTY_SPEC, NO_COMMIT, NO_DB_CONNECTION, NO_MESSAGES } from './defaults'
import { fileSteps, formatSize, sortEntries, viewText } from './files/list'
import { errorText, failure, isMissingCommand } from './errors'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  branchRef,
  commitRange,
  diffSteps,
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
  macArgsArgv,
  macFilesArgv,
  parseMacArgs,
  parseMacFiles,
  parseMacScan,
  wantedPids,
  withFiles,
} from './services/mac'
import { KILL_ARGV, LAUNCH_ARGV, SCAN_ARGV, findServices, powershellArgv } from './services/scan'
import {
  KEYCHAIN,
  type SavedConnection,
  TABLES_QUERY,
  columnsQuery,
  connectionId,
  connectionName,
  listed,
  parseColumns,
  parseConnectionString,
  parseTable,
  parseTables,
  previewQuery,
  savedConnections,
  selectOnlyError,
  sqlcmdArgv,
  tableKey,
} from './db/sql'
import { MAC_SAVE_ARGV, WIN_PROTECT_ARGV, WIN_UNPROTECT_ARGV, fromHex, macCheckArgv, macDeleteArgv, macReadArgv, macSaveInput, toHex } from './db/secret'
import { isPlanPath, planFixNote, planPath, readPlan, sortSpecs } from './spec/parse'
import type { Actions, DbBusy } from './ui/actions'
import { buttonKeys, ringAnchor, tabIconKey } from './ui/keys'
import { renderPanel } from './ui/panel'
import { latestOnly } from './latest'
import { neighbour } from './neighbour'
import { patch } from './patch'

// ───── 面板 id（引擎要在這個檔案裡直接看到值，不能 import）─────

// 只有這一個面板：差異和解衝突都畫在它裡面（另開面板的話，焦點轉不過去，快捷鍵按不到）。
const PANE = 'soap-panel'
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
const files = atom({ plugin: 'soap-mods', key: 'files' } as const, EMPTY_FILES)
// Spec 分頁：.soap/tasks 底下的 feature 清單，和點開的那份 plan.yaml。
const spec = atom({ plugin: 'soap-mods', key: 'spec' } as const, EMPTY_SPEC)
const log = atom({ plugin: 'soap-mods', key: 'log' } as const, EMPTY_LOG)
// DB 分頁：存著的連線（不含密碼）、打開的那個的資料表、查詢和結果。
const db = atom({ plugin: 'soap-mods', key: 'db' } as const, EMPTY_DB)
// 蓋住分頁的畫面：差異、三欄合併或檔案內容，一次一個（cover.ts）。
const cover = atom({ plugin: 'soap-mods', key: 'cover' } as const, NO_COVER)

// 改一個物件 atom 的其中幾個欄位；改的欄位內容都沒變就不寫（patch），面板不會白白重畫。
// 引擎要看得出改的是哪個 atom，所以每個 atom 一個，不能寫成通用的。
async function setView($: EngineInterface, change: Partial<GitView>) {
  await update($, view, v => patch(v, change))
}

async function setLog($: EngineInterface, change: Partial<LogView>) {
  await update($, log, l => patch(l, change))
}

// 只改開著的合併；開著的不是合併就不動。
async function setMerge($: EngineInterface, change: Partial<MergeView>) {
  await update($, cover, c => patchCover(c, 'merge', change))
}

// 開著的合併、差異、檔案內容；開著的不是它就是空的（path 是 ''）。
async function readMerge($: EngineInterface) {
  return coverData(await read($, cover), 'merge') ?? EMPTY_MERGE
}

async function readDiffCover($: EngineInterface) {
  return coverData(await read($, cover), 'diff') ?? EMPTY_DIFF
}

async function readFileCover($: EngineInterface) {
  return coverData(await read($, cover), 'file') ?? EMPTY_FILE_VIEW
}

async function setServices($: EngineInterface, change: Partial<ServicesView>) {
  await update($, services, s => patch(s, change))
}

async function setFiles($: EngineInterface, change: Partial<FilesView>) {
  await update($, files, f => patch(f, change))
}

async function setSpec($: EngineInterface, change: Partial<SpecView>) {
  await update($, spec, s => patch(s, change))
}

async function setDb($: EngineInterface, change: Partial<DbView>) {
  await update($, db, v => patch(v, change))
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

// 焦點有三種會丟：
// 1. 引擎知道的：點分頁標籤切到 Soap Panel 時引擎不會通知、也不給焦點；按完按鈕有時也會丟（引擎回報沒焦點）。
//    定時看一下（focusWhenShown）：它「剛被切到前面」或「剛按完按鈕」又沒焦點，就把焦點給它。
//    只在那兩種時候給，平常在輸入框打字不會被搶。
// 2. 引擎不知道的：按的按鈕重畫後不見了（整塊換成差異、合併，那列消失），桌面版的焦點會掉到輸入框，
//    引擎卻還以為 Soap Panel 拿著鍵盤，給焦點也補不回來，快捷鍵就跑去輸入框。
//    要把焦點圈移到看得到的按鈕上才行：每次畫完檢查剛按的那顆還在不在（checkPressed）。
// 3. 按了這個畫面沒綁的字母（log 分頁按 m）：桌面版把那個鍵交給輸入框，焦點跟著跑過去。
//    這種在畫面那層擋掉（ui/panel.tsx 的 strayKeys）。
// 上一輪看的時候在不在前面；沒記錄當作在（剛啟動不搶焦點）。
let wasShown: boolean | undefined
let isWatching = false
// 按完按鈕後，到這個時間點之前丟了焦點（引擎知道的）就補回來；undefined 是沒有要補。
let refocusUntil: number | undefined
// 剛按的按鈕（key，處理完是 undefined）、它換掉後焦點圈的首選（to），看到什麼時候（until：
// 動作還在跑是 Infinity，做完再給 REFOCUS_AFTER_PRESS_MS）。這段時間內畫面上沒了這顆，就把焦點圈移走。
let pressed: { key?: string; to?: string; until: number } | undefined

async function isPaneShown($: EngineInterface) {
  const pane = (await $.ui.panes()).find(p => p.id === PANE)

  return pane?.isShown === true
}

async function focusPanel($: EngineInterface) {
  await $.ui.open({ ...PANE_ARGS, focus: true })
}

// 把 Soap Panel 的焦點圈移到 key 那個按鈕上；Soap Panel 沒拿著鍵盤就算了。
async function ringOn($: EngineInterface, key: string) {
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// 蓋上或換掉差異、合併時，捲回 Soap Panel 最上面從頭看。
async function scrollTop($: EngineInterface) {
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
}

// 包住面板上按鈕的動作：記下按的是哪顆，動作做完（可能要跑 git 很久）才開始算那段時間。
// ringKey：按的按鈕會換成這顆（兩邊都要 → Reset），焦點圈優先移到它，不移到遠處的 Back。
function act($: EngineInterface, fn: () => unknown, ringKey?: string) {
  return async (e: UiPressArgument) => {
    const mine = { key: e.element, to: ringKey, until: Infinity }
    pressed = mine
    try {
      await fn()
    } finally {
      const end = (await $.clock.now()) + REFOCUS_AFTER_PRESS_MS
      refocusUntil = end
      mine.until = end
    }
  }
}

// 每次畫完：剛按的那顆不在畫面上了，就把焦點圈移到 ringAnchor（換上來的那顆、Back、分頁圖示）。
// 還沒有落點可移（套用中，Back 藏起來了）就等下一次畫。畫的 hook 裡不能等自己畫出來的東西，所以等畫完再移。
function checkPressed($: EngineInterface, tree: RenderChildren, now: number, t: string, sub: string) {
  const p = pressed
  if (p?.key === undefined || now >= p.until) return
  const keys = buttonKeys(tree)
  if (keys.has(p.key)) {
    // 動作做完還在，就不會再不見了。
    if (p.until !== Infinity) p.key = undefined

    return
  }
  const anchor = ringAnchor(keys, t, sub, p.to)
  if (anchor === undefined) return
  p.key = undefined
  $.clock.after(0, () => void ringOn($, anchor))
}

// 上一次畫的蓋版畫面。沒按按鈕它自己不見了（回合結束發現衝突解掉了、差異的檔案沒有變更了），
// checkPressed 管不到：畫面整塊換回分頁，焦點圈移到分頁圖示。
let drawnCover: Cover['kind'] = 'none'

function checkCover($: EngineInterface, kind: Cover['kind'], now: number, t: string, sub: string) {
  const wasCovered = drawnCover !== 'none'
  drawnCover = kind
  const isPressing = pressed !== undefined && now < pressed.until
  if (wasCovered && kind === 'none' && !isPressing) $.clock.after(0, () => void ringOn($, tabIconKey(t, sub)))
}

async function focusWhenShown($: EngineInterface) {
  if (isWatching) return
  isWatching = true
  try {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    const isShown = pane?.isShown === true
    if (isShown && pane?.isFocused === false) {
      const isJustPressed = refocusUntil !== undefined && (await $.clock.now()) < refocusUntil
      if (wasShown === false || isJustPressed) {
        await focusPanel($)
        refocusUntil = undefined
      }
    }
    if (isShown && wasShown === false) refreshIfStale($)
    wasShown = isShown
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

// 同一時間只讀一次：讀到一半又被叫（回合結束、按了按鈕、換了 repo），讀完再補讀一次；
// 等著的呼叫拿到同一個 promise，補讀完才結束。有補讀排著時，這次讀到的可能是舊的，就不寫，交給補讀。
let refreshing: Promise<void> | undefined
let isRefreshWanted = false

function refresh($: EngineInterface): Promise<void> {
  isGitStale = false
  if (refreshing !== undefined) {
    isRefreshWanted = true

    return refreshing
  }
  refreshing = (async () => {
    try {
      do {
        isRefreshWanted = false
        await readGit($)
      } while (isRefreshWanted)
    } finally {
      refreshing = undefined
    }
  })()

  return refreshing
}

// 回合結束時 git 狀態看不到（停在 Files、Spec 分頁、Soap Panel 不在前面）就不讀，只記著；
// 換到 Git、Services 分頁（照那排 repo 分組），或 Soap Panel 被切到前面時再讀。
let isGitStale = false

// 畫得到 git 狀態的分頁：Git，和照 repo 分組的 Services。新分頁預設不讀 git。
const showsGit = (t: TabId) => t === 'git' || t === 'services'

async function refreshWhenShown($: EngineInterface) {
  if (showsGit(await read($, tab)) && (await isPaneShown($))) await refresh($)
  else isGitStale = true
}

function refreshIfStale($: EngineInterface) {
  if (isGitStale) void refresh($).catch(() => undefined)
}

// 選中的 repo 的狀態、分支、.git 裡的檔案，和其他 repo 的摘要，一起讀。
// 這次讀的 repo 固定下來：中途換了 repo，也不會把這個 repo 的狀態算到別的 repo 頭上。
async function readRepos($: EngineInterface, active: Repo) {
  const [status, refs, names, others] = await Promise.all([
    git($, STATUS_ARGS, { cwd: active.root }),
    git($, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'], { cwd: active.root }),
    readGitDir($, active),
    Promise.all(repos.list.map(c => (c === active ? undefined : summarize($, c)))),
  ])

  return { status, refs, names, others }
}

// 重新讀 git 狀態、檔案清單、分支清單，保留原本點開的檔案；最後只寫一次 view，只重畫一次。
async function readGit($: EngineInterface) {
  const isStale = () => isRefreshWanted
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
    snap = { active, ...(await readRepos($, active)) }
  } catch (err) {
    if (!isStale()) await setView($, { isLoaded: true, isRepo: false, error: gitErrorText(err) })

    return
  }
  if (isStale()) return

  const { active, status, refs, names, others } = snap
  // 那排 repo：選中的那個用下面完整讀到的狀態，其他的用 summarize 的。
  const repoBar = (changes: GitFile[]) => others.map(o => o ?? toSummary(active, changes))

  if (status.exitCode !== 0) {
    // 開著工作區檔案的差異就關掉；commit 裡的檔案不受影響。
    await update($, cover, c => (coverData(c, 'diff')?.commits.length === 0 ? NO_COVER : c))
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

  const changes = parseActiveStatus(status.stdout)
  // 開著工作區檔案的差異就重讀；那個檔案已經沒有變更了，readDiff 給空的，就回到分頁。
  // 開著的是 commit 裡的檔案就不用動，commit 不會變。內容沒變就不寫，整個 Soap Panel 不會白白重畫；
  // 讀的時候換了畫面（按了 Back、換了檔案）也不寫。
  const shown = coverData(await read($, cover), 'diff')
  const reread = shown !== undefined && shown.commits.length === 0 ? await readDiff($, changes, shown.path) : undefined
  if (isStale()) return
  await Promise.all([
    setView($, {
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
      : update($, cover, c => {
          const cur = coverData(c, 'diff')
          if (cur === undefined || cur.path !== shown?.path || cur.commits.length > 0) return c

          return reread.path === '' ? NO_COVER : showCover(c, 'diff', reread)
        }),
  ])
  // log 只在看得到時重讀（換到 log 分頁時也會讀）。
  await Promise.all([syncMerge($, changes), (await read($, subTab)) === 'log' ? loadLog($) : undefined])
}

// 換 Git 分頁看的 repo：開著的差異／合併是上一個 repo 的檔案，回到分頁；合併正在寫檔時不換。
async function selectRepo($: EngineInterface, name: string) {
  const next = repos.list.find(c => c.name === name)
  if (next === undefined || next === repos.current || isMergeBusy) return
  repos.current = next
  logLoads.drop()
  await Promise.all([
    setView($, { repo: name, ...NO_MESSAGES }),
    closeCover($),
    // log 換成新 repo 的目前分支。
    update($, log, () => EMPTY_LOG),
  ])
  await refresh($)
}

// 換分頁時清掉切換／刪除分支、abort／continue 失敗的訊息和待確認的刪除、abort；沒有要清的就不寫，免得面板白白重畫。
async function clearGitMessages($: EngineInterface) {
  await setView($, NO_MESSAGES)
}

// ───── 差異（畫在 Soap Panel 裡） ─────

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

// 讀工作區一個檔案的 diff：已追蹤的對 HEAD，未追蹤的對空檔案。
// Previous／Next 照 diff 分頁的檔案順序走（diffSteps）；每次 refresh 都會重讀，清單跟著更新。
async function readDiff($: EngineInterface, files: GitFile[], path: string): Promise<DiffPaneView> {
  const file = files.find(f => f.path === path)
  if (file === undefined) return EMPTY_DIFF
  const result = await (file.x === '?'
    ? runDiff($, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path])
    : runDiff($, ['diff', ...DIFF_FLAGS, 'HEAD', '--', path], ['diff', ...DIFF_FLAGS, '--cached', '--', path]))

  return { ...EMPTY_DIFF, path, kind: fileKind(file), ...result, files: diffSteps(files) }
}

// 在 Soap Panel 裡看這個檔案的差異（蓋掉分頁），捲回最上面從頭看。
// 不另開面板：鍵盤一直在 Soap Panel 上，Back／Previous／Next 的快捷鍵才按得到。
// 按的那列不見了，焦點圈由 checkPressed 移到 Back。
async function showDiff($: EngineInterface, pane: DiffPaneView) {
  await update($, cover, c => showCover(c, 'diff', pane))
  await scrollTop($)
}

// 點檔案：在 Soap Panel 裡看它的差異；Back 回分頁。
async function openDiff($: EngineInterface, path: string) {
  await showDiff($, await readDiff($, (await read($, view)).files, path))
}

// 讀 commit 裡一個檔案在這（幾）個 commit 的差異。改名的檔案兩個路徑都要給，git 才認得出是改名。
// files 是同一批的全部檔案，Previous／Next 照它走。
async function readCommitDiff($: EngineInterface, commits: GitCommit[], f: CommitFile, files: CommitFile[]): Promise<DiffPaneView> {
  const paths = f.oldPath === '' ? [f.path] : [f.oldPath, f.path]
  const result = await runDiff($, ['diff-tree', '-p', '-M', ...DIFF_FLAGS, '--no-commit-id', ...commitRange(commits), '--', ...paths])

  return { path: f.path, kind: letterKind(f.letter), ...result, commits, files }
}

// 點 commit 裡的檔案：看它在這（幾）個 commit 的差異。
async function openCommitDiff($: EngineInterface, commits: GitCommit[], f: CommitFile, files: CommitFile[]) {
  await showDiff($, await readCommitDiff($, commits, f, files))
}

// 差異的 Previous／Next：換成上一個／下一個檔案。
async function stepDiffFile($: EngineInterface, step: 1 | -1) {
  const d = await readDiffCover($)
  const next = neighbour(d.files, f => f.path === d.path, step)
  if (next === undefined) return
  const isWorkTree = d.commits.length === 0
  await showDiff($, await (isWorkTree ? readDiff($, (await read($, view)).files, next.path) : readCommitDiff($, d.commits, next, d.files)))
}

// ───── branch 分頁 ─────

// 切換分支要按兩次：第一次只把那列標成「再按一次」，DELETE_ARM_MS 內再按同一列才切；按別列就改標那列。
async function switchBranch($: EngineInterface, name: string, isRemote: boolean) {
  const id = `${isRemote ? 'r' : 'l'}:${name}`
  if ((await read($, view)).switchArmed !== id) {
    await arm($, { switchArmed: id })

    return
  }
  disarmTimer?.cancel()
  await setView($, { switchArmed: '' })
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

// 待確認的刪除（打勾）、切換（再按一次）一次只有一個，DELETE_ARM_MS 後收回去；再按（做了或按了別列）就先停掉舊的計時。
let disarmTimer: Timer | undefined

async function arm($: EngineInterface, armed: Partial<GitView>) {
  disarmTimer?.cancel()
  await setView($, { ...NO_MESSAGES, ...armed })
  disarmTimer = $.clock.after(DELETE_ARM_MS, () => void setView($, { deleteArmed: null, switchArmed: '' }))
}

const armDelete = ($: EngineInterface, name: string, isForce: boolean) => arm($, { deleteArmed: { name, isForce } })

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

// 讀完時已經有更新的讀取開始了（打字、Load more、refresh），或中途換了分支、repo、分頁（logLoads.drop），
// 這次讀到的就不寫，免得蓋掉新的。
const logLoads = latestOnly()

// 讀 log 分頁的 commit，列前 limit 筆（沒給就是目前的筆數）；有搜尋時從整條分支的歷史裡挑出符合的。
// isFresh 是 false 時（打字、Load more）沿用讀過的歷史。
async function loadLog($: EngineInterface, { isFresh = true, limit }: { isFresh?: boolean; limit?: number } = {}) {
  const isStale = logLoads.start()
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
    // 內容沒變 patch 就不寫，停在 log 分頁時回合結束不會白白重畫。
    await update($, log, cur =>
      patch(cur, {
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
      }),
    )
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
  logLoads.drop()
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

// ───── 解衝突（合併） ─────

async function editChunks($: EngineInterface, edit: (chunks: MergeChunk[]) => MergeChunk[]) {
  await update($, cover, c => {
    const m = coverData(c, 'merge')

    return m === undefined ? c : patchCover(c, 'merge', { chunks: edit(m.chunks) })
  })
}

// git 為這個衝突檔案留了哪幾個版本（1 共同祖先、2 ours、3 theirs）。每列是「mode sha stage<TAB>path」，
// 所以整段輸出也代表了這組版本：版本換了（例如 rebase 換到下一個 commit）它就跟著變。
async function listStages($: EngineInterface, path: string) {
  const r = await gitOk($, ['ls-files', '-u', '-z', '--', path])
  const stages = new Set(r.stdout.split('\0').map(line => Number(line.split('\t')[0]?.split(' ')[2])))

  return { key: r.stdout, stages }
}

// 三個版本做完三方比對的段落；少了 ours 或 theirs（一邊刪掉）比不了是 null。
type Stages = { path: string; key: string; chunks: MergeChunk[] | null }
// 上一次讀到的版本和比對結果：同一個檔案、同一組版本就不用再跑三次 git show，也不用再比一次。
let stageCache: Stages | undefined

// git 留著的某一個版本；那一邊沒有這個檔案就是 null。
async function readStage($: EngineInterface, stage: 1 | 2 | 3, path: string) {
  const r = await git($, ['show', `:${stage}:${path}`]).catch(() => null)

  return r === null || r.exitCode !== 0 ? null : splitLines(r.stdout)
}

async function readStages($: EngineInterface, path: string, key: string | null): Promise<Stages> {
  if (key !== null && stageCache?.path === path && stageCache.key === key) return stageCache
  const [base, ours, theirs] = await Promise.all([readStage($, 1, path), readStage($, 2, path), readStage($, 3, path)])
  const stages = { path, key: key ?? '', chunks: ours !== null && theirs !== null ? merge3(base, ours, theirs) : null }
  if (key !== null) stageCache = stages

  return stages
}

// 讀衝突的檔案。檔案裡還有衝突標記，就拿 git 留著的三個版本自己做三方比對，
// 分出沒動過的、只有一邊改（自動合入）的、真的衝突的段落；讀不到版本才退回只看衝突標記。
// 同一個檔案重讀時，沒變的段落保留已經做的選擇；結果跟現在畫的一樣就不寫，面板不會白白重畫。回傳讀到的結果。
async function loadMerge($: EngineInterface, path: string): Promise<MergeView> {
  const [text, listed, m] = await Promise.all([
    $.fs.read(inRepo(path)).catch(() => null),
    listStages($, path).catch(() => null),
    readMerge($),
  ])
  const parsed = text === null ? null : parseConflicts(text)
  let next: MergeView = { ...EMPTY_MERGE, path }
  if (parsed !== null) {
    const { chunks } = await readStages($, path, listed?.key ?? null)
    next = {
      ...next,
      ...parsed,
      hasMarkers: true,
      chunks: keepChoices(m.path === path ? m.chunks : [], chunks ?? parsed.chunks),
    }
  }
  await update($, cover, c => showCover(c, 'merge', next))

  return next
}

// 上一次跳到的衝突（chunks 的位置）；換了檔案就從頭算。
let conflictCursor = { path: '', at: -1 }

// 跳到下一段（step 1）或上一段（-1）衝突：焦點放在 ours 的 Accept 上，捲到那一列的頂端。
// 已經在最後一段（往前是第一段）再按：換到下一個（上一個）衝突檔案的第一段（最後一段）；
// 已經是最後一個（第一個）檔案就不動，不繞回去，焦點也留在原地。
// 換檔不走 openMerge：不用先捲回最上面（馬上就捲到那段）。
// 先移焦點再捲：換了檔案時那一列還沒畫出來，focus 會等它畫好，scroll 不會。
// 捲不動、焦點移不過去（面板沒拿著鍵盤）都不算錯，下次按再試。
async function jumpConflict($: EngineInterface, step: 1 | -1) {
  let m = await readMerge($)
  let at = nextConflict(m.chunks, conflictCursor.path === m.path ? conflictCursor.at : -1, step)
  if (at === null) {
    if (isMergeBusy) return
    const conflicted = (await read($, view)).files.filter(isConflict)
    const other = neighbour(conflicted, f => f.path === m.path, step)
    if (other === undefined) return
    m = await loadMerge($, other.path)
    at = nextConflict(m.chunks, -1, step)
    // 那個檔案沒有可以一段一段選的衝突：停在它的最上面。
    if (at === null) return scrollTop($)
  }
  conflictCursor = { path: m.path, at }
  await ringOn($, `merge:ours:${at}`)
  await $.ui.scroll({ in: PANE, to: { key: `conflict:${at}` }, block: 'start' }).catch(() => undefined)
}

// 點衝突的檔案：在 Soap Panel 裡蓋掉分頁，畫三欄合併，從最上面開始看。
async function openMerge($: EngineInterface, path: string) {
  await loadMerge($, path)
  await scrollTop($)
}

// refresh 之後：合併的檔案已經不是衝突了（解掉了、abort 了）就回到分頁，否則重讀一次（檔案可能被改過）。
async function syncMerge($: EngineInterface, files: GitFile[]) {
  if (isMergeBusy) return
  const m = await readMerge($)
  if (m.path === '') return
  const file = files.find(f => f.path === m.path)
  // 合併畫面整塊不見時，焦點圈由 checkCover 移到分頁圖示。
  if (file === undefined || !isConflict(file)) await closeCover($)
  else await loadMerge($, m.path)
}

// 正在套用合併或用某一邊解掉。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後一直卡著；
// 卡著的話不能再解檔案、也不能換 repo。離開合併時歸零。
let isMergeBusy = false

function setMergeBusy($: EngineInterface, isBusy: boolean) {
  if (isMergeBusy === isBusy) return
  isMergeBusy = isBusy
  $.ui.invalidate('ui.render')
}

// 解掉合併畫面上的檔案：做事的期間顯示處理中；失敗把錯誤留在畫面上，
// 成功就回到分頁、重讀狀態。
async function resolveFile($: EngineInterface, what: string, work: (path: string) => Promise<unknown>) {
  if (isMergeBusy) return
  const m = await readMerge($)
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
  await closeCover($)
  await refresh($)
  $.ui.toast(`Resolved ${m.path}`)
}

// 把中間那欄寫回檔案並 git add（標成已解決）。每一段衝突都選好了才做。
async function applyMerge($: EngineInterface) {
  const m = await readMerge($)
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
  const [m, { op }] = await Promise.all([readMerge($), read($, view)])
  if (m.path === '') return
  if (!isPromptSafePath(m.path)) {
    await setMerge($, { error: 'Ask Claude is off for this file: its name has a backtick or a control character.' })

    return
  }
  const during = op === '' ? '' : ` (a ${op} is in progress; do not continue or abort it)`
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

// 先用 ps 列出所有程序和 port，再只對用得到的程序讀工作目錄、執行檔和指令。
async function scanMac($: EngineInterface) {
  const r = await runOk($, MAC_SCAN_ARGV, 'Process scan', { env: MAC_ENV })
  const all = parseMacScan(r.stdout)
  const want = wantedPids(all)
  // 有讀不到的程序（root 跑的）lsof 會回 1、剛結束的程序 ps 會回 1，照樣用讀到的。
  const [files, args] = await Promise.all([
    $.process.run(macFilesArgv(want), { env: MAC_ENV }),
    $.process.run(macArgsArgv(want), { env: MAC_ENV }),
  ])

  return withFiles(all, want, parseMacFiles(files.stdout), parseMacArgs(args.stdout))
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
  if ((await read($, tab)) !== 'services' || !(await isPaneShown($))) return
  await refreshServices($)
}

// ───── Files 分頁 ─────

// 連點兩個資料夾時，先點的讀得比較慢也不會蓋掉後點的。
const folderLoads = latestOnly()

// 列出 dir（相對 session 資料夾，'' 是它本身）。用 session.root 不用 cwd，跟 Git 分頁一樣不跟著 Bash 的 cd 跑。
// 只存畫得到的前 FILES_ROW_LIMIT 筆：每次重列比對、每次重畫都不用帶著上千筆。
async function loadFiles($: EngineInterface, dir: string) {
  const isStale = folderLoads.start()
  const root = await $.session.root()
  const listed = await $.fs.list(dir === '' ? root : `${root}/${dir}`).then(
    list => ({ entries: sortEntries(list), error: '' }),
    (err: unknown) => ({ entries: [], error: `Couldn't list ./${dir}: ${errorText(err)}` }),
  )
  if (isStale()) return
  await setFiles($, { dir, isLoaded: true, entries: listed.entries.slice(0, FILES_ROW_LIMIT), total: listed.entries.length, error: listed.error })
}

async function reloadFiles($: EngineInterface) {
  await loadFiles($, (await read($, files)).dir)
}

// 連按 Next、或讀到一半按了 Back，晚到的舊內容不寫。
const fileReads = latestOnly()

// 讀一個檔案（path 相對 session 資料夾）要畫的內容。太大的、二進位檔、資料夾的連結不畫內容，只說為什麼。
// known：畫面上已經是這個檔案時它的 stamp；修改時間和大小都沒變就不讀內容，回傳 null（回合結束重讀時常常沒變）。
async function readFileView($: EngineInterface, path: string, known: string): Promise<FileView | null> {
  try {
    const full = `${await $.session.root()}/${path}`
    const stat = await $.fs.stat(full)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (stamp === known) return null
    const shown = { ...EMPTY_FILE_VIEW, path, stamp }
    if (stat.kind !== 'file') return { ...shown, note: 'Not a file; nothing to show.' }
    if (stat.size > FILE_VIEW_MAX_BYTES) return { ...shown, note: `Too large to show (${formatSize(stat.size)}).` }
    const text = viewText(await $.fs.read(full))
    if (text === null) return { ...shown, note: 'Binary file; nothing to show.' }

    return text.text === '' ? { ...shown, note: 'Empty file.' } : { ...shown, ...text }
  } catch (err) {
    return { ...EMPTY_FILE_VIEW, path, error: `Couldn't read ${path}: ${errorText(err)}` }
  }
}

// 在 Soap Panel 裡看檔案內容（蓋掉分頁）。換了檔案才捲回最上面，回合結束重讀同一個檔案不捲；內容沒變不寫，不重畫。
async function showFile($: EngineInterface, path: string) {
  const isStale = fileReads.start()
  const prev = await readFileCover($)
  const shown = await readFileView($, path, prev.path === path ? prev.stamp : '')
  if (isStale() || shown === null) return
  await update($, cover, c => showCover(c, 'file', shown))
  if (prev.path !== path) await scrollTop($)
}

// 檔案內容的 Previous／Next：照 Files 分頁的檔案順序換成上一個／下一個。
async function stepFile($: EngineInterface, step: 1 | -1) {
  const [shown, list] = await Promise.all([readFileCover($), read($, files)])
  const next = neighbour(fileSteps(list), p => p === shown.path, step)
  if (next !== undefined) await showFile($, next)
}

// ───── Spec 分頁 ─────

// 連點兩個 feature、讀到一半按了 Back，晚到的舊清單、舊計劃不寫。
const specLoads = latestOnly()
const planReads = latestOnly()

// 列出 .soap/tasks 底下的 feature 資料夾，每個看它的 plan.yaml 改過的時間（最新的排上面）。
// 還沒有 .soap/tasks 是還沒寫過計劃，不是錯誤：列不出來時才看它在不在。
async function loadSpecs($: EngineInterface) {
  const isStale = specLoads.start()
  const root = await $.session.root()
  const dir = `${root}/${SPEC_DIR}`
  const listed = await (async () => {
    const folders = (await $.fs.list(dir)).filter(e => e.kind === 'dir')
    const specs = await Promise.all(
      folders.map(async (f): Promise<SpecEntry> => {
        const stat = await $.fs.stat(`${root}/${planPath(f.name)}`).catch(() => undefined)
        const hasPlan = stat?.kind === 'file'

        return { name: f.name, mtimeMs: hasPlan ? stat.mtimeMs : 0, hasPlan }
      }),
    )

    return { specs: sortSpecs(specs), error: '' }
  })().catch(async (err: unknown) => ({
    specs: [],
    error: (await $.fs.exists(dir).catch(() => true)) ? `Couldn't list ./${SPEC_DIR}: ${errorText(err)}` : '',
  }))
  if (isStale()) return
  await setSpec($, { isLoaded: true, ...listed })
}

// 讀一份 plan.yaml 畫出來；格式哪裡不對一起列出來。畫面上已經是它、修改時間和大小都沒變就不讀（回合結束重讀時常常沒變）。
async function openSpec($: EngineInterface, name: string) {
  const isStale = planReads.start()
  const prev = await read($, spec)
  const path = planPath(name)
  const shown = await (async () => {
    const full = `${await $.session.root()}/${path}`
    const stat = await $.fs.stat(full)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (prev.open === name && prev.stamp === stamp) return null

    return { ...readPlan(await $.fs.read(full)), stamp }
  })().catch((err: unknown) => ({ plan: EMPTY_PLAN, problems: [`Couldn't read ${path}: ${errorText(err)}`], stamp: '' }))
  if (isStale() || shown === null) return
  await setSpec($, { open: name, ...shown })
  if (prev.open !== name) await scrollTop($)
}

async function closeSpec($: EngineInterface) {
  planReads.drop()
  await setSpec($, { open: '', plan: EMPTY_PLAN, problems: [], stamp: '' })
  await loadSpecs($)
}

// Spec 分頁看得到的那個：清單，或打開的計劃（清單這時畫不到，不用重列）。
async function reloadSpec($: EngineInterface) {
  const s = await read($, spec)
  await (s.open === '' ? loadSpecs($) : openSpec($, s.open))
}

// Do：叫 Claude 照打開的那份 plan.yaml 做（像使用者自己打的一樣送出）。
// 格式不對的先不送，免得照著缺東缺西的計劃做；資料夾名稱有反引號、控制字元的也不送（會弄壞提示裡的路徑）。
async function doSpec($: EngineInterface) {
  const s = await read($, spec)
  if (s.open === '') return
  const path = planPath(s.open)
  if (s.problems.length > 0) return void $.ui.toast(`Fix ${path} first: ${s.problems[0]}`)
  if (!isPromptSafePath(path)) return void $.ui.toast('Do is off for this plan: its folder name has a backtick or a control character.')
  await $.prompt.submit({
    text: `Implement the plan in \`${path}\`. Read it first, then reach every item under goals, keep to the constraints, start from the related files, and finish by running every verify command until each one passes.`,
    asUser: true,
  })
  $.ui.toast('Sent to Claude')
}

// 刪整個 feature 資料夾（含 assets）：macOS 用 rm -rf，Windows 用 PowerShell 的 Remove-Item；路徑從環境變數給，不拼進指令。
const REMOVE_DIR_ARGV = powershellArgv("$ErrorActionPreference = 'Stop'; Remove-Item -LiteralPath $env:SOAP_DIR -Recurse -Force")

// Spec 的打勾 DELETE_ARM_MS 後收回去的計時；再按（刪掉或按了別的垃圾桶）就先停掉舊的。
let specDisarmTimer: Timer | undefined

// 刪 Spec 要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才刪掉整個 .soap/tasks/<feature>/；按別的垃圾桶，原本的就收回。
// 名稱是 fs.list 列出來的資料夾名稱；空的、. 或 ..、含斜線的不刪（會刪到 .soap/tasks 外面）。
async function deleteSpec($: EngineInterface, name: string) {
  const s = await read($, spec)
  if (s.deleteArmed !== name) {
    specDisarmTimer?.cancel()
    await setSpec($, { deleteArmed: name, deleteError: '' })
    specDisarmTimer = $.clock.after(DELETE_ARM_MS, () => void setSpec($, { deleteArmed: '' }))

    return
  }
  specDisarmTimer?.cancel()
  await setSpec($, { deleteArmed: '' })
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
    await setSpec($, { deleteError: `Couldn't delete ${name}: not a feature folder name.` })

    return
  }
  const dir = `${await $.session.root()}/${SPEC_DIR}/${name}`
  try {
    if (await isWindows($)) await runOk($, REMOVE_DIR_ARGV, 'Remove-Item', { env: { SOAP_DIR: dir } })
    else await runOk($, ['rm', '-rf', '--', dir], 'rm')
  } catch (err) {
    await setSpec($, { deleteError: `Couldn't delete ${name}: ${errorText(err)}` })
    await loadSpecs($)

    return
  }
  $.ui.toast(`Deleted ${name}`)
  await setSpec($, { deleteError: '' })
  await loadSpecs($)
}

// 回合結束：Claude 可能寫了新的計劃、改了打開的那份。Spec 分頁開著就重讀看得到的那個。
async function reloadSpecsWhenShown($: EngineInterface) {
  if ((await read($, tab)) === 'spec') await reloadSpec($)
}

// Claude 用 Write／Edit 寫了 .soap/tasks/<feature>/plan.yaml：寫完讀回整份檢查格式，
// 不對就把哪裡不對塞進工具結果後面（只有 Claude 看得到，它會自己修），也跳個 toast 讓人知道。
// Edit 只帶改的那一段，所以不在寫之前擋，寫完看整份。
async function checkPlanWrite($: EngineInterface, path: string) {
  const { problems } = readPlan(await $.fs.read(path))
  if (problems.length === 0) return undefined
  void $.ui.toast(`plan.yaml has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0]}`)

  return planFixNote(path, problems)
}

// Write／Edit 的結果 ran：寫的是 plan.yaml、寫成功了才檢查。讀不回來就不管，工具結果照原樣給 Claude。
async function checkPlan<R extends ToolCallResult>($: EngineInterface, path: string, ran: R): Promise<R> {
  if (ran.deny !== undefined || ran.isError === true || !isPlanPath(path)) return ran
  const note = await checkPlanWrite($, path).catch(() => undefined)

  return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
}

// ───── DB 分頁（SQL Server） ─────

// 正在存連線、跑查詢。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後一直停在「Running…」。
let dbBusy: DbBusy = ''

function setDbBusy($: EngineInterface, busy: DbBusy) {
  if (dbBusy === busy) return
  dbBusy = busy
  $.ui.invalidate('ui.render')
}

const SQLCMD_MISSING = 'DB needs sqlcmd. Install it: brew install sqlcmd on macOS, winget install sqlcmd on Windows.'

async function readSaved($: EngineInterface) {
  return savedConnections(await $.store.get(DB_STORE_KEY))
}

// 存進 $.store，畫面上的清單直接用存進去的那份，不用再讀一次。
async function writeSaved($: EngineInterface, saved: SavedConnection[], change: Partial<DbView> = {}) {
  await $.store.set(DB_STORE_KEY, saved)
  await setDb($, { ...change, isLoaded: true, connections: saved.map(listed) })
}

async function loadDbConnections($: EngineInterface) {
  try {
    await setDb($, { isLoaded: true, connections: (await readSaved($)).map(listed) })
  } catch (err) {
    await setDb($, { isLoaded: true, error: `Couldn't read the saved connections: ${errorText(err)}` })
  }
}

// 把密碼存起來，回傳跟連線一起存進 $.store 的 secret（見 db/sql.ts 的 SavedConnection）。
// macOS：security -i 從 stdin 存進 Keychain，它的指令失敗也回 0，所以存完再查一次在不在。
// Windows：DPAPI 加密，密文存進 $.store。
async function saveSecret($: EngineInterface, id: string, password: string) {
  if (password === '') return ''
  if (await isWindows($)) return (await runOk($, WIN_PROTECT_ARGV, 'DPAPI', { env: { SOAP_SECRET: toHex(password) } })).stdout.trim()
  await runOk($, MAC_SAVE_ARGV, 'security', { stdin: macSaveInput(id, password) })
  await runOk($, macCheckArgv(id), 'Keychain')

  return KEYCHAIN
}

async function readSecret($: EngineInterface, c: SavedConnection) {
  if (c.secret === '') return ''
  try {
    const r = c.secret === KEYCHAIN ? await runOk($, macReadArgv(c.id), 'security') : await runOk($, WIN_UNPROTECT_ARGV, 'DPAPI', { env: { SOAP_BLOB: c.secret } })

    return fromHex(r.stdout)
  } catch (err) {
    throw new Error(`Couldn't read the saved password (delete the connection and add it again): ${errorText(err)}`)
  }
}

// Windows 的密文跟著那筆一起刪掉了；Keychain 裡的要另外刪。
async function deleteSecret($: EngineInterface, c: SavedConnection) {
  if (c.secret === KEYCHAIN) await $.process.run(macDeleteArgv(c.id)).catch(() => undefined)
}

// 打開著的連線，和它的密碼（讀一次就留著：每次查詢都開 security／PowerShell 太慢）。換連線、回清單、刪掉就丟掉。
let opened: { c: SavedConnection; password: Promise<string> } | undefined

// 在打開著的連線上跑一段 SQL，回傳它印的表格。密碼只放在 sqlcmd 的環境變數 SQLCMDPASSWORD，不在命令列上。
// sqlcmd 跑不起來（沒裝）才說要裝它；連不上之類的錯誤（訊息裡也會有 not found）照 sqlcmd 說的給。
async function runSql($: EngineInterface, query: string) {
  if (opened === undefined) throw new Error('No connection is open.')
  const { c } = opened
  const password = await opened.password
  // 不用 runOk：只有跑不起來（rejected）才算沒裝，sqlcmd 自己回的錯誤不能拿去比對 not found。
  const r = await $.process
    .run(sqlcmdArgv(c, query), { env: password === '' ? {} : { SQLCMDPASSWORD: password }, timeoutMs: DB_PROCESS_TIMEOUT_MS })
    .catch((err: unknown) => {
      throw isMissingCommand(err) ? new Error(SQLCMD_MISSING) : err
    })
  if (r.exitCode !== 0) throw failure(r, 'sqlcmd')

  return parseTable(r.stdout, r.isStdoutTruncated)
}

// 貼上連線字串：拆開、密碼存進 Keychain／DPAPI，其餘存進 $.store。錯誤訊息裡不放連線字串（有密碼）。
async function addDbConnection($: EngineInterface, text: string) {
  if (dbBusy !== '' || text.trim() === '') return
  const p = parseConnectionString(text)
  if ('error' in p) return setDb($, { error: p.error })
  const { password, ...parts } = p.parsed
  setDbBusy($, 'adding')
  try {
    const id = connectionId(await $.clock.now(), Math.random())
    const saved: SavedConnection = { id, ...parts, secret: await saveSecret($, id, password) }
    await writeSaved($, [...(await readSaved($)), saved], { error: '' })
    $.ui.toast(`Saved ${connectionName(saved)}`)
  } catch (err) {
    await setDb($, { error: `Couldn't save the connection: ${errorText(err)}` })
  } finally {
    setDbBusy($, '')
  }
}

// 連線的打勾 DELETE_ARM_MS 後收回去的計時。
let dbDisarmTimer: Timer | undefined

// 刪連線要按兩次，跟 Spec 一樣；刪的時候密碼一起刪。
async function deleteDbConnection($: EngineInterface, id: string) {
  dbDisarmTimer?.cancel()
  if ((await read($, db)).deleteArmed !== id) {
    await setDb($, { deleteArmed: id, error: '' })
    dbDisarmTimer = $.clock.after(DELETE_ARM_MS, () => void setDb($, { deleteArmed: '' }))

    return
  }
  try {
    const saved = await readSaved($)
    const gone = saved.find(c => c.id === id)
    await writeSaved($, saved.filter(c => c.id !== id), { deleteArmed: '' })
    if (gone === undefined) return
    if (opened?.c.id === id) opened = undefined
    await deleteSecret($, gone)
    $.ui.toast(`Deleted ${connectionName(gone)}`)
  } catch (err) {
    await setDb($, { deleteArmed: '', error: `Couldn't delete the connection: ${errorText(err)}` })
  }
}

// 打開、展開的讀取和查詢：連點、讀到一半按了 Back，晚到的舊結果不寫。
const tableLoads = latestOnly()
const columnLoads = latestOnly()
const queryRuns = latestOnly()

// 點連線：讀它的資料表和 view。
async function openDbConnection($: EngineInterface, id: string) {
  const isStale = tableLoads.start()
  queryRuns.drop()
  setDbBusy($, '')
  const [saved] = await Promise.all([readSaved($), setDb($, { ...NO_DB_CONNECTION, open: id, deleteArmed: '' }), scrollTop($)])
  const c = saved.find(x => x.id === id)
  if (c === undefined) {
    opened = undefined

    return setDb($, { ...NO_DB_CONNECTION, error: 'That connection was deleted.' })
  }
  opened = { c, password: readSecret($, c) }
  // 沒人等的時候讀不到也不要變成未處理的錯誤；要用時 runSql 會再丟出來。
  opened.password.catch(() => undefined)
  try {
    const tables = parseTables(await runSql($, TABLES_QUERY))
    if (!isStale()) await setDb($, { tables })
  } catch (err) {
    if (!isStale()) await setDb($, { tables: [], error: errorText(err) })
  }
}

async function closeDbConnection($: EngineInterface) {
  tableLoads.drop()
  columnLoads.drop()
  queryRuns.drop()
  opened = undefined
  setDbBusy($, '')
  await setDb($, NO_DB_CONNECTION)
}

// 跑一段 SQL（按 Enter 時框裡的字，或點資料表的預覽）：只放行一段 SELECT（selectOnlyError），其他的不跑、說為什麼。
async function runDbQuery($: EngineInterface, query: string) {
  const refused = selectOnlyError(query)
  if (refused !== '') return setDb($, { query, queryError: refused })
  const isStale = queryRuns.start()
  setDbBusy($, 'query')
  await setDb($, { query, queryError: '' })
  try {
    const result = await runSql($, query)
    if (!isStale()) await setDb($, { result })
  } catch (err) {
    if (!isStale()) await setDb($, { result: null, queryError: errorText(err) })
  } finally {
    if (!isStale()) setDbBusy($, '')
  }
}

// 讀資料表的欄位；讀到時已經換了資料表就不寫。
async function loadColumns($: EngineInterface, t: DbTable) {
  const isStale = columnLoads.start()
  try {
    const columns = parseColumns(await runSql($, columnsQuery(t)))
    if (!isStale()) await setDb($, { columns })
  } catch (err) {
    if (!isStale()) await setDb($, { error: errorText(err) })
  }
}

// 點資料表：展開它的欄位、預覽前幾列；再點一次收起來。
async function toggleDbTable($: EngineInterface, t: DbTable) {
  const key = tableKey(t)
  if ((await read($, db)).table === key) {
    columnLoads.drop()

    return setDb($, { table: '', columns: [] })
  }
  await setDb($, { table: key, columns: [] })
  await Promise.all([loadColumns($, t), runDbQuery($, previewQuery(t))])
}

// ───── 蓋住分頁的畫面 ─────

// 關掉差異、合併、檔案內容，回到分頁：合併選到一半的結果放掉（檔案沒動過，下次打開從頭選），
// 讀到一半的檔案內容晚到也不寫。沒開著就不寫，免得白白重畫。
async function closeCover($: EngineInterface) {
  stageCache = undefined
  fileReads.drop()
  setMergeBusy($, false)
  await update($, cover, c => (c.kind === 'none' ? c : NO_COVER))
}

// 回合結束：Claude 可能改了檔案。Files 分頁開著就重列，開著檔案內容就重讀。
async function reloadFilesWhenShown($: EngineInterface) {
  const [t, shown] = await Promise.all([read($, tab), readFileCover($)])
  if (t !== 'files') return
  await Promise.all([reloadFiles($), shown.path === '' ? undefined : showFile($, shown.path)])
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
  if (id === 'files') void reloadFiles($).catch(() => undefined)
  if (id === 'spec') void reloadSpec($).catch(() => undefined)
  if (id === 'db') void loadDbConnections($).catch(() => undefined)
  if (showsGit(id)) refreshIfStale($)
}

// 換子分頁。log 不在看的時候不讀，換過來才讀。
async function selectSubTab($: EngineInterface, id: GitSubTab) {
  await Promise.all([update($, subTab, () => id), leaveTab($)])
  if (id === 'log') await loadLog($)
}

// branch 分頁的 log 按鈕：換到 log 分頁看那個分支，從最近的 LOG_PAGE 筆開始。
// 按目前分支那列就是回到「跟著目前分支」，之後切分支 log 也跟著換。
async function viewLog($: EngineInterface, b: GitBranch) {
  logLoads.drop()
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
    stepDiffFile: step => stepDiffFile($, step),
    closeCover: () => closeCover($),
    abortOp: () => abortOp($),
    cancelAbort: () => setView($, { isAbortArmed: false }),
    continueOp: () => continueOp($),
    // 不等它做完：停掉、重跑要好幾秒，按鈕先換成「Stopping…」。
    runServiceAction: (s, action) => void runServiceAction($, s, action),
    openDir: dir => loadFiles($, dir),
    openFile: path => showFile($, path),
    stepFile: step => stepFile($, step),
    openSpec: name => openSpec($, name),
    closeSpec: () => closeSpec($),
    doSpec: () => doSpec($),
    deleteSpec: name => deleteSpec($, name),
    addDbConnection: text => addDbConnection($, text),
    deleteDbConnection: id => deleteDbConnection($, id),
    openDbConnection: id => openDbConnection($, id),
    closeDbConnection: () => closeDbConnection($),
    toggleDbTable: t => toggleDbTable($, t),
    setDbQuery: text => setDb($, { query: text, queryError: '' }),
    runDbQuery: text => runDbQuery($, text),
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
    // 先開面板（畫「讀取中…」），git 在背景讀，不擋住 session 開始。
    void $.ui.open(PANE_ARGS)
    // 舊版另開的差異、合併面板（現在都畫在 Soap Panel 裡），熱重載後還開著就關掉。
    void $.ui.close({ id: 'soap-diff' }).catch(() => undefined)
    void $.ui.close({ id: 'soap-merge' }).catch(() => undefined)
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

  // /soap-mods:open 是 skills/open 這個檔案寫的指令（desktop app 還沒開始對話就列得出來），
  // 這裡接下來直接開面板，不交給 Claude。引擎可能不帶外掛名稱前綴，兩個名字都接。
  for (const command of ['soap-mods:open', 'open']) {
    on('command.run', { command }, async $ => {
      await refresh($)
      await $.ui.open(PANE_ARGS)

      return { text: 'Soap Panel opened.' }
    })
  }

  // 每個回合結束後，檔案可能已經變了，看得到的就順手更新。不等它讀完，免得擋住回合結束；讀不到就維持舊畫面。
  on('turn.complete', ($, e, next) => {
    void refreshWhenShown($).catch(() => undefined)
    void reloadFilesWhenShown($).catch(() => undefined)
    void reloadSpecsWhenShown($).catch(() => undefined)

    return next(e)
  })

  // plan.yaml 寫完檢查格式（checkPlan）。
  on('tool.call', { tool: 'Write' }, async ($, e, next) => checkPlan($, e.file_path, await next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => checkPlan($, e.file_path, await next(e))).catch(($, e, next) => next(e))

  // 畫面：這裡讀狀態，交給 ui/ 的純函式畫。
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [activeTab, activeSub, v, isRemoteOpen, bf, bq, fl, sv, fileList, specs, dbView, lg, lq, shown, usage, now] = await Promise.all([
      read($, tab),
      read($, subTab),
      read($, view),
      read($, showRemote),
      read($, branchFolders),
      read($, branchQuery),
      read($, fileLimit),
      read($, services),
      read($, files),
      read($, spec),
      read($, db),
      read($, log),
      read($, logQuery),
      read($, cover),
      // 讀不到用量就當作還沒有讀數，不要讓整個面板畫不出來。
      $.session.usage().catch(() => undefined),
      $.clock.now(),
    ])

    const tree = renderPanel(
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
        files: fileList,
        spec: specs,
        db: dbView,
        dbBusy,
        servicePending,
        log: lg,
        logQuery: lq,
        cover: shown,
        isMergeBusy,
        usage: usage?.rateLimits ?? [],
        now,
      },
      actionsFor($, e.surface),
      (fn, ringKey) => act($, fn, ringKey),
    )
    checkPressed($, tree, now, activeTab, activeSub)
    checkCover($, shown.kind, now, activeTab, activeSub)

    return tree
  })
}
