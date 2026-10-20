// 進入點：狀態（atom）、所有碰到 $ 的動作，和引擎事件的接線。
// 引擎只讓這個檔案碰 $ 和 atom（傳 $ 給 import 進來的函式、用別的檔案的 atom 都會被擋），
// 其餘都是 import 進來的純函式。

import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  FsEntry,
  ModelForkResult,
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
  SubTabs,
  SpecView,
  TabId,
  WikiModel,
  WikiView,
} from '../types'
import {
  COPIED_MS,
  DB_PROCESS_TIMEOUT_MS,
  DB_STORE_KEY,
  DELETE_ARM_MS,
  FILES_ROW_LIMIT,
  FILES_WALK_BATCH,
  FILES_WALK_LIMIT,
  FILES_WALK_SKIP,
  FILE_VIEW_MAX_BYTES,
  FOCUS_WATCH_MS,
  GIT_REFRESH_MS,
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
  WIKI_DIR,
  WIKI_DISTILL_MAX_BYTES,
  WIKI_DISTILL_MAX_TOKENS,
  WIKI_DISTILL_TIMEOUT_MS,
  WIKI_MODEL_KEY,
  WIKI_PAGE_LIMIT,
  WIKI_TRANSCRIPT_MAX_CHARS,
  hasSubTabs,
} from './config'
import { NO_COVER, coverData, patchCover, showCover } from './cover'
import {
  EMPTY,
  EMPTY_DB,
  EMPTY_DIFF,
  EMPTY_FILE_VIEW,
  EMPTY_FILES,
  EMPTY_LOG,
  EMPTY_MERGE,
  EMPTY_PLAN,
  EMPTY_SERVICES,
  EMPTY_SPEC,
  EMPTY_WIKI,
  NO_COMMIT,
  NO_DB_CONNECTION,
  NO_FILE_MENU,
  NO_ARMED,
  NO_MESSAGES,
  NO_WIKI_OPEN,
  NO_WIKI_SENT,
} from './defaults'
import { absPath, byName, childPath, fileSteps, formatSize, matchPaths, sortEntries, viewText } from './files/list'
import { errorText, failure, isMissingCommand } from './errors'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  branchId,
  branchRef,
  commitRange,
  diffSteps,
  fileKind,
  filterCommits,
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
import { buildResult, detectOp, isResolved, keepChoices, merge3, nextConflict, parseConflicts, splitLines, unifiedDiff } from './merge/algo'
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
  parseColumns,
  parseConnectionString,
  parseTable,
  parseTables,
  previewQuery,
  savedConnections,
  selectOnlyError,
  withoutSecret,
  sqlcmdArgv,
  tableKey,
} from './db/sql'
import { MAC_SAVE_ARGV, WIN_PROTECT_ARGV, WIN_UNPROTECT_ARGV, fromHex, macCheckArgv, macDeleteArgv, macReadArgv, macSaveInput, toHex } from './db/secret'
import { isPlanPath, planFixNote, planPath, readPlan, sortSpecs } from './spec/parse'
import type { Actions, DbBusy } from './ui/actions'
import { buttonKeys, neighbourKey, ringAnchor, tabIconKey } from './ui/keys'
import { renderPanel } from './ui/panel'
import { coalesce, latestOnly } from './latest'
import { neighbour } from './neighbour'
import { patch } from './patch'
import { hasQuery } from './search'
import { cutAtLineEnd } from './text'
import {
  type PageText,
  type ParsedDraft,
  DRAFTS_PATH,
  checkedKey,
  checkedList,
  draftPages,
  distillPrompt,
  draftFixNote,
  draftText,
  isDraftPath,
  draftIdOf,
  isPagePath,
  pagesContext,
  parseDistill,
  parseDraft,
  pickPages,
  toggled,
  transcriptText,
  wikiModelLabel,
  wikiModelOf,
  wikiDraft,
  wikiPath,
} from './wiki/parse'

// ───── 面板 id（引擎要在這個檔案裡直接看到值，不能 import）─────

// 只有這一個面板：差異和解衝突都畫在它裡面（另開面板的話，焦點轉不過去，快捷鍵按不到）。
const PANE = 'soap-panel'
const PANE_ARGS: PaneOpenArgs = { id: PANE, title: PANEL_TITLE }

// ───── 狀態 ─────

const tab = atom({ plugin: 'soap-mods', key: 'tab' } as const, 'files')
// 有子分頁的 Tab 各自看的子分頁。
const subTabs = atom({ plugin: 'soap-mods', key: 'subTabs' } as const, { git: 'diff', spec: 'spec' })
// shape：GitView、FilesView 改了樣子就換，熱重載後不沿用舊程式存的、缺欄位的值（同 wiki）。
const view = atom({ plugin: 'soap-mods', key: 'view' } as const, EMPTY, { shape: 'git-2' })
const showRemote = atom({ plugin: 'soap-mods', key: 'showRemote' } as const, false)
// branch 分頁資料夾的開合，key 是「l:路徑」或「r:路徑」；沒有的照預設。
const branchFolders = atom({ plugin: 'soap-mods', key: 'branchFolders' } as const, {})
// branch 分頁搜尋框裡的字，換分頁就清掉。
const branchQuery = atom({ plugin: 'soap-mods', key: 'branchQuery' } as const, '')
// log 分頁搜尋框裡的字，一樣換分頁就清掉。
const logQuery = atom({ plugin: 'soap-mods', key: 'logQuery' } as const, '')
// diff 分頁看的是第幾頁（從 0 開始）。
const filePage = atom({ plugin: 'soap-mods', key: 'filePage' } as const, 0)
const services = atom({ plugin: 'soap-mods', key: 'services' } as const, EMPTY_SERVICES)
const files = atom({ plugin: 'soap-mods', key: 'files' } as const, EMPTY_FILES, { shape: 'files-2' })
// Spec 分頁：.soap/tasks 底下的 feature 清單，和點開的那份 plan.yaml。
const spec = atom({ plugin: 'soap-mods', key: 'spec' } as const, EMPTY_SPEC)

const shownSub = (t: TabId, subs: SubTabs) => (hasSubTabs(t) ? subs[t] : undefined)
// Wiki 子分頁：.soap/wiki 的頁面、勾了哪幾頁、Distill 的草稿，和打開的那頁或那份草稿。
// shape：WikiView 改了樣子（加欄位、改說明文字）就換；熱重載後整個 Wiki 狀態（勾選以外的畫面狀態、打開的頁面）從頭來，不沿用舊程式留下的值。
const wiki = atom({ plugin: 'soap-mods', key: 'wiki' } as const, EMPTY_WIKI, { shape: 'wiki-2' })
// 這段對話已經帶給 Claude 的頁面：每頁一段對話只送一次。
const wikiSent = atom({ plugin: 'soap-mods', key: 'wikiSent' } as const, NO_WIKI_SENT)
// Wiki 子分頁資料夾的開合，key 是資料夾路徑（含結尾的 /）；沒有的是打開。
const wikiFolders = atom({ plugin: 'soap-mods', key: 'wikiFolders' } as const, {})
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

// 換資料夾、改搜尋字時 ⋯ 選單收起來；回合結束重列同一個資料夾、重找同樣的字不收。
async function setFiles($: EngineInterface, change: Partial<FilesView>) {
  await update($, files, f => {
    const isMoved = (change.dir !== undefined && change.dir !== f.dir) || (change.query !== undefined && change.query !== f.query)

    return patch(f, isMoved ? { ...NO_FILE_MENU, ...change } : change)
  })
}

async function setSpec($: EngineInterface, change: Partial<SpecView>) {
  await update($, spec, s => patch(s, change))
}

async function setWiki($: EngineInterface, change: Partial<WikiView>) {
  await update($, wiki, w => patch(w, change))
}

async function setDb($: EngineInterface, change: Partial<DbView>) {
  await update($, db, v => patch(v, change))
}

// 待確認的按鈕（打勾、紅字）DELETE_ARM_MS 後收回（disarm）。一種一個 slot：再計時、或做了、按了別的就先停掉舊的。
type ArmSlot = { timer?: Timer }

function disarmLater($: EngineInterface, slot: ArmSlot, disarm: () => unknown) {
  slot.timer?.cancel()
  slot.timer = $.clock.after(DELETE_ARM_MS, () => void disarm())
}

