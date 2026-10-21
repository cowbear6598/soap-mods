// 進入點：狀態（atom）、把 $ 和 atom 包成各分頁的 io（baseIo、gitIo…）、按鈕接到哪個動作，和引擎事件的接線。
// 引擎只讓這個檔案碰 $ 和 atom（傳 $ 給 import 進來的函式、用別的檔案的 atom 都會被擋），
// 所以各分頁的動作在自己的檔案裡（git/、files/、spec/、wiki/、db/、services/、merge/ 的 *actions.ts），只拿 io（io.ts）。

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, Register, RenderSurface } from 'claude-code'

import type { CiView, DbView, FilesView, GitBranch, GitView, LogView, ServicesView, SubTabs, SpecView, TabId, WikiView } from '../types'
import { CI_REFRESH_MS, FOCUS_WATCH_MS, GIT_REFRESH_MS, PANEL_TITLE, SERVICES_SCAN_MS, USAGE_TICK_MS, hasSubTabs } from './config'
import {
  type CiIo,
  actOnJob,
  ciActingNow,
  ciSavingNow,
  clearCi,
  closeJob,
  closePipeline,
  closeRef,
  loadBranches,
  openJob,
  openPipeline,
  openRef,
  refreshCi,
  retryCiPipeline,
  saveCiToken,
  searchCi,
  showCiPage,
  toggleCiToken,
} from './ci/actions'
import { NO_COVER, coverData, showCover } from './cover'
import {
  type DbIo,
  addDbConnection,
  closeDbConnection,
  dbBusyNow,
  deleteDbConnection,
  loadDbConnections,
  openDbConnection,
  runDbQuery,
  toggleDbTable,
} from './db/actions'
import {
  EMPTY,
  EMPTY_CI,
  EMPTY_DB,
  EMPTY_FILE_VIEW,
  EMPTY_FILES,
  EMPTY_LOG,
  EMPTY_SERVICES,
  EMPTY_SPEC,
  EMPTY_WIKI,
  NO_COMMIT,
  NO_FILE_MENU,
  NO_MESSAGES,
  NO_WIKI_SENT,
} from './defaults'
import {
  type FilesIo,
  clearFilesQuery,
  deleteFile,
  dropFileRead,
  loadFiles,
  reloadFiles,
  reloadShownFiles,
  revealFile,
  searchFiles,
  showFile,
  stepFile,
  toggleFileMenu,
} from './files/actions'
import { copyBranchName, deleteBranch, switchBranch, syncBranches, syncingNow } from './git/branch-actions'
import { changeFile, openCommitDiff, openDiff, stepDiffFile } from './git/diff-actions'
import { clearLogQuery, dropLog, loadLog, openCommits, pickRange, searchLog } from './git/log-actions'
import { abortOp, continueOp } from './git/op-actions'
import { branchRef } from './git/parse'
import type { GitIo } from './git/run'
import { refresh, refreshRepoList, refreshTab, selectRepo } from './git/status'
import type { Io } from './io'
import { applyMerge, askClaude, editChunks, jumpConflict, mergeBusy, openMerge, resetMerge, takeSide } from './merge/actions'
import { patch } from './patch'
import { type ServicesIo, pendingServices, refreshServices, runServiceAction } from './services/actions'
import { isWindows } from './shell'
import { type SpecIo, closeSpec, deleteSpec, doSpec, openSpec, reloadSpec } from './spec/actions'
import type { Actions } from './ui/actions'
import { type FocusIo, act, checkCover, checkPressed, focusWhenShown, isPaneShown, leaveRow } from './ui/focus'
import { renderPanel } from './ui/panel'
import {
  type WikiIo,
  closeWiki,
  currentModel,
  deleteWikiFile,
  distilling,
  distillWiki,
  mentionPath,
  openWikiDraft,
  openWikiPage,
  reloadWiki,
  selectWikiModel,
  sendWikiPages,
  settleWikiDraft,
  toggleWikiPage,
  uncheckAllWikiPages,
} from './wiki/actions'
import { secretCommandReason } from './secret-guard'
import { checkWrite } from './write-check'

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
const wiki = atom({ plugin: 'soap-mods', key: 'wiki' } as const, EMPTY_WIKI, { shape: 'wiki-3' })
// 這段對話已經帶給 Claude 的頁面：每頁一段對話只送一次。
const wikiSent = atom({ plugin: 'soap-mods', key: 'wikiSent' } as const, NO_WIKI_SENT)
// Wiki 子分頁資料夾的開合，key 是資料夾路徑（含結尾的 /）；沒有的是打開。
const wikiFolders = atom({ plugin: 'soap-mods', key: 'wikiFolders' } as const, {})
const log = atom({ plugin: 'soap-mods', key: 'log' } as const, EMPTY_LOG)
// DB 分頁：存著的連線（不含密碼）、打開的那個的資料表、查詢和結果。
const db = atom({ plugin: 'soap-mods', key: 'db' } as const, EMPTY_DB)
// CI 分頁（GitLab）：分支清單、點開的分支的 pipeline、點開的 pipeline 的 job、點開的 job 的 log。shape 同 wiki。
const ci = atom({ plugin: 'soap-mods', key: 'ci' } as const, EMPTY_CI, { shape: 'ci-6' })
// 蓋住分頁的畫面：差異、三欄合併或檔案內容，一次一個（cover.ts）。
const cover = atom({ plugin: 'soap-mods', key: 'cover' } as const, NO_COVER, { shape: 'cover-2' })
// 長的差異看到第幾頁，照地方（diffpage、wikidiff）記；換一份差異（id 不同）就從頭。
const diffPages = atom({ plugin: 'soap-mods', key: 'diffPages' } as const, {})