// 要按兩次的按鈕：還沒待確認就 arm、回 false（DELETE_ARM_MS 後 disarm）；已經待確認就停掉計時、回 true（該做了）。
async function isConfirmed($: EngineInterface, slot: ArmSlot, isArmed: boolean, arm: () => Promise<unknown>, disarm: () => unknown) {
  slot.timer?.cancel()
  if (isArmed) return true
  disarmLater($, slot, disarm)
  await arm()

  return false
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

async function findPane($: EngineInterface) {
  return (await $.ui.panes()).find(p => p.id === PANE)
}

async function isPaneShown($: EngineInterface) {
  return (await findPane($))?.isShown === true
}

// session 開始時還沒有畫面接上（desktop 剛開 session、-p、SDK）就先不開面板（這時開，引擎會跳 no-surface 警告），
// 等 session.attach 再開。
let isOpenPending = false

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

// 上一次畫的樹：leaveRow 從這裡找按的那顆的下一列。
let drawnTree: RenderChildren

// 每次畫完：剛按的那顆不在畫面上了，就把焦點圈移到 ringAnchor（換上來的那顆、Back、分頁圖示）。
// 還沒有落點可移（套用中，Back 藏起來了）就等下一次畫。畫的 hook 裡不能等自己畫出來的東西，所以等畫完再移。
function checkPressed($: EngineInterface, tree: RenderChildren, now: number, t: string, sub: string | undefined) {
  drawnTree = tree
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

// 按的那顆跟著那列要被刪掉了（diff 分頁的檔案、分支、Spec、Wiki、DB 連線、Files 選單）：刪之前先把焦點圈移到下一列同一種按鈕（沒有就上一列、再沒有就分頁圖示）。
// rowKey：用那列的這顆找鄰居（Files 是在選單裡按 Delete，鄰居是下一列的 ⋯）；沒給就用按的那顆。
// 等它不見才移就晚了：桌面版的焦點已經掉出 Soap Panel，下一次點只會拿回焦點、按不到東西。
async function leaveRow($: EngineInterface, rowKey?: string) {
  const p = pressed
  const key = p?.key
  if (p === undefined || key === undefined) return
  p.key = undefined
  const from = rowKey ?? key
  const before = [...buttonKeys(drawnTree)]
  const left = new Set(before.filter(k => k !== key && k !== from))
  const [t, subs] = await Promise.all([read($, tab), read($, subTabs)])
  const to = neighbourKey(before, from, left) ?? ringAnchor(left, t, shownSub(t, subs))
  if (to !== undefined) await ringOn($, to)
}

// 上一次畫的蓋版畫面。沒按按鈕它自己不見了（回合結束發現衝突解掉了、差異的檔案沒有變更了），
// checkPressed 管不到：畫面整塊換回分頁，焦點圈移到分頁圖示。
let drawnCover: Cover['kind'] = 'none'

function checkCover($: EngineInterface, kind: Cover['kind'], now: number, t: string, sub: string | undefined) {
  const wasCovered = drawnCover !== 'none'
  drawnCover = kind
  const isPressing = pressed !== undefined && now < pressed.until
  if (wasCovered && kind === 'none' && !isPressing) $.clock.after(0, () => void ringOn($, tabIconKey(t, sub)))
}

async function focusWhenShown($: EngineInterface) {
  if (isWatching) return
  isWatching = true
  try {
    const pane = await findPane($)
    const isShown = pane?.isShown === true
    if (isShown && pane?.isFocused === false) {
      const isJustPressed = refocusUntil !== undefined && (await $.clock.now()) < refocusUntil
      if (wasShown === false || isJustPressed) {
        await focusPanel($)
        refocusUntil = undefined
      }
    }
    if (isShown && wasShown === false) void refreshWhenShown($).catch(() => undefined)
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

// 重找 repo：選中的那個還在就留著，不在了（或還沒選過）就換成第一個。
async function reloadRepos($: EngineInterface) {
  repos.list = await findRepos($)
  repos.current = repos.list.find(c => c.root === repos.current?.root) ?? repos.list[0]
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

// 讀到一半又被叫（回合結束、按了按鈕、換了 repo）就讀完再補讀一次；有補讀排著時，這次讀到的可能是舊的，就不寫，交給補讀。
const gitReads = coalesce()

function refresh($: EngineInterface): Promise<void> {
  return gitReads.run(() => readGit($))
}

// 畫得到 git 的分頁要讀的：Git 讀完整的狀態；Services 只照 repo 分組，只重找 repo，不讀狀態、分支、其他 repo 的摘要。
// 新分頁預設不讀 git。
function refreshTab($: EngineInterface, t: TabId): Promise<void> | undefined {
  if (t === 'git') return refresh($)
  if (t === 'services') return gitReads.run(() => readRepoList($))

  return undefined
}

// 回合結束、每 GIT_REFRESH_MS、Soap Panel 被切到前面時呼叫；Soap Panel 不在前面就不讀。
async function refreshWhenShown($: EngineInterface) {
  const t = await read($, tab)
  if ((t === 'git' || t === 'services') && (await isPaneShown($))) await refreshTab($, t)
}

// 重找 repo，那排 repo 已經讀過的摘要留著，新的當作沒有變更（換到 Git 分頁時整個重讀）。
async function readRepoList($: EngineInterface) {
  await reloadRepos($)
  const shown = (await read($, view)).repos
  await setView($, { repos: repos.list.map(r => shown.find(s => s.root === r.root) ?? toSummary(r, [])) })
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
  const isStale = gitReads.isWanted
  let snap
  try {
    await reloadRepos($)
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
  await Promise.all([syncMerge($, changes), (await read($, subTabs)).git === 'log' ? loadLog($) : undefined])
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

// ───── 差異（畫在 Soap Panel 裡） ─────

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv']

// 跑一次 diff，只留 hunk（w.diff 畫的）；讀不到就帶著錯誤訊息。
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

// 在 Soap Panel 裡看這個檔案的差異（蓋掉分頁），捲回最上面從頭看。按的那列不見了，焦點圈由 checkPressed 移到 Back。
async function showDiff($: EngineInterface, pane: DiffPaneView) {
  await update($, cover, c => showCover(c, 'diff', pane))
  await scrollTop($)
}

// diff 分頁的垃圾桶和 rollback 都要按兩次：按了換成打勾，DELETE_ARM_MS 內再按同一顆才做（Staged、Unstaged 都列著的兩列一起打勾，做的事一樣）。
// delete 只刪工作區的檔案，index 不動：有追蹤的之後列成刪除。未追蹤的巢狀 repo 列成「sub/」，canDelete 不給刪。
// rollback 只把 index 和工作區都還原成 HEAD 的樣子，不刪 HEAD 沒有的檔案。不經過資源回收筒，也沒有 undo。
async function changeFile($: EngineInterface, file: GitFile, action: 'delete' | 'rollback') {
  const armed = `${action}:${file.path}`
  if (!(await isGitConfirmed($, (await read($, view)).fileArmed === armed, { fileArmed: armed }))) return
  try {
    if (action === 'delete') await removePath($, inRepo(file.path))
    else await gitOk($, ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path])
  } catch (err) {
    await setView($, { ...NO_MESSAGES, fileError: `Couldn't ${action === 'delete' ? 'delete' : 'roll back'} ${file.path}: ${gitErrorText(err)}` })

    return
  }

  // 不跳 toast：那顆按鈕不見就是做完了。
  await leaveRow($)
  await setView($, NO_MESSAGES)
  await refresh($)
}

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

async function openCommitDiff($: EngineInterface, commits: GitCommit[], f: CommitFile, files: CommitFile[]) {
  await showDiff($, await readCommitDiff($, commits, f, files))
}

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
  const id = branchId({ name, isRemote })
  if (!(await isGitConfirmed($, (await read($, view)).switchArmed === id, { switchArmed: id }))) return
  await setView($, { switchArmed: '' })
  try {
    await gitOk($, isRemote ? ['switch', '--track', name] : ['switch', name])
  } catch (err) {
    await setView($, { branchError: gitErrorText(err) })

    return
  }

  // 不跳 toast：目前分支的 ● 本來就會移過去。丟掉的焦點交給 focusWhenShown 補。
  await setView($, NO_MESSAGES)
  await refresh($)
}

// 待確認的刪除、捨棄（打勾）、切換（再按一次）一次只有一個。
const gitArm: ArmSlot = {}

const armGit = ($: EngineInterface, armed: Partial<GitView>) =>
  setView($, { ...NO_MESSAGES, ...armed })

const isGitConfirmed = ($: EngineInterface, isArmed: boolean, armed: Partial<GitView>) =>
  isConfirmed($, gitArm, isArmed, () => armGit($, armed), () => setView($, NO_ARMED))

// 遠端分支（my/fork/feature/x）屬於哪個遠端：名稱最長的那個前綴，遠端名稱裡也可以有「/」。
async function remoteOf($: EngineInterface, name: string) {
  const remotes = (await gitOk($, ['remote'])).stdout.split('\n').map(r => r.trim())
  const remote = remotes.filter(r => r !== '' && name.startsWith(`${r}/`)).sort((a, b) => b.length - a.length)[0]
  if (remote === undefined) throw new Error(`No remote holds ${name}`)

  return { remote, branch: name.slice(remote.length + 1) }
}

// 刪分支要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才真的刪；按別的垃圾桶，原本的就收回。
// 本地用 -d，有沒合併的 commit 時 git 不肯刪，換成強制刪除的打勾（-D），讓人決定要不要連那些 commit 一起丟掉。
// 遠端的推一個「:refs/heads/x」上去刪（分支名稱是遠端給的，不能讓它變成 git 的選項）；跟 Fetch 一樣不讓 git 停下來問帳密。
async function deleteBranch($: EngineInterface, name: string, isRemote: boolean) {
  const armed = (await read($, view)).deleteArmed
  const isArmed = armed !== null && branchId(armed) === branchId({ name, isRemote })
  if (!(await isGitConfirmed($, isArmed, { deleteArmed: { name, isRemote, isForce: false } }))) return
  const isForce = armed?.isForce === true
  try {
    if (isRemote) {
      const { remote, branch } = await remoteOf($, name)
      await gitOk($, ['push', remote, `:refs/heads/${branch}`], NO_PROMPT)
    } else {
      await gitOk($, ['branch', isForce ? '-D' : '-d', '--', name])
    }
  } catch (err) {
    const message = gitErrorText(err)
    if (!isRemote && !isForce && message.includes('not fully merged')) {
      disarmLater($, gitArm, () => setView($, NO_ARMED))
      await armGit($, { deleteArmed: { name, isRemote, isForce: true } })
    } else await setView($, { ...NO_MESSAGES, branchError: message })

    return
  }

  // 刪除都不跳 toast：那列不見就是刪掉了，toast 還會把焦點搶出 Soap Panel。
  await leaveRow($)
  await setView($, NO_MESSAGES)
  await refresh($)
}

// 正在跑的 Fetch／Pull，'' 是沒有。放模組變數不放 atom：atom 熱重載後還在，跑到一半被重載中斷的話
// 會一直停在「Pulling…」；模組變數跟著重載歸零。也順便擋住連按兩下。
let syncing: GitSync | '' = ''

function setSyncing($: EngineInterface, kind: GitSync | '') {
  syncing = kind
  $.ui.invalidate('ui.render')
}

// 連遠端的 git（Fetch、Pull、刪遠端分支）：要帳密時 git 不能停下來問（沒有地方打字），GIT_TERMINAL_PROMPT=0 讓它直接失敗；
// Windows 的認證視窗照常會跳。
const NO_PROMPT: GitInit = { env: { GIT_TERMINAL_PROMPT: '0' }, timeoutMs: SYNC_TIMEOUT_MS }

// branch 分頁上方的 Fetch／Pull，按了才跑。跑的時候那顆按鈕寫「Pulling…」、再按不理，跑完重讀分支（ahead／behind 跟著更新）。
async function syncBranches($: EngineInterface, kind: GitSync) {
  if (syncing !== '') return
  setSyncing($, kind)
  gitArm.timer?.cancel()
  await setView($, NO_MESSAGES)
  try {
    const r = await gitOk($, SYNC_ARGS[kind], NO_PROMPT)
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

// 讀 ref 的 commit（page 沒給就是整條；給了是跳過 skip 筆後的 count 筆，多讀一筆看還有沒有下一頁），
// 和其中哪些還沒 push（rev-list 只列領先的 commit，跟 log 的順序對不上，不能一樣 --skip，只好從頭讀到這頁）：有 upstream 比 upstream；沒有的話比所有遠端分支，新分支從 main 分出來後加的才算。
// 遠端分支本身都在遠端上，不會有標記。
async function readLog($: EngineInterface, ref: string, upstream: string, page?: { skip: number; count: number }): Promise<LogRead> {
  const [r, ahead] = await Promise.all([
    // 結尾的 -- ：工作區剛好有叫 HEAD（或跟分支同名）的檔案時，git 才不會分不出是分支還是路徑。
    git($, ['log', ref, ...(page === undefined ? [] : [`--skip=${page.skip}`, `--max-count=${page.count + 1}`]), `--format=${LOG_FORMAT}`, '--']),
    git($, ['rev-list', ...(page === undefined ? [] : [`--max-count=${page.skip + page.count}`]), ref, '--not', upstream === '' ? '--remotes' : upstream, '--']),
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

async function readHistory($: EngineInterface, ref: string, upstream: string, isFresh: boolean) {
  const base = `${repos.current?.root ?? ''}\n${ref}\n${upstream}`
  if (!isFresh && history?.base === base) return history.load
  const tips = (await git($, ['rev-parse', ref, upstream === '' ? '--remotes' : upstream, '--'])).stdout
  if (history?.base !== base || history.tips !== tips) history = { base, tips, load: readLog($, ref, upstream) }

  return history.load
}

// 讀完時已經有更新的讀取開始了（打字、換頁、refresh），或中途換了分支、repo、分頁（logLoads.drop），
// 這次讀到的就不寫，免得蓋掉新的。
const logLoads = latestOnly()

// 讀 log 分頁第 page 頁的 commit（沒給就是目前那頁）；有搜尋時從整條分支的歷史裡挑出符合的再切頁。
// isFresh 是 false 時（打字、換頁）沿用讀過的歷史。
async function loadLog($: EngineInterface, { isFresh = true, page }: { isFresh?: boolean; page?: number } = {}) {
  const isStale = logLoads.start()
  const [v, l, query] = await Promise.all([read($, view), read($, log), read($, logQuery)])
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
      ? await readHistory($, ref, upstream, isFresh).then(h => ({ ...h, commits: filterCommits(h.commits, query) }))
      : await readLog($, ref, upstream, { skip: wanted * LOG_PAGE, count: LOG_PAGE })
    if (isStale()) return
    // 搜尋拿到的是整條：自己切，符合的變少了就夾回最後一頁（跟 diff 分頁一樣）。沒搜尋時 git 已經跳過前面幾頁。
    const index = isSearching ? Math.min(wanted, Math.max(0, Math.ceil(found.commits.length / LOG_PAGE) - 1)) : wanted
    const from = isSearching ? index * LOG_PAGE : 0
    const commits = found.commits.slice(from, from + LOG_PAGE)
    // 沒搜尋時不知道總共幾頁：歷史變短了（rebase、換分支），這頁已經沒有東西，就回到第一頁重讀。
    if (commits.length === 0 && index > 0) return await loadLog($, { isFresh: false, page: 0 })
    const ahead = new Set(found.unpushed)
    const listed = new Set(commits.map(c => c.sha))
    // 內容沒變 patch 就不寫，停在 log 分頁時回合結束不會白白重畫。
    await update($, log, cur =>
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
    if (!isStale()) await setLog($, { isLoaded: true, error: gitErrorText(err) })
  }
}

// log 搜尋框打字：從第一頁開始重新過濾；整條分支的歷史只在第一次搜的時候讀。清空就回到最近的 commit。
async function searchLog($: EngineInterface, text: string) {
  await update($, logQuery, () => text)
  await loadLog($, { isFresh: false, page: 0 })
}

// 換分頁時清掉搜尋；不在這裡重讀，回到 log 分頁時才讀。
async function clearLogQuery($: EngineInterface) {
  history = undefined
  logLoads.drop()
  await update($, logQuery, () => '')
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
  await update($, cover, c => patchCover(c, 'merge', { chunks: edit(coverData(c, 'merge')?.chunks ?? []) }))
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

// git 留著的某一個版本；那一邊沒有這個檔案、或大到讀不完（拿去比對的話，Apply 會寫回截掉的檔案）就是 null。
async function readStage($: EngineInterface, stage: 1 | 2 | 3, path: string) {
  const r = await git($, ['show', `:${stage}:${path}`]).catch(() => null)

  return r === null || r.exitCode !== 0 || r.isStdoutTruncated ? null : splitLines(r.stdout)
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
// 逾時跟 Fetch 一樣長：commit 會跑 pre-commit hook（lint、測試），預設的逾時砍掉它會留下 index.lock。
async function runOp($: EngineInterface, op: Exclude<MergeOp, ''>, args: string[], done: string, env?: Record<string, string>) {
  let opError = ''
  try {
    await gitOk($, args, { env, timeoutMs: SYNC_TIMEOUT_MS })
    $.ui.toast(`${OP_LABEL[op]} ${done}`)
  } catch (err) {
    opError = errorText(err)
  }
  await setView($, { isAbortArmed: false, opError })
  await refresh($)
}

// abort 要按兩次：第一次只把按鈕換成確認，DELETE_ARM_MS 後收回。
async function abortOp($: EngineInterface) {
  const v = await read($, view)
  if (v.op === '') return
  const arm = () => setView($, { isAbortArmed: true, opError: '' })
  if (!(await isConfirmed($, gitArm, v.isAbortArmed, arm, () => setView($, { isAbortArmed: false })))) return
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

// 掃到一半又被叫就掃完再補掃一次，畫面才不會停在舊的。
const serviceScans = coalesce()
// 上一次掃到的所有活著的 PID（重跑後的檢查用）；掃不了是 undefined。
let alivePids: Set<number> | undefined

// isQuiet：掃不了不在畫面上說（重跑後的檢查，下一個時間點再看）。
function refreshServices($: EngineInterface, isQuiet = false): Promise<void> {
  return serviceScans.run(async () => {
    try {
      const { items, alive } = await scan($)
      alivePids = alive
      await setServices($, { isLoaded: true, items, error: '' })
    } catch (err) {
      alivePids = undefined
      if (isQuiet) return
      await setServices($, {
        isLoaded: true,
        error: isMissingCommand(err) ? 'Services needs PowerShell on Windows, or ps and lsof on macOS.' : `Scan failed: ${errorText(err)}`,
      })
    }
  })
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

// 重跑後的檢查：每個時間點重掃一次（跟定時掃描共用，不會同時跑兩個），新程序已經不在了就算重跑失敗，
// 在面板上提示（沒存 log，原因要自己跑一次看）。掃不了就等下一個時間點。
function watchRestart($: EngineInterface, name: string, pid: number) {
  let isDone = false
  for (const ms of RESTART_CHECK_MS) {
    $.clock.after(ms, async () => {
      if (isDone) return
      await refreshServices($, true)
      if (alivePids === undefined || alivePids.has(pid)) return
      isDone = true
      await setServices($, { actionError: `Restart failed: ${name} exited right after starting. Run its command yourself to see why.` })
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
  const listed = await $.fs.list(absPath(root, dir)).then(
    list => ({ entries: sortEntries(list), error: '' }),
    (err: unknown) => ({ entries: [], error: `Couldn't list ./${dir}: ${errorText(err)}` }),
  )
  if (isStale()) return
  await setFiles($, { dir, isLoaded: true, entries: listed.entries.slice(0, FILES_ROW_LIMIT), total: listed.entries.length, error: listed.error })
}

async function reloadFiles($: EngineInterface) {
  await loadFiles($, (await read($, files)).dir)
}

type Walk = { paths: string[]; isCapped: boolean }
type Found = { path: string; size: number }
type WalkRule = { limit: number; skipDir: (name: string) => boolean; keep: (path: string, e: FsEntry) => boolean }

// 搜尋用的 session 資料夾底下所有檔案，第一次搜的時候才走一遍，之後打字只重新過濾；換分頁、回合結束丟掉。
let walked: Promise<Walk> | undefined
// 打字很快時，晚算完的舊搜尋不寫。
const fileSearches = latestOnly()

// 由上往下走 base 底下，一次讀 FILES_WALK_BATCH 個資料夾；skipDir 的資料夾不進去，keep 的才收，收滿 limit 個就停。
// base 本身列不出來就丟出去，底下的資料夾讀不到就略過。走完照 byName 排好。
async function walkTree($: EngineInterface, base: string, { limit, skipDir, keep }: WalkRule): Promise<{ found: Found[]; isCapped: boolean }> {
  const found: Found[] = []
  const queue = ['']
  while (queue.length > 0 && found.length < limit) {
    const batch = queue.splice(0, FILES_WALK_BATCH)
    const lists = await Promise.all(
      batch.map(async dir => ({ dir, list: dir === '' ? await $.fs.list(base) : await $.fs.list(absPath(base, dir)).catch(() => []) })),
    )
    for (const { dir, list } of lists) {
      for (const e of list) {
        const path = childPath(dir, e.name)
        if (e.kind !== 'dir') {
          if (keep(path, e)) found.push({ path, size: e.size })
        } else if (!skipDir(e.name)) queue.push(path)
      }
    }
  }

  return { found: found.slice(0, limit).sort((a, b) => byName(a.path, b.path)), isCapped: found.length > limit || queue.length > 0 }
}

// 搜尋用的：整個 session 資料夾，跳過 FILES_WALK_SKIP。之後每次打字只要依序挑出符合的，不用再排。
async function walkFiles($: EngineInterface): Promise<Walk> {
  const rule: WalkRule = { limit: FILES_WALK_LIMIT, skipDir: name => FILES_WALK_SKIP.includes(name), keep: () => true }
  const { found, isCapped } = await walkTree($, await $.session.root(), rule).catch(() => ({ found: [], isCapped: false }))

  return { paths: found.map(f => f.path), isCapped }
}

// 搜尋框有字就從整個 session 資料夾挑出符合的檔案（存前 FILES_ROW_LIMIT 筆）；沒字就回到資料夾列表。
async function findFiles($: EngineInterface, query: string) {
  const isStale = fileSearches.start()
  if (!hasQuery(query)) return setFiles($, { found: null })
  const all = await (walked ??= walkFiles($))
  if (isStale()) return
  await setFiles($, { found: { ...matchPaths(all.paths, query, FILES_ROW_LIMIT), isCapped: all.isCapped } })
}

async function searchFiles($: EngineInterface, text: string) {
  await setFiles($, { query: text })
  await findFiles($, text)
}

async function clearFilesQuery($: EngineInterface) {
  walked = undefined
  fileSearches.drop()
  await setFiles($, { ...NO_FILE_MENU, query: '', found: null })
}

// Files 選單裡 Delete 的待確認計時；開關選單就停掉。
const fileArm: ArmSlot = {}

// ⋯ 選單一次只開一列的，換列、離開分頁、開檔案都收起來（換資料夾、搜尋見 setFiles）。
async function toggleFileMenu($: EngineInterface, path: string) {
  fileArm.timer?.cancel()
  await update($, files, f => patch(f, { ...NO_FILE_MENU, menu: f.menu === path ? '' : path }))
}

// Windows：直接跑 explorer 會照引擎隱藏子程式視窗的設定，開成看不見的視窗；改由 Start-Process 用一般視窗開。
// 路徑從環境變數給，不拼進指令。
const REVEAL_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; Start-Process -FilePath explorer.exe -WindowStyle Normal -ArgumentList ('/select,\"' + $env:SOAP_PATH + '\"')",
)

// 在檔案總管裡選起它（資料夾也是在上一層選起來）；macOS 用 open -R。
async function revealFile($: EngineInterface, path: string) {
  const abs = absPath(await $.session.root(), path)
  try {
    if (await isWindows($)) await runOk($, REVEAL_ARGV, 'Explorer', { env: { SOAP_PATH: abs.replace(/\//g, '\\') } })
    else await runOk($, ['open', '-R', abs], 'open')
  } catch (err) {
    await setFiles($, { menuError: `Couldn't show ${splitPath(path).name}: ${errorText(err)}` })

    return
  }
  await setFiles($, NO_FILE_MENU)
}

// 刪檔案或整個資料夾要按兩次：Delete 按了換成紅字，DELETE_ARM_MS 內再按才刪，不經過資源回收筒。
async function deleteFile($: EngineInterface, path: string) {
  const f = await read($, files)
  const arm = () => setFiles($, { isDeleteArmed: true, menuError: '' })
  if (!(await isConfirmed($, fileArm, f.isDeleteArmed, arm, () => setFiles($, { isDeleteArmed: false })))) return
  const { name } = splitPath(path)
  try {
    await removePath($, absPath(await $.session.root(), path))
  } catch (err) {
    await setFiles($, { isDeleteArmed: false, menuError: `Couldn't delete ${name}: ${errorText(err)}` })

    return
  }
  await leaveRow($, `files:more:${path}`)
  // 搜尋用的檔案清單只濾掉刪掉的，不重走整個 session 資料夾。
  walked = walked?.then(w => ({ ...w, paths: w.paths.filter(p => p !== path && !p.startsWith(`${path}/`)) }))
  await setFiles($, NO_FILE_MENU)
  await Promise.all([reloadFiles($), findFiles($, f.query)])
}

// 連按 Next、或讀到一半按了 Back，晚到的舊內容不寫。
const fileReads = latestOnly()

// 讀一個檔案（path 相對 session 資料夾）要畫的內容。太大的、二進位檔、資料夾的連結不畫內容，只說為什麼。
// known：畫面上已經是這個檔案時它的 stamp；修改時間和大小都沒變就不讀內容，回傳 null（回合結束重讀時常常沒變）。
async function readFileView($: EngineInterface, path: string, known: string): Promise<FileView | null> {
  try {
    const full = absPath(await $.session.root(), path)
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
    const full = absPath(await $.session.root(), path)
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

// 刪檔案或整個資料夾（diff、Files、Spec、Wiki 都走這裡）：macOS 用 rm -rf，Windows 用 PowerShell 的 Remove-Item；
// 路徑從環境變數給，不拼進指令。連結（junction、symlink）只刪連結本身：Windows PowerShell 的 Remove-Item -Recurse 會進到目標裡刪。
const REMOVE_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; $i = Get-Item -LiteralPath $env:SOAP_PATH -Force; if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { $i.Delete() } else { Remove-Item -LiteralPath $env:SOAP_PATH -Recurse -Force }",
)

// 只刪 session 資料夾底下的東西：不在它底下、或路徑裡有 . 和 .. 的不刪。
// 比的時候不分大小寫、斜線方向：repo 的根目錄是 git 給的（C:/…），session 資料夾是引擎給的。
async function removePath($: EngineInterface, abs: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const root = `${norm(await $.session.root()).replace(/\/$/, '')}/`
  const rel = norm(abs)
  if (!rel.startsWith(root) || rel.slice(root.length).split('/').some(p => p === '' || p === '.' || p === '..')) {
    throw new Error('outside the session folder')
  }
  if (await isWindows($)) await runOk($, REMOVE_ARGV, 'Remove-Item', { env: { SOAP_PATH: abs } })
  else await runOk($, ['rm', '-rf', '--', abs], 'rm')
}

const specArm: ArmSlot = {}

// 刪 Spec 要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才刪掉整個 .soap/tasks/<feature>/；按別的垃圾桶，原本的就收回。
// 名稱是 fs.list 列出來的資料夾名稱，含斜線的不刪（不是一個 feature 資料夾）；空的、. 和 .. 由 removePath 擋。
async function deleteSpec($: EngineInterface, name: string) {
  const arm = () => setSpec($, { deleteArmed: name, deleteError: '' })
  if (!(await isConfirmed($, specArm, (await read($, spec)).deleteArmed === name, arm, () => setSpec($, { deleteArmed: '' })))) return
  await setSpec($, { deleteArmed: '' })
  try {
    if (/[\\/]/.test(name)) throw new Error('not a feature folder name')
    await removePath($, `${await $.session.root()}/${SPEC_DIR}/${name}`)
  } catch (err) {
    await setSpec($, { deleteError: `Couldn't delete ${name}: ${errorText(err)}` })
    await loadSpecs($)

    return
  }
  await leaveRow($)
  await setSpec($, { deleteError: '' })
  await loadSpecs($)
}

// Spec 分頁看得到的子分頁：計劃或 wiki。
async function reloadSpecTab($: EngineInterface) {
  await ((await read($, subTabs)).spec === 'wiki' ? reloadWiki($) : reloadSpec($))
}

// 回合結束：Claude 可能寫了新的計劃、wiki 頁面，改了打開的那份。Spec 分頁開著就重讀看得到的那個。
async function reloadSpecsWhenShown($: EngineInterface) {
  if ((await read($, tab)) === 'spec') await reloadSpecTab($)
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

// Claude 寫了 .soap/wiki/.drafts 底下的草稿（wiki skill 會寫）：第一行 Wiki 子分頁看不懂就告訴它怎麼改，也跳個 toast。
async function checkDraftWrite($: EngineInterface, path: string) {
  if (parseDraft(await $.fs.read(path)) !== null) return undefined
  void $.ui.toast('A wiki draft has no target:, move: or delete: first line; the Wiki tab skips it.')

  return draftFixNote(path)
}

// Write／Edit 的結果 ran：寫的是 plan.yaml 或 wiki 草稿、寫成功了才檢查。讀不回來就不管，工具結果照原樣給 Claude。
async function checkWrite<R extends ToolCallResult>($: EngineInterface, path: string, ran: R): Promise<R> {
  if (ran.deny !== undefined || ran.isError === true) return ran
  const checked = isPlanPath(path) ? checkPlanWrite($, path) : isDraftPath(path) ? checkDraftWrite($, path) : undefined
  const note = await checked?.catch(() => undefined)

  return note === undefined ? ran : { ...ran, context: [...(ran.context ?? []), note] }
}

// ───── Wiki 子分頁 ─────

// 連點兩頁、讀到一半按了 Back，晚到的舊清單、舊內容不寫。
const wikiLoads = latestOnly()
const wikiReads = latestOnly()

const pageAbs = (root: string, path: string) => `${root}/${wikiPath(path)}`
const draftAbs = (root: string, id: string) => `${root}/${DRAFTS_PATH}/${id}`

// .soap/wiki 底下的頁面和大小：子資料夾也找（. 開頭的不看，草稿在那裡），最多 WIKI_PAGE_LIMIT 頁，照路徑排。
// 最上層列不出來就丟出去（loadWiki 再看是不存在還是讀不到）。
async function listPages($: EngineInterface, root: string): Promise<Found[]> {
  const rule: WalkRule = { limit: WIKI_PAGE_LIMIT, skipDir: name => name.startsWith('.'), keep: (path, e) => e.kind === 'file' && isPagePath(path) }

  return (await walkTree($, `${root}/${WIKI_DIR}`, rule)).found
}

// 勾了哪幾頁：存在 $.store（每個 session 資料夾一個 key），專案裡不留檔案；讀不到就是一頁都沒勾。
async function readChecked($: EngineInterface, root: string): Promise<string[]> {
  return checkedList(await $.store.get(checkedKey(root)).catch(() => undefined))
}

async function writeChecked($: EngineInterface, root: string, paths: readonly string[]) {
  await (paths.length === 0 ? $.store.delete(checkedKey(root)) : $.store.set(checkedKey(root), [...paths]))
}

// 勾著的頁面被搬走就換成新路徑（to），被刪掉就拿掉（沒給 to）。存不進去不擋住刪頁面、套用草稿。
async function moveChecked($: EngineInterface, root: string, from: string, to?: string) {
  const checked = await readChecked($, root)
  if (!checked.includes(from)) return
  const next = [...new Set(checked.map(c => (c === from ? to : c)))].filter((c): c is string => c !== undefined)
  await writeChecked($, root, next).catch(() => undefined)
}

// 畫面只畫還在的頁面：已經不在的留在 store 裡，不列出來。
const shownChecked = (checked: readonly string[], pages: readonly string[]) => checked.filter(c => pages.includes(c))

// 一份草稿做什麼；第一行看不懂就丟出去。
async function readDraft($: EngineInterface, root: string, id: string): Promise<ParsedDraft> {
  const d = parseDraft(await $.fs.read(draftAbs(root, id)))
  if (d === null) throw new Error('its first line is none of target:, move: or delete:')

  return d
}

// 這幾頁的內容；不是頁面路徑的、讀不到的（刪掉了）略過。
async function readPages($: EngineInterface, root: string, paths: readonly string[]): Promise<PageText[]> {
  const read = await Promise.all(
    paths.filter(isPagePath).map(path => $.fs.read(pageAbs(root, path)).then((text): PageText => ({ path, text }), () => undefined)),
  )

  return read.filter(p => p !== undefined)
}

// Distill 和 wiki skill 寫的草稿，照檔名排（Distill 的檔名是寫的時間，舊的在上面）；第一行看不懂的不算。
async function listDrafts($: EngineInterface, root: string): Promise<{ id: string; draft: ParsedDraft }[]> {
  const list = await $.fs.list(`${root}/${DRAFTS_PATH}`).catch(() => [])
  const ids = list.filter(e => e.kind === 'file' && e.name.endsWith('.md')).map(e => e.name).sort(byName)
  const drafts = await Promise.all(
    ids.map(async id => {
      const draft = await $.fs.read(draftAbs(root, id)).then(parseDraft, () => null)

      return draft === null ? undefined : { id, draft }
    }),
  )

  return drafts.filter(d => d !== undefined)
}

// 列出頁面、勾了哪幾頁、草稿。還沒有 .soap/wiki 是還沒有頁面，不是錯誤：列不出來時才看它在不在。
async function loadWiki($: EngineInterface) {
  const isStale = wikiLoads.start()
  const root = await $.session.root()
  const listing = (async () => {
    const [found, checked, drafts] = await Promise.all([listPages($, root), readChecked($, root), listDrafts($, root)])
    const pages = found.map(f => f.path)
    const hasPage = (path: string) => pages.includes(path)

    return { pages, checked: shownChecked(checked, pages), drafts: drafts.map(d => wikiDraft(d.id, d.draft, hasPage)), error: '' }
  })().catch(async (err: unknown) => ({
    pages: [],
    checked: [],
    drafts: [],
    error: (await $.fs.exists(`${root}/${WIKI_DIR}`).catch(() => true)) ? `Couldn't list ./${WIKI_DIR}: ${errorText(err)}` : '',
  }))
  const [listed, model] = await Promise.all([listing, readWikiModel($)])
  if (isStale()) return
  await setWiki($, { isLoaded: true, model, ...listed })
}

// Summary Conversation 選的模型；讀不到是 ''（跟對話同一種）。
async function readWikiModel($: EngineInterface): Promise<WikiModel | ''> {
  return wikiModelOf(await $.store.get(WIKI_MODEL_KEY).catch(() => undefined))
}

async function selectWikiModel($: EngineInterface, model: WikiModel) {
  await setWiki($, { model, isModelOpen: false })
  await $.store.set(WIKI_MODEL_KEY, model).catch(() => undefined)
}

// 存勾選，畫面只畫還在的頁面；存不進去就說。
async function saveChecked($: EngineInterface, root: string, checked: readonly string[]) {
  try {
    await writeChecked($, root, checked)
    await setWiki($, { checked: shownChecked(checked, (await read($, wiki)).pages), error: '' })
  } catch (err) {
    await setWiki($, { error: `Couldn't save the checked pages: ${errorText(err)}` })
  }
}

// 勾選框：已經不在的頁面也留著。
async function toggleWikiPage($: EngineInterface, path: string) {
  const root = await $.session.root()
  await saveChecked($, root, toggled(await readChecked($, root), path))
}

// 把路徑（session 資料夾底下的）當 @ 引用插進聊天框的游標位置；放不進去（有對話框擋著、沒有聊天框）就跳提示。
async function mentionPath($: EngineInterface, path: string) {
  const r = await $.prompt.fill({ text: `@${path} `, mode: 'insert' })
  if (!r.isFilled) $.ui.toast(r.refusal === 'dialog' ? 'Close the dialog first.' : "Couldn't put the path in the prompt box.")
}

// Uncheck all：已經不在的頁面也一起清掉。
async function uncheckAllWikiPages($: EngineInterface) {
  await saveChecked($, await $.session.root(), [])
}

// 在分頁裡看一頁的 Markdown。換了頁才捲回最上面；回合結束重讀同一頁，內容沒變就不重畫。
async function openWikiPage($: EngineInterface, path: string) {
  const isStale = wikiReads.start()
  const shown = await $.fs.read(pageAbs(await $.session.root(), path)).then(
    text => ({ ...cutAtLineEnd(text.trim()), readError: '' }),
    (err: unknown) => ({ text: '', isTruncated: false, readError: `Couldn't read ${wikiPath(path)}: ${errorText(err)}` }),
  )
  if (isStale()) return
  const prev = await read($, wiki)
  await setWiki($, { ...NO_WIKI_OPEN, open: path, ...shown })
  if (prev.open !== path) await scrollTop($)
}

// 看一份草稿：新頁面畫它的 Markdown；改既有頁面的畫原頁面到草稿的差異；搬移、刪除畫那頁現在的內容（讀不到就說，Accept 照樣按得到）。
// 頁面在不在看當下的，不看清單上的。
async function openWikiDraft($: EngineInterface, id: string) {
  const isStale = wikiReads.start()
  const root = await $.session.root()
  const shown = await (async () => {
    const d = await readDraft($, root, id)
    if (d.kind !== 'write') {
      const from = draftPages(d).from ?? d.target

      return $.fs.read(pageAbs(root, from)).then(
        text => ({ isNew: false, ...cutAtLineEnd(text.trim()), diff: '', readError: '' }),
        (err: unknown) => ({ isNew: false, text: '', diff: '', isTruncated: false, readError: `Couldn't read ${wikiPath(from)}: ${errorText(err)}` }),
      )
    }
    const page = await $.fs.read(pageAbs(root, d.target)).catch(() => undefined)
    if (page === undefined) return { isNew: true, ...cutAtLineEnd(d.body), diff: '', readError: '' }
    const diff = unifiedDiff(page, `${d.body}\n`)

    return { isNew: false, text: d.body, diff: diff.source, isTruncated: diff.isTruncated, readError: '' }
  })().catch((err: unknown) => ({ isNew: true, text: '', diff: '', isTruncated: false, readError: `Couldn't read draft ${id}: ${errorText(err)}` }))
  if (isStale()) return
  const prev = await read($, wiki)
  const { isNew, ...view } = shown
  const drafts = prev.drafts.map(x => (x.id === id && x.kind === 'write' ? { ...x, isNew } : x))
  await setWiki($, { ...NO_WIKI_OPEN, draft: id, ...view, drafts, deleteError: '' })
  if (prev.draft !== id) await scrollTop($)
}

async function closeWiki($: EngineInterface) {
  wikiReads.drop()
  await setWiki($, NO_WIKI_OPEN)
  await loadWiki($)
}

// Wiki 子分頁看得到的那個：清單，或打開的頁面、草稿（清單這時畫不到，不用重列）。
async function reloadWiki($: EngineInterface) {
  const s = await read($, wiki)
  await (s.draft !== '' ? openWikiDraft($, s.draft) : s.open !== '' ? openWikiPage($, s.open) : loadWiki($))
}

// 照一份草稿改 wiki，改完刪掉草稿：寫整頁（新頁面或取代）；搬移是先寫到新路徑再刪舊的，新路徑已經有頁面就不蓋掉；
// 要拿掉的頁面已經不在就略過。勾著的頁面跟著搬、跟著拿掉。
async function applyDraft($: EngineInterface, root: string, id: string) {
  const d = await readDraft($, root, id)
  const { from, to } = draftPages(d)
  if (d.kind === 'write') await $.fs.write(pageAbs(root, d.target), `${d.body}\n`)
  if (d.kind === 'move') {
    const [isTaken, text] = await Promise.all([$.fs.exists(pageAbs(root, d.target)), $.fs.read(pageAbs(root, d.from))])
    if (isTaken) throw new Error(`${wikiPath(d.target)} already exists`)
    await $.fs.write(pageAbs(root, d.target), text)
  }
  if (from !== undefined && (await $.fs.exists(pageAbs(root, from)))) await removePath($, pageAbs(root, from))
  await removePath($, draftAbs(root, id))
  if (from !== undefined) await moveChecked($, root, from, to)
}

// 打開的草稿：Accept 照草稿改 wiki；Discard 只刪草稿。做完回清單。
async function settleWikiDraft($: EngineInterface, isAccept: boolean) {
  const s = await read($, wiki)
  if (s.draft === '') return
  const root = await $.session.root()
  try {
    await (isAccept ? applyDraft($, root, s.draft) : removePath($, draftAbs(root, s.draft)))
  } catch (err) {
    await setWiki($, { deleteError: `Couldn't ${isAccept ? 'accept' : 'discard'} draft ${s.draft}: ${errorText(err)}` })

    return
  }
  await setWiki($, { deleteError: '' })
  await closeWiki($)
}

const wikiArm: ArmSlot = {}

// 刪 .soap/wiki 底下的檔案要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才刪；按別的垃圾桶，原本的就收回。
// 頁面刪了也從勾選拿掉；草稿（.drafts/<id>）只刪草稿，同 Discard。
async function deleteWikiFile($: EngineInterface, path: string) {
  const arm = () => setWiki($, { deleteArmed: path, deleteError: '' })
  if (!(await isConfirmed($, wikiArm, (await read($, wiki)).deleteArmed === path, arm, () => setWiki($, { deleteArmed: '' })))) return
  await setWiki($, { deleteArmed: '' })
  const root = await $.session.root()
  const draftId = draftIdOf(path)
  try {
    if (draftId !== undefined) await removePath($, draftAbs(root, draftId))
    else {
      if (!isPagePath(path)) throw new Error('not a wiki page')
      await removePath($, pageAbs(root, path))
      await moveChecked($, root, path)
    }
  } catch (err) {
    await setWiki($, { deleteError: `Couldn't delete ${path}: ${errorText(err)}` })
    await loadWiki($)

    return
  }
  await leaveRow($)
  await setWiki($, { deleteError: '' })
  await loadWiki($)
}

// Distill 沒產生草稿的原因。還沒有回覆過（nothing-to-fork：新對話、剛 /clear）不算失敗，由呼叫的地方不說話。
function distillFailure(r: Exclude<ModelForkResult, { isAnswered: true } | { reason: 'nothing-to-fork' }>): string {
  switch (r.reason) {
    case 'api-error':
      return `Distill failed: the API answered ${r.error}${r.status === null ? '' : ` (${r.status})`}. Try again.`
    case 'empty-reply':
      return 'Distill got an empty reply. Try again.'
    case 'aborted':
      return 'Distill was cut off. Try again.'
  }
}

// 問選的模型這段對話值得留下什麼。跟對話同一種（或兩邊都不知道）就從快取接著問（模型就是對話的）；
// 其他的把對話轉成文字另外問，還沒有回覆過就跟接著問一樣回 nothing-to-fork。
async function askDistill($: EngineInterface, model: WikiModel | '', current: WikiModel | '', pages: { shown: readonly PageText[]; named: readonly string[] }): Promise<ModelForkResult> {
  if (model === '' || model === current) return $.model.fork({ prompt: distillPrompt(pages.shown, pages.named) })
  const messages = await $.session.messages()
  if (!messages.some(m => m.role === 'assistant')) return { isAnswered: false, reason: 'nothing-to-fork' }

  return $.model.complete({
    model,
    prompt: distillPrompt(pages.shown, pages.named, transcriptText(messages, WIKI_TRANSCRIPT_MAX_CHARS)),
    maxTokens: WIKI_DISTILL_MAX_TOKENS,
    timeoutMs: WIKI_DISTILL_TIMEOUT_MS,
  })
}

// 正在 Distill。跟 dbBusy 一樣放模組變數不放 atom，免得被熱重載中斷後一直停在「Summarizing…」。
let isDistilling = false

function setDistilling($: EngineInterface, isBusy: boolean) {
  isDistilling = isBusy
  $.ui.invalidate('ui.render')
}

// Distill：只有按了才跑。把這段對話和現有頁面給選的模型，請它寫出值得留下的草稿，
// 存進 .soap/wiki/.drafts 等人看；頁面一頁都不動。一次只跑一個。說明最後寫用了哪個模型。
async function distillWiki($: EngineInterface) {
  if (isDistilling) return
  setDistilling($, true)
  const current = await currentModel($)
  const model = (await read($, wiki)).model || current
  await setWiki($, { distillNote: '' })
  let note: string
  try {
    const root = await $.session.root()
    // 只讀放得下的頁面（照大小挑），其餘只給路徑。
    const picked = pickPages(await listPages($, root).catch(() => []), WIKI_DISTILL_MAX_BYTES)
    const r = await askDistill($, model, current, { shown: await readPages($, root, picked.shown), named: picked.named })
    const drafts = r.isAnswered ? parseDistill(r.text) : []
    const now = await $.clock.now()
    await Promise.all(drafts.map((d, i) => $.fs.write(draftAbs(root, `${now}-${i + 1}.md`), draftText(d.target, d.body))))
    // 有草稿就不寫說明：Drafts (N) 的標題已經寫了幾份，說明裡的數字會在 Accept／Discard 後過時。還沒有回覆過也不寫。
    if (!r.isAnswered) note = r.reason === 'nothing-to-fork' ? '' : distillFailure(r)
    else note = drafts.length === 0 ? 'Nothing new worth keeping in this conversation.' : ''
  } catch (err) {
    note = `Distill failed: ${errorText(err)}`
  }
  const name = wikiModelLabel(model)
  setDistilling($, false)
  await setWiki($, { distillNote: name === '' || note === '' ? note : `${note} (${name})` })
  await loadWiki($)
}

// 對話目前用的模型種類（/model 選的）；讀不到是 ''。
async function currentModel($: EngineInterface): Promise<WikiModel | ''> {
  return wikiModelOf(await $.session.model().catch(() => ''))
}

// Send：把勾了的頁面加進這段對話（使用者角色、不顯示成打的字），Claude 下一個回合就讀得到，不會為此多跑一個回合。
// 記下這段對話送過哪幾頁，清單上標 sent；/clear 之後是另一段對話，標記跟著不見。
async function sendWikiPages($: EngineInterface) {
  const root = await $.session.root()
  const pages = await readPages($, root, await readChecked($, root))
  if (pages.length === 0) return void $.ui.toast('Check the pages to send first.')
  const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: pagesContext(pages) }] } })
  if (r.deny !== undefined) return void $.ui.toast(`Couldn't send the pages: ${r.deny}`)
  const conversation = await $.session.id()
  const paths = pages.map(p => p.path)
  await update($, wikiSent, s => ({ conversation, pages: [...new Set([...(s.conversation === conversation ? s.pages : []), ...paths])] }))
  $.ui.toast(`Sent ${pages.length} page${pages.length === 1 ? '' : 's'} to Claude`)
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
  await setDb($, { ...change, isLoaded: true, connections: saved.map(withoutSecret) })
}

async function loadDbConnections($: EngineInterface) {
  try {
    await setDb($, { isLoaded: true, connections: (await readSaved($)).map(withoutSecret) })
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

const dbArm: ArmSlot = {}

// 刪連線要按兩次，跟 Spec 一樣；刪的時候密碼一起刪。
async function deleteDbConnection($: EngineInterface, id: string) {
  const arm = () => setDb($, { deleteArmed: id, error: '' })
  if (!(await isConfirmed($, dbArm, (await read($, db)).deleteArmed === id, arm, () => setDb($, { deleteArmed: '' })))) return
  try {
    const saved = await readSaved($)
    const gone = saved.find(c => c.id === id)
    await leaveRow($)
    await writeSaved($, saved.filter(c => c.id !== id), { deleteArmed: '' })
    if (gone === undefined) return
    if (opened?.c.id === id) opened = undefined
    await deleteSecret($, gone)
  } catch (err) {
    await setDb($, { deleteArmed: '', error: `Couldn't delete the connection: ${errorText(err)}` })
  }
}

// 打開、展開的讀取和查詢：連點、讀到一半按了 Back，晚到的舊結果不寫。
const tableLoads = latestOnly()
const columnLoads = latestOnly()
const queryRuns = latestOnly()

function dropConnection($: EngineInterface) {
  tableLoads.drop()
  columnLoads.drop()
  queryRuns.drop()
  opened = undefined
  setDbBusy($, '')
}

async function openDbConnection($: EngineInterface, id: string) {
  dropConnection($)
  const isStale = tableLoads.start()
  const [saved] = await Promise.all([readSaved($), setDb($, { ...NO_DB_CONNECTION, open: id, deleteArmed: '' }), scrollTop($)])
  const c = saved.find(x => x.id === id)
  if (c === undefined) return setDb($, { ...NO_DB_CONNECTION, error: 'That connection was deleted.' })
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
  dropConnection($)
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

async function loadColumns($: EngineInterface, t: DbTable) {
  const isStale = columnLoads.start()
  try {
    const columns = parseColumns(await runSql($, columnsQuery(t)))
    if (!isStale()) await setDb($, { columns })
  } catch (err) {
    if (!isStale()) await setDb($, { error: errorText(err) })
  }
}

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

// 回合結束：Claude 可能改了檔案。Files 分頁開著就重列（有搜尋就重新走一遍再找），開著檔案內容就重讀。
async function reloadFilesWhenShown($: EngineInterface) {
  const [t, shown, list] = await Promise.all([read($, tab), readFileCover($), read($, files)])
  if (t !== 'files') return
  walked = undefined
  await Promise.all([reloadFiles($), findFiles($, list.query), shown.path === '' ? undefined : showFile($, shown.path)])
}

// ───── 換分頁 ─────

// 換分頁（上層 Tab 或子分頁）時清掉的東西：錯誤訊息、待確認的刪除／切換／rollback／abort、branch、log 和 Files 的搜尋
// （連 Files 的 ⋯ 選單）、log 點開的 commit（回來時是整個 commit 列表）。
async function leaveTab($: EngineInterface) {
  await Promise.all([setView($, NO_MESSAGES), update($, branchQuery, () => ''), clearLogQuery($), clearFilesQuery($), setLog($, NO_COMMIT)])
}

async function selectTab($: EngineInterface, id: TabId) {
  await Promise.all([update($, tab, () => id), leaveTab($)])
  loadTab($, id)
}

// 讀這個 Tab 要的資料。掃描要一秒左右，不等它：先畫「掃描中」或舊清單。
function loadTab($: EngineInterface, id: TabId) {
  if (id === 'services') void refreshServices($).catch(() => undefined)
  if (id === 'files') void reloadFiles($).catch(() => undefined)
  if (id === 'spec') void reloadSpecTab($).catch(() => undefined)
  if (id === 'db') void loadDbConnections($).catch(() => undefined)
  void refreshTab($, id)?.catch(() => undefined)
}

// 已經為哪個 session 讀過看著的 Tab。畫的時候看到 id 換了就讀一次：剛開始的第一次畫，
// 和 /clear 之後（換了 session id、狀態回到初始值，卻不發 session.start，不讀的話 Files 會一直停在讀取中）。
let loadedSession: string | undefined

function loadTabOnce($: EngineInterface, id: TabId, session: string) {
  if (session === loadedSession) return
  loadedSession = session
  loadTab($, id)
}

// 換子分頁。Git 的 log 不在看的時候不讀，換過來才讀；Spec 的（計劃、wiki）換過去就重讀它。
async function selectSubTab<T extends keyof SubTabs>($: EngineInterface, t: T, id: SubTabs[T]) {
  await Promise.all([update($, subTabs, s => ({ ...s, [t]: id })), leaveTab($)])
  if (t === 'spec') await reloadSpecTab($)
  else if (id === 'log') await loadLog($)
}

// branch 分頁的 log 按鈕：換到 log 分頁看那個分支，從最近的 LOG_PAGE 筆開始。
// 按目前分支那列就是回到「跟著目前分支」，之後切分支 log 也跟著換。
async function viewLog($: EngineInterface, b: GitBranch) {
  logLoads.drop()
  await update($, log, () => ({ ...EMPTY_LOG, ref: b.isCurrent ? '' : branchRef(b) }))
  await selectSubTab($, 'git', 'log')
}

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

function actionsFor($: EngineInterface, surface: RenderSurface): Actions {
  return {
    selectTab: id => selectTab($, id),
    selectSubTab: (t, id) => selectSubTab($, t, id),
    selectRepo: name => selectRepo($, name),
    openDiff: path => openDiff($, path),
    openMerge: path => openMerge($, path),
    showFilePage: page => update($, filePage, () => page),
    deleteChange: file => changeFile($, file, 'delete'),
    rollbackChange: file => changeFile($, file, 'rollback'),
    searchBranches: text => update($, branchQuery, () => text),
    toggleRemote: () => update($, showRemote, open => !open),
    toggleBranchFolder: (key, isOpen) => update($, branchFolders, folders => ({ ...folders, [key]: isOpen })),
    switchBranch: (name, isRemote) => switchBranch($, name, isRemote),
    deleteBranch: (name, isRemote) => deleteBranch($, name, isRemote),
    syncBranches: kind => syncBranches($, kind),
    viewLog: b => viewLog($, b),
    copyBranchName: name => copyBranchName($, name, surface),
    searchLog: text => searchLog($, text),
    showLogPage: page => loadLog($, { isFresh: false, page }),
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
    dismissServiceError: () => setServices($, { actionError: '' }),
    openDir: dir => loadFiles($, dir),
    openFile: path => Promise.all([setFiles($, NO_FILE_MENU), showFile($, path)]),
    stepFile: step => stepFile($, step),
    searchFiles: text => searchFiles($, text),
    toggleFileMenu: path => toggleFileMenu($, path),
    revealFile: path => revealFile($, path),
    deleteFile: path => deleteFile($, path),
    openSpec: name => openSpec($, name),
    closeSpec: () => closeSpec($),
    doSpec: () => doSpec($),
    deleteSpec: name => deleteSpec($, name),
    toggleWikiPage: path => toggleWikiPage($, path),
    uncheckAllWikiPages: () => uncheckAllWikiPages($),
    mentionPath: path => mentionPath($, path),
    toggleWikiFolder: (path, isOpen) => update($, wikiFolders, folders => ({ ...folders, [path]: isOpen })),
    openWikiPage: path => openWikiPage($, path),
    closeWiki: () => closeWiki($),
    deleteWikiFile: path => deleteWikiFile($, path),
    openWikiDraft: id => openWikiDraft($, id),
    acceptWikiDraft: () => settleWikiDraft($, true),
    discardWikiDraft: () => settleWikiDraft($, false),
    // 不等它做完：Claude 要想一陣子，按鈕先換成「Summarizing…」。
    distillWiki: () => void distillWiki($).catch(() => undefined),
    sendWikiPages: () => sendWikiPages($),
    selectWikiModel: model => selectWikiModel($, model),
    toggleWikiModel: isOpen => setWiki($, { isModelOpen: isOpen }),
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
    focusInput: key => ringOn($, key),
  }
}

// ───── 事件 ─────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // 先開面板（畫「Loading…」），看著的 Tab 的資料等第一次畫時在背景讀（loadTabOnce），不擋住 session 開始。
    isOpenPending = e.surface === null
    if (!isOpenPending) void $.ui.open(PANE_ARGS)
    $.clock.every(FOCUS_WATCH_MS, () => void focusWhenShown($))
    // 用量直接跟引擎拿（不花錢），這裡只負責讓重置倒數每分鐘重畫一次。
    $.clock.every(USAGE_TICK_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(SERVICES_SCAN_MS, () => void scanWhenShown($).catch(() => undefined))
    $.clock.every(GIT_REFRESH_MS, () => void refreshWhenShown($).catch(() => undefined))

    return next(e)
  })

  // 畫面接上了（名冊已加進它），開始時沒開成的面板現在開。
  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (isOpenPending) {
      isOpenPending = false
      void $.ui.open(PANE_ARGS)
    }

    return r
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
      loadTab($, await read($, tab))
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

  on('tool.call', { tool: 'Write' }, async ($, e, next) => checkWrite($, e.file_path, await next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => checkWrite($, e.file_path, await next(e))).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [activeTab, subs, v, isRemoteOpen, bf, bq, fp, sv, fileList, specs, wikiView, wf, dbView, lg, lq, shown, sentWiki, usage, now, session] = await Promise.all([
      read($, tab),
      read($, subTabs),
      read($, view),
      read($, showRemote),
      read($, branchFolders),
      read($, branchQuery),
      read($, filePage),
      read($, services),
      read($, files),
      read($, spec),
      read($, wiki),
      read($, wikiFolders),
      read($, db),
      read($, log),
      read($, logQuery),
      read($, cover),
      read($, wikiSent),
      // 讀不到用量就當作還沒有讀數，不要讓整個面板畫不出來。
      $.session.usage().catch(() => undefined),
      $.clock.now(),
      $.session.id().catch(() => ''),
    ])

    loadTabOnce($, activeTab, session)
    const isWikiShown = activeTab === 'spec' && subs.spec === 'wiki'
    // 只有開著時才問：Files 的 ⋯ 選單（Show in Explorer 還是 Finder，問一次就記著）、Wiki 子分頁的模型選單。
    const [onWindows, current] = await Promise.all([fileList.menu !== '' && isWindows($), isWikiShown ? currentModel($) : ('' as const)])
    // 這段對話送過的頁面。
    const sent = sentWiki.conversation === session ? sentWiki.pages : []
    const sub = shownSub(activeTab, subs)
    const tree = renderPanel(
      $.ui.resolve(e),
      {
        surface: e.surface,
        bodyRows: e.props.scroll.bodyRows,
        tab: activeTab,
        subTabs: subs,
        view: v,
        showRemote: isRemoteOpen,
        branchFolders: bf,
        branchQuery: bq,
        filePage: fp,
        syncing,
        services: sv,
        files: fileList,
        isWindows: onWindows,
        spec: specs,
        wiki: wikiView,
        wikiFolders: wf,
        currentModel: current,
        wikiSent: sent,
        isDistilling,
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
    checkPressed($, tree, now, activeTab, sub)
    checkCover($, shown.kind, now, activeTab, sub)

    return tree
  })
}