// 改一個物件 atom 的其中幾個欄位；改的欄位內容都沒變就不寫（patch），面板不會白白重畫。
// 引擎要看得出改的是哪個 atom，所以每個 atom 一個，不能寫成通用的。
async function setView($: EngineInterface, change: Partial<GitView>) {
  await update($, view, v => patch(v, change))
}

async function setLog($: EngineInterface, change: Partial<LogView>) {
  await update($, log, l => patch(l, change))
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

async function setCi($: EngineInterface, change: Partial<CiView>) {
  await update($, ci, c => patch(c, change))
}

// ───── 面板與焦點（ui/focus.ts） ─────

// session 開始時還沒有畫面接上（desktop 剛開 session、-p、SDK）就先不開面板（這時開，引擎會跳 no-surface 警告），
// 等 session.attach 再開。
let isOpenPending = false

// 把 Soap Panel 的焦點圈移到 key 那個按鈕上；Soap Panel 沒拿著鍵盤就算了。
async function ringOn($: EngineInterface, key: string) {
  await $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// 蓋上或換掉差異、合併時，捲回 Soap Panel 最上面從頭看。
async function scrollTop($: EngineInterface) {
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
}

function focusIo($: EngineInterface): FocusIo {
  return {
    findPane: async () => (await $.ui.panes()).find(p => p.id === PANE),
    focusPanel: () => $.ui.open({ ...PANE_ARGS, focus: true }),
    ringOn: key => ringOn($, key),
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, () => void fn()),
    shownTab: async () => {
      const [t, subs] = await Promise.all([read($, tab), read($, subTabs)])

      return { t, sub: shownSub(t, subs) }
    },
    refreshWhenShown: () => refreshWhenShown($),
  }
}

// ───── 給各分頁的 io ─────

// 各分頁的動作在自己的檔案裡（files/actions.ts…）：它們不能碰 $ 和 atom，這裡把要用的包成閉包給它們（io.ts）。
function baseIo($: EngineInterface): Io {
  return {
    root: () => $.session.root(),
    list: abs => $.fs.list(abs),
    stat: abs => $.fs.stat(abs),
    readFile: abs => $.fs.read(abs),
    writeFile: (abs, text) => $.fs.write(abs, text),
    exists: abs => $.fs.exists(abs),
    run: (argv, init) => $.process.run(argv, init),
    osEnv: () => $.env.get('OS'),
    storeGet: key => $.store.get(key),
    storeSet: (key, value) => $.store.set(key, value),
    storeDelete: key => $.store.delete(key),
    now: () => $.clock.now(),
    after: (ms, fn) => $.clock.after(ms, () => void fn()),
    sleep: ms => $.clock.sleep(ms),
    toast: text => $.ui.toast(text),
    invalidate: () => $.ui.invalidate('ui.render'),
    submit: args => $.prompt.submit(args),
    scrollTop: () => scrollTop($),
    scrollTo: key => $.ui.scroll({ in: PANE, to: { key }, block: 'start' }).then(() => undefined, () => undefined),
    ringOn: key => ringOn($, key),
    leaveRow: rowKey => leaveRow(focusIo($), rowKey),
  }
}

// ───── Git 分頁 ─────

function gitIo($: EngineInterface): GitIo {
  const io: GitIo = {
    ...baseIo($),
    getView: () => read($, view),
    setView: change => setView($, change),
    getLog: () => read($, log),
    setLog: change => setLog($, change),
    updateLog: fn => update($, log, fn),
    getLogQuery: () => read($, logQuery),
    setLogQuery: text => update($, logQuery, () => text),
    getCover: () => read($, cover),
    updateCover: fn => update($, cover, fn),
    getSubTabs: () => read($, subTabs),
    copy: args => $.ui.copy(args),
    closeCover: () => closeCover($),
    refresh: () => refresh(io),
  }

  return io
}

// 回合結束、每 GIT_REFRESH_MS、Soap Panel 被切到前面時呼叫；Soap Panel 不在前面就不讀。
async function refreshWhenShown($: EngineInterface) {
  const t = await read($, tab)
  if ((t === 'git' || t === 'services') && (await isPaneShown(focusIo($)))) await refreshTab(gitIo($), t)
}

// ───── Services 分頁 ─────

function servicesIo($: EngineInterface): ServicesIo {
  return { ...baseIo($), setServices: change => setServices($, change) }
}

// Services 分頁看得到時才定時掃，看不到就不花那一秒。
async function scanWhenShown($: EngineInterface) {
  if ((await read($, tab)) !== 'services' || !(await isPaneShown(focusIo($)))) return
  await refreshServices(servicesIo($))
}

// ───── Files 分頁 ─────

function filesIo($: EngineInterface): FilesIo {
  return {
    ...baseIo($),
    getFiles: () => read($, files),
    setFiles: change => setFiles($, change),
    updateFiles: fn => update($, files, fn),
    getFileCover: () => readFileCover($),
    showFileCover: shown => update($, cover, c => showCover(c, 'file', shown)),
  }
}

// ───── Spec 分頁 ─────

function specIo($: EngineInterface): SpecIo {
  return { ...baseIo($), getSpec: () => read($, spec), setSpec: change => setSpec($, change) }
}

// Spec 分頁看得到的子分頁：計劃或 wiki。
async function reloadSpecTab($: EngineInterface) {
  await ((await read($, subTabs)).spec === 'wiki' ? reloadWiki(wikiIo($)) : reloadSpec(specIo($)))
}

// 回合結束：Claude 可能寫了新的計劃、wiki 頁面，改了打開的那份。Spec 分頁開著就重讀看得到的那個。
async function reloadSpecsWhenShown($: EngineInterface) {
  if ((await read($, tab)) === 'spec') await reloadSpecTab($)
}

// ───── Wiki 子分頁 ─────

function wikiIo($: EngineInterface): WikiIo {
  return {
    ...baseIo($),
    getWiki: () => read($, wiki),
    setWiki: change => setWiki($, change),
    updateWikiSent: fn => update($, wikiSent, fn),
    fill: input => $.prompt.fill(input),
    fork: request => $.model.fork(request),
    complete: (request, options) => $.model.complete(request, options),
    messages: () => $.session.messages(),
    sessionModel: () => $.session.model(),
    sessionId: () => $.session.id(),
    append: args => $.session.append(args),
  }
}

// ───── DB 分頁（SQL Server） ─────

function dbIo($: EngineInterface): DbIo {
  return { ...baseIo($), getDb: () => read($, db), setDb: change => setDb($, change) }
}

// ───── Git 的 CI 子分頁（GitLab） ─────

function ciIo($: EngineInterface): CiIo {
  return { ...baseIo($), getCi: () => read($, ci), setCi: change => setCi($, change), fetch: (url, init) => $.http.fetch(url, init) }
}

const isCiShown = async ($: EngineInterface) => (await read($, tab)) === 'git' && (await read($, subTabs)).git === 'ci'

// 看到 CI 子分頁：先找 repo（看的是選中的那個；Git 分頁的狀態、分支由它自己的重讀負責），再讀看得到的那層。
async function loadCi($: EngineInterface) {
  await refreshRepoList(gitIo($))
  await refreshCi(ciIo($))
}

// CI 子分頁看得到時才定時重讀；跑完了的 pipeline、job 不再問（refreshCi 的 isTimer）。
async function refreshCiWhenShown($: EngineInterface) {
  if (!(await isCiShown($)) || !(await isPaneShown(focusIo($)))) return
  await refreshCi(ciIo($), { isTimer: true })
}

// 換 repo：Git 分頁重讀；CI 不管開著沒都清掉上一個 repo 的，開著就從新 repo 的分支清單重讀。
async function selectRepoTab($: EngineInterface, name: string) {
  await Promise.all([selectRepo(gitIo($), name), clearCi(ciIo($))])
  if (await isCiShown($)) await loadBranches(ciIo($))
}

// ───── 蓋住分頁的畫面 ─────

// 關掉差異、合併、檔案內容，回到分頁：合併選到一半的結果放掉（檔案沒動過，下次打開從頭選），
// 讀到一半的檔案內容晚到也不寫。沒開著就不寫，免得白白重畫。
async function closeCover($: EngineInterface) {
  resetMerge(gitIo($))
  dropFileRead()
  await update($, cover, c => (c.kind === 'none' ? c : NO_COVER))
}

// 回合結束：Claude 可能改了檔案。Files 分頁開著就重列（有搜尋就重新走一遍再找），開著檔案內容就重讀。
async function reloadFilesWhenShown($: EngineInterface) {
  if ((await read($, tab)) === 'files') await reloadShownFiles(filesIo($))
}

// ───── 換分頁 ─────

// 換分頁（上層 Tab 或子分頁）時清掉的東西：錯誤訊息、待確認的刪除／切換／rollback／abort、branch、log 和 Files 的搜尋
// （連 Files 的 ⋯ 選單）、log 點開的 commit（回來時是整個 commit 列表）。
async function leaveTab($: EngineInterface) {
  await Promise.all([setView($, NO_MESSAGES), update($, branchQuery, () => ''), clearLogQuery(gitIo($)), clearFilesQuery(filesIo($)), setLog($, NO_COMMIT)])
}

async function selectTab($: EngineInterface, id: TabId) {
  await Promise.all([update($, tab, () => id), leaveTab($)])
  loadTab($, id)
}

// 讀這個 Tab 要的資料。掃描要一秒左右，不等它：先畫「掃描中」或舊清單。
function loadTab($: EngineInterface, id: TabId) {
  if (id === 'services') void refreshServices(servicesIo($)).catch(() => undefined)
  if (id === 'files') void reloadFiles(filesIo($)).catch(() => undefined)
  if (id === 'spec') void reloadSpecTab($).catch(() => undefined)
  if (id === 'db') void loadDbConnections(dbIo($)).catch(() => undefined)
  if (id === 'git') void isCiShown($).then(isCi => (isCi ? loadCi($) : undefined)).catch(() => undefined)
  void refreshTab(gitIo($), id)?.catch(() => undefined)
}

// 已經為哪個 session 讀過看著的 Tab。畫的時候看到 id 換了就讀一次：剛開始的第一次畫，
// 和 /clear 之後（換了 session id、狀態回到初始值，卻不發 session.start，不讀的話 Files 會一直停在讀取中）。
let loadedSession: string | undefined

function loadTabOnce($: EngineInterface, id: TabId, session: string) {
  if (session === loadedSession) return
  loadedSession = session
  loadTab($, id)
}

// 換子分頁。Git 的 log、CI 不在看的時候不讀，換過來才讀；Spec 的（計劃、wiki）換過去就重讀它。
async function selectSubTab<T extends keyof SubTabs>($: EngineInterface, t: T, id: SubTabs[T]) {
  await Promise.all([update($, subTabs, s => ({ ...s, [t]: id })), leaveTab($)])
  if (t === 'spec') await reloadSpecTab($)
  else if (id === 'log') await loadLog(gitIo($))
  else if (id === 'ci') await loadCi($)
}

// branch 分頁的 log 按鈕：換到 log 分頁看那個分支，從最近的 LOG_PAGE 筆開始。
// 按目前分支那列就是回到「跟著目前分支」，之後切分支 log 也跟著換。
async function viewLog($: EngineInterface, b: GitBranch) {
  dropLog()
  await update($, log, () => ({ ...EMPTY_LOG, ref: b.isCurrent ? '' : branchRef(b) }))
  await selectSubTab($, 'git', 'log')
}

function actionsFor($: EngineInterface, surface: RenderSurface): Actions {
  return {
    selectTab: id => selectTab($, id),
    selectSubTab: (t, id) => selectSubTab($, t, id),
    selectRepo: name => selectRepoTab($, name),
    openDiff: path => openDiff(gitIo($), path),
    openMerge: path => openMerge(gitIo($), path),
    showFilePage: page => update($, filePage, () => page),
    deleteChange: file => changeFile(gitIo($), file, 'delete'),
    rollbackChange: file => changeFile(gitIo($), file, 'rollback'),
    searchBranches: text => update($, branchQuery, () => text),
    toggleRemote: () => update($, showRemote, open => !open),
    toggleBranchFolder: (key, isOpen) => update($, branchFolders, folders => ({ ...folders, [key]: isOpen })),
    switchBranch: (name, isRemote) => switchBranch(gitIo($), name, isRemote),
    deleteBranch: (name, isRemote) => deleteBranch(gitIo($), name, isRemote),
    syncBranches: kind => syncBranches(gitIo($), kind),
    viewLog: b => viewLog($, b),
    copyBranchName: name => copyBranchName(gitIo($), name, surface),
    searchLog: text => searchLog(gitIo($), text),
    showLogPage: page => loadLog(gitIo($), { isFresh: false, page }),
    showDiffPage: async (place, id, page) => {
      await update($, diffPages, p => ({ ...p, [place]: { id, page } }))
      await scrollTop($)
    },
    openCommit: c => openCommits(gitIo($), [c]),
    toggleRangePick: () => update($, log, l => ({ ...l, isPicking: !l.isPicking, rangeStart: '' })),
    pickRange: c => pickRange(gitIo($), c),
    closeCommit: () => setLog($, NO_COMMIT),
    openCommitDiff: (commits, f, files) => openCommitDiff(gitIo($), commits, f, files),
    stepDiffFile: step => stepDiffFile(gitIo($), step),
    closeCover: () => closeCover($),
    abortOp: () => abortOp(gitIo($)),
    cancelAbort: () => setView($, { isAbortArmed: false }),
    continueOp: () => continueOp(gitIo($)),
    // 不等它做完：停掉、重跑要好幾秒，按鈕先換成「Stopping…」。
    runServiceAction: (s, action) => void runServiceAction(servicesIo($), s, action),
    dismissServiceError: () => setServices($, { actionError: '' }),
    openDir: dir => loadFiles(filesIo($), dir),
    openFile: path => Promise.all([setFiles($, NO_FILE_MENU), showFile(filesIo($), path)]),
    stepFile: step => stepFile(filesIo($), step),
    searchFiles: text => searchFiles(filesIo($), text),
    toggleFileMenu: path => toggleFileMenu(filesIo($), path),
    revealFile: path => revealFile(filesIo($), path),
    deleteFile: path => deleteFile(filesIo($), path),
    openSpec: name => openSpec(specIo($), name),
    closeSpec: () => closeSpec(specIo($)),
    doSpec: () => doSpec(specIo($)),
    deleteSpec: name => deleteSpec(specIo($), name),
    toggleWikiPage: path => toggleWikiPage(wikiIo($), path),
    uncheckAllWikiPages: () => uncheckAllWikiPages(wikiIo($)),
    mentionPath: path => mentionPath(wikiIo($), path),
    toggleWikiFolder: (path, isOpen) => update($, wikiFolders, folders => ({ ...folders, [path]: isOpen })),
    openWikiPage: path => openWikiPage(wikiIo($), path),
    closeWiki: () => closeWiki(wikiIo($)),
    deleteWikiFile: path => deleteWikiFile(wikiIo($), path),
    openWikiDraft: id => openWikiDraft(wikiIo($), id),
    acceptWikiDraft: () => settleWikiDraft(wikiIo($), true),
    discardWikiDraft: () => settleWikiDraft(wikiIo($), false),
    // 不等它做完：Claude 要想一陣子，按鈕先換成「Summarizing…」。
    distillWiki: () => void distillWiki(wikiIo($)).catch(() => undefined),
    sendWikiPages: () => sendWikiPages(wikiIo($)),
    selectWikiModel: model => selectWikiModel(wikiIo($), model),
    toggleWikiModel: isOpen => setWiki($, { isModelOpen: isOpen }),
    addDbConnection: text => addDbConnection(dbIo($), text),
    deleteDbConnection: id => deleteDbConnection(dbIo($), id),
    openDbConnection: id => openDbConnection(dbIo($), id),
    closeDbConnection: () => closeDbConnection(dbIo($)),
    toggleDbTable: t => toggleDbTable(dbIo($), t),
    setDbQuery: text => setDb($, { query: text, queryError: '' }),
    runDbQuery: text => runDbQuery(dbIo($), text),
    searchCi: text => searchCi(ciIo($), text),
    showCiPage: async page => {
      await showCiPage(ciIo($), page)
      await scrollTop($)
    },
    openCiRef: ref => openRef(ciIo($), ref),
    closeCiRef: () => closeRef(ciIo($)),
    openPipeline: p => openPipeline(ciIo($), p),
    closeCiPipeline: () => closePipeline(ciIo($)),
    openCiJob: j => openJob(ciIo($), j),
    closeCiJob: () => closeJob(ciIo($)),
    refreshCi: () => refreshCi(ciIo($)),
    saveCiToken: text => saveCiToken(ciIo($), text),
    toggleCiToken: isOpen => toggleCiToken(ciIo($), isOpen),
    retryCiPipeline: () => retryCiPipeline(ciIo($)),
    actOnCiJob: (j, kind) => actOnJob(ciIo($), j, kind),
    editChunks: edit => editChunks(gitIo($), edit),
    jumpConflict: step => jumpConflict(gitIo($), step),
    takeSide: side => takeSide(gitIo($), side),
    applyMerge: () => applyMerge(gitIo($)),
    askClaude: () => askClaude(gitIo($)),
    focusInput: key => ringOn($, key),
  }
}

// ───── 事件 ─────

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // 先開面板（畫「Loading…」），看著的 Tab 的資料等第一次畫時在背景讀（loadTabOnce），不擋住 session 開始。
    isOpenPending = e.surface === null
    if (!isOpenPending) void $.ui.open(PANE_ARGS)
    $.clock.every(FOCUS_WATCH_MS, () => void focusWhenShown(focusIo($)))
    // 用量直接跟引擎拿（不花錢），這裡只負責讓重置倒數每分鐘重畫一次。
    $.clock.every(USAGE_TICK_MS, () => $.ui.invalidate('ui.render'))
    $.clock.every(SERVICES_SCAN_MS, () => void scanWhenShown($).catch(() => undefined))
    $.clock.every(GIT_REFRESH_MS, () => void refreshWhenShown($).catch(() => undefined))
    $.clock.every(CI_REFRESH_MS, () => void refreshCiWhenShown($).catch(() => undefined))

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

  // Bash 碰到面板存的機密（GitLab token、DB 密碼）就擋下（secret-guard.ts）。
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    const reason = secretCommandReason(e.command)

    return reason === '' ? next(e) : { deny: reason }
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => checkWrite(baseIo($), e.file_path, await next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => checkWrite(baseIo($), e.file_path, await next(e))).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [activeTab, subs, v, isRemoteOpen, bf, bq, fp, sv, fileList, specs, wikiView, wf, dbView, ciView, lg, lq, shown, sentWiki, pages, usage, now, session] = await Promise.all([
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
      read($, ci),
      read($, log),
      read($, logQuery),
      read($, cover),
      read($, wikiSent),
      read($, diffPages),
      // 讀不到用量就當作還沒有讀數，不要讓整個面板畫不出來。
      $.session.usage().catch(() => undefined),
      $.clock.now(),
      $.session.id().catch(() => ''),
    ])

    loadTabOnce($, activeTab, session)
    const isWikiShown = activeTab === 'spec' && subs.spec === 'wiki'
    // 只有開著時才問：Files 的 ⋯ 選單（Show in Explorer 還是 Finder，問一次就記著）、Wiki 子分頁的模型選單。
    const [onWindows, current] = await Promise.all([fileList.menu !== '' && isWindows(baseIo($)), isWikiShown ? currentModel(wikiIo($)) : ('' as const)])
    // 這段對話送過的頁面。
    const sent = sentWiki.conversation === session ? sentWiki.pages : []
    const sub = shownSub(activeTab, subs)
    const fio = focusIo($)
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
        diffPages: pages,
        syncing: syncingNow(),
        services: sv,
        files: fileList,
        isWindows: onWindows,
        spec: specs,
        wiki: wikiView,
        wikiFolders: wf,
        currentModel: current,
        wikiSent: sent,
        isDistilling: distilling(),
        db: dbView,
        dbBusy: dbBusyNow(),
        ci: ciView,
        ciSaving: ciSavingNow(),
        ciActing: ciActingNow(),
        servicePending: pendingServices(),
        log: lg,
        logQuery: lq,
        cover: shown,
        isMergeBusy: mergeBusy(),
        usage: usage?.rateLimits ?? [],
        now,
      },
      actionsFor($, e.surface),
      (fn, ringKey) => act(fio, fn, ringKey),
    )
    checkPressed(fio, tree, now, activeTab, sub)
    checkCover(fio, shown.kind, now, activeTab, sub)

    return tree
  })
}
