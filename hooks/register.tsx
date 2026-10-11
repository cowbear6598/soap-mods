import { atom, read, update } from 'claude-code'
import type { EngineInterface, PaneOpenArgs, ProcessRunResult, Register, RenderChildren, Timer } from 'claude-code'

import type {
  CommitFile,
  DiffPaneView,
  GitBranch,
  GitCommit,
  GitFile,
  GitSubTab,
  GitView,
  LogView,
  MergeChoice,
  MergeChunk,
  MergeOp,
  MergeView,
  RepoSummary,
  ScanResult,
  Service,
  ServiceAction,
  ServicesView,
  TabId,
} from '../types'
import type { FileEntry, FileGroupId, FileKind } from './git'
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  fileKind,
  filterBranches,
  filterCommits,
  formatAgo,
  groupFiles,
  isConflict,
  letterKind,
  parseBranches,
  parseCommitFiles,
  parseLog,
  parseStatus,
  searchWords,
  splitPath,
  toHunks,
} from './git'
import {
  buildResult,
  choose,
  chooseAll,
  chunkResult,
  conflictLabel,
  detectOp,
  isResolved,
  keepChoices,
  merge3,
  nextConflict,
  parseConflicts,
  splitLines,
  takesSide,
  toggleApplied,
} from './merge'
import { LAUNCH_ARGV, SCAN_ARGV, findServices, isInFolder } from './services'

// ───── 想改面板標題或分頁，改這一區 ─────
const PANE = 'soap-panel'
const PANEL_TITLE = 'Soap Panel'
const DIFF_PANE = 'soap-diff'
// 解衝突的三欄面板（左 Ours、中 Result、右 Theirs）。columns 是跟引擎要的寬度，人拖過的寬度優先。
const MERGE_PANE = 'soap-merge'
const MERGE_COLUMNS = 180
// 兩邊都一樣的段落，衝突的前後各留幾行，其餘收成「⋯ N unchanged lines」。
const MERGE_CONTEXT = 3
// 合併面板每一欄的寬度；三欄加起來不到 100%，剩下的當欄距。
const MERGE_COLUMN_WIDTH = '32%'

// 進行中的操作在 conflict 分頁上的名稱。
const OP_LABEL: Record<Exclude<MergeOp, ''>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert',
}

// 檔案狀態的名稱和顏色：檔案列的狀態字母、差異面板的標題都用這張表。
const KIND_STYLE: Record<FileKind, { label: string; theme: string }> = {
  added: { label: 'Added', theme: 'success' },
  modified: { label: 'Modified', theme: 'warning' },
  deleted: { label: 'Deleted', theme: 'error' },
  renamed: { label: 'Renamed', theme: 'suggestion' },
  conflict: { label: 'Conflict', theme: 'error' },
}

// 變更列表的分組標題，照這個順序畫。
const FILE_GROUPS: { id: FileGroupId; label: string }[] = [
  { id: 'staged', label: 'Staged' },
  { id: 'unstaged', label: 'Unstaged' },
  { id: 'untracked', label: 'Untracked' },
]

// 圖示：24x24 的線條圖，只放 <svg> 裡面的內容（Lucide 風格）。
const ICONS = {
  git: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  log: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  conflict:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  services:
    '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  restart: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
}
type IconName = keyof typeof ICONS

const ICON_PX = 16
// 選中的 tab 恆亮的底色。
const ACTIVE_BG = '#3a3a3a'
// 圖示按鈕的寬度：這串空白撐出按鈕，底色、hover、圖示都對齊這塊區域。
// 用不換行空白（\u00a0），一般空白會被吃掉。
const ICON_BUTTON_LABEL = '\u00a0'.repeat(10)
// 整行按鈕的 label：比任何面板都寬，超出整行的部分被裁掉。
const ROW_BUTTON_LABEL = '\u00a0'.repeat(400)
// 包住那顆按鈕的那層有多寬（欄數；百分比最多 100%，不夠用）：比按鈕寬，按鈕才不會被壓窄而在最右邊畫出「…」。
const ROW_OVERLAY_WIDTH = ROW_BUTTON_LABEL.length * 2

// 沒選中的圖示和分隔線的顏色。
const MUTED = '#8b8b8b'
// 選中的圖示（和紅底上的圖示）的顏色。
const ACTIVE_ICON = '#ffffff'

// 分隔線。桌面版把 Svg 畫成 max-width:100% 的圖，寬度會被壓到面板寬、高度固定 1px；
// preserveAspectRatio="none" 讓線跟著拉伸，不會被等比縮到看不見。終端機沒有 Svg，用一長串橫線字元。
const DIVIDER_PX = 4000
const DIVIDER_SVG = stretchedSvg(1, [{ width: 100, fill: MUTED }])
const DIVIDER_TEXT = '─'.repeat(400)

// 拉滿整行寬的橫條圖：依序疊上幾條從左邊開始的色條，width 是佔整行的百分比。分隔線和用量 bar 都用它。
function stretchedSvg(heightPx: number, bars: { width: number; fill: string }[]) {
  const rects = bars.map(b => `<rect width="${b.width}" height="1" fill="${b.fill}"/>`).join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_PX}" height="${heightPx}" viewBox="0 0 100 1" preserveAspectRatio="none">${rects}</svg>`
}

function iconSvg(name: IconName, isActive: boolean, tint?: string) {
  const color = tint ?? (isActive ? ACTIVE_ICON : MUTED)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}

// 上層 Tab。之後要加新的 Tab，在這裡加一筆，再到畫面區塊補上它的內容。
const TABS: { id: TabId; label: string; icon: IconName }[] = [
  { id: 'git', label: 'Git', icon: 'git' },
  { id: 'services', label: 'Services', icon: 'services' },
]

// Git Tab 的子分頁。
const SUB_TABS: { id: GitSubTab; label: string; icon: IconName }[] = [
  { id: 'diff', label: 'diff', icon: 'diff' },
  { id: 'branch', label: 'branch', icon: 'branch' },
  { id: 'log', label: 'log', icon: 'log' },
  { id: 'conflict', label: 'conflict', icon: 'conflict' },
]

// log 分頁一次列幾筆 commit；Load more 再多列這麼多筆。
const LOG_PAGE = 30

// 面板最底下的用量：左邊 5h、右邊 weekly，各占一半。kind 是引擎回報的視窗名稱。
const USAGE_WINDOWS = [
  { kind: 'five_hour', label: '5h' },
  { kind: 'seven_day', label: 'Weekly' },
]
// 剩餘量的顏色：多於 50% 綠、多於 20% 黃、其餘紅。bar 是 Svg，要用色碼。
const USAGE_GOOD = { theme: 'success', hex: '#4eba65' }
const USAGE_WARN = { theme: 'warning', hex: '#d4a72c' }
const USAGE_LOW = { theme: 'error', hex: '#e5534b' }
// 分支的打勾：紅底白勾（終端機是按鈕前的紅色方塊），一看就知道再按會刪。
const ARMED_TINT = { theme: USAGE_LOW.theme, hex: ACTIVE_ICON, background: USAGE_LOW.hex }
// 重置倒數多久重畫一次。
const USAGE_TICK_MS = 60_000
// bar 的高度（桌面版，px）；終端機的文字 bar 有幾格。
const USAGE_BAR_PX = 4
const USAGE_BAR_CELLS = 10
// Services 分頁開著時多久重新掃一次程序（掃一次大約 1 秒）。
const SERVICES_SCAN_MS = 5_000
// 重跑：停掉之後等多久再開（讓 port 放出來）；開完之後在這些時間點檢查新程序還在不在（同時重掃，
// 服務要一點時間才會 LISTEN）。這段時間內掛掉就算重跑失敗，在面板上提示。
const RESTART_GAP_MS = 500
const RESTART_CHECK_MS = [2_000, 5_000, 15_000, 30_000]
// 分支的垃圾桶換成打勾後，多久沒再按就收回去。
const DELETE_ARM_MS = 3_000
// ───── 以下是運作邏輯 ─────

const EMPTY: GitView = {
  isLoaded: false,
  isRepo: true,
  files: [],
  branches: [],
  error: '',
  branchError: '',
  deleteArmed: null,
  op: '',
  opError: '',
  isAbortArmed: false,
  repos: [],
  repo: '',
}

const tab = atom({ plugin: 'soap-mods', key: 'tab' } as const, 'git')
const subTab = atom({ plugin: 'soap-mods', key: 'subTab' } as const, 'diff')
const view = atom({ plugin: 'soap-mods', key: 'view' } as const, EMPTY)
const showRemote = atom({ plugin: 'soap-mods', key: 'showRemote' } as const, false)
// branch 分頁搜尋框裡的字，換分頁就清掉。
const branchQuery = atom({ plugin: 'soap-mods', key: 'branchQuery' } as const, '')
// log 分頁搜尋框裡的字，一樣換分頁就清掉。
const logQuery = atom({ plugin: 'soap-mods', key: 'logQuery' } as const, '')
const EMPTY_SERVICES: ServicesView = { isLoaded: false, items: [], error: '', actionError: '', pending: [] }
const services = atom({ plugin: 'soap-mods', key: 'services' } as const, EMPTY_SERVICES)
const EMPTY_MERGE: MergeView = {
  path: '',
  hasMarkers: false,
  chunks: [],
  eol: '\n',
  hasFinalEol: true,
  oursLabel: '',
  theirsLabel: '',
  error: '',
  isBusy: false,
}
const merge = atom({ plugin: 'soap-mods', key: 'merge' } as const, EMPTY_MERGE)
const EMPTY_LOG: LogView = {
  ref: '',
  isLoaded: false,
  commits: [],
  unpushed: [],
  limit: LOG_PAGE,
  hasMore: false,
  isTruncated: false,
  error: '',
  commit: null,
  files: null,
  commitError: '',
}
const log = atom({ plugin: 'soap-mods', key: 'log' } as const, EMPTY_LOG)
const EMPTY_DIFF: DiffPaneView = { path: '', kind: 'modified', at: '', diff: '', isTruncated: false, error: '' }
const diffPane = atom({ plugin: 'soap-mods', key: 'diffPane' } as const, EMPTY_DIFF)

function usageLevel(remaining: number) {
  return remaining > 50 ? USAGE_GOOD : remaining > 20 ? USAGE_WARN : USAGE_LOW
}

// 離重置還有多久：「2d 18h 5m」「2h 26m」「12m」；沒有重置時間就回空字串。
function formatResetIn(resetsAt: string | undefined, now: number) {
  if (resetsAt === undefined) return ''
  const ms = Date.parse(resetsAt) - now
  if (Number.isNaN(ms)) return ''
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`

  return `${m}m`
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

// Git 分頁正在看的 repo：根目錄、.git 資料夾、資料夾名稱。status 給的路徑都相對根目錄，
// 所以知道根目錄之後 git 一律在根目錄跑，讀寫檔案也接在根目錄後面。
type Repo = { name: string; root: string; gitDir: string }
let repo: Repo | undefined
// 那排 repo 按鈕：session 資料夾本身是 repo 時只有它一個；不是的話（例如在 company/ 開，底下 a、b、c
// 各是一個 repo）是下一層找到的 repo，照名稱排。每次 refresh 重找，新 clone 的也會出現。
let repoList: Repo[] = []

const REPO_ARGS = ['rev-parse', '--show-toplevel', '--absolute-git-dir']
const STATUS_ARGS = ['status', '--porcelain=v1', '-b', '-z', '-uall']

// 預設在選中的 repo 根目錄跑；init.cwd 指定別的資料夾（找 repo、看其他 repo 的狀態）。
async function git($: EngineInterface, args: string[], init?: { cwd?: string; env?: Record<string, string> }) {
  return $.process.run(['git', '-c', 'core.quotepath=false', ...args], { cwd: repo?.root, ...init })
}

const isNotRepo = (r: ProcessRunResult) => r.stderr.includes('not a git repository')

// rev-parse 的輸出（根目錄一行、.git 資料夾一行）；不是 repo 或讀不到就是 undefined。名稱是根目錄的資料夾名。
function parseRepo(r: ProcessRunResult): Repo | undefined {
  const [root = '', gitDir = ''] = r.exitCode === 0 ? r.stdout.split('\n').map(s => s.trim()) : []

  return root === '' || gitDir === '' ? undefined : { name: splitPath(root).name, root, gitDir }
}

// 找 repo：session 資料夾本身是 repo 就只有它；不是的話看下一層有 .git 的資料夾。
// 已經找過的不再問 git，只有新的才跑一次 rev-parse。
async function findRepos($: EngineInterface): Promise<Repo[]> {
  const cwd = await $.session.cwd()
  const self = await git($, REPO_ARGS, { cwd })
  if (!isNotRepo(self)) {
    const found = parseRepo(self)

    return found === undefined ? [] : [found]
  }
  const entries = await $.fs.list(cwd).catch(() => [])
  const found = await Promise.all(
    entries
      .filter(e => e.kind === 'dir' && !e.name.startsWith('.'))
      .map(async e => {
        const dir = `${cwd}/${e.name}`
        if (!(await $.fs.exists(`${dir}/.git`).catch(() => false))) return undefined

        return repoList.find(c => c.name === e.name) ?? parseRepo(await git($, REPO_ARGS, { cwd: dir }))
      }),
  )

  return found.filter(c => c !== undefined).sort((a, b) => a.name.localeCompare(b.name))
}

const toSummary = (r: Repo, files: GitFile[]): RepoSummary => ({
  name: r.name,
  root: r.root,
  isDirty: files.length > 0,
  hasConflict: files.some(isConflict),
})

// 其他 repo 有沒有變更、有沒有衝突：不用分支、不展開未追蹤的資料夾，比較快；讀不到就當作沒有變更。
async function summarize($: EngineInterface, r: Repo): Promise<RepoSummary> {
  const status = await git($, ['status', '--porcelain=v1', '-z'], { cwd: r.root }).catch(() => undefined)

  return toSummary(r, status?.exitCode === 0 ? parseStatus(status.stdout).files : [])
}

// 換 Git 分頁看的 repo：開著的 diff／合併面板是上一個 repo 的檔案，關掉；合併面板正在寫檔時不換。
async function selectRepo($: EngineInterface, name: string) {
  const next = repoList.find(c => c.name === name)
  if (next === undefined || next === repo || (await read($, merge)).isBusy) return
  repo = next
  stageCache = undefined
  await Promise.all([
    setView($, { repo: name, ...NO_MESSAGES }),
    update($, diffPane, () => EMPTY_DIFF),
    // log 換成新 repo 的目前分支。
    update($, log, () => EMPTY_LOG),
  ])
  await Promise.all([closeMerge($), $.ui.close({ id: DIFF_PANE })])
  await refresh($)
}

// 跑 git，結束碼不是 0 就丟出它的錯誤訊息。
async function gitOk($: EngineInterface, args: string[], init?: { cwd?: string; env?: Record<string, string> }) {
  const r = await git($, args, init)
  if (r.exitCode !== 0) throw failure(r, `git ${args.join(' ')}`)

  return r
}

const inRepo = (path: string) => (repo === undefined ? path : `${repo.root}/${path}`)

// .git 資料夾裡有哪些檔案（看得出停在 merge 還是 rebase）。
async function readGitDir($: EngineInterface): Promise<string[]> {
  if (repo === undefined) return []

  return $.fs.list(repo.gitDir).then(
    entries => entries.map(entry => entry.name),
    () => [],
  )
}

async function setView($: EngineInterface, patch: Partial<GitView>) {
  await update($, view, v => ({ ...v, ...patch }))
}

const NO_GIT = 'git not found. Make sure it is installed and on your PATH.'
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
async function readDiff($: EngineInterface, files: GitView['files'], path: string): Promise<DiffPaneView> {
  const file = files.find(f => f.path === path)
  if (file === undefined) return EMPTY_DIFF
  const result = await (file.x === '?'
    ? runDiff($, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path])
    : runDiff($, ['diff', ...DIFF_FLAGS, 'HEAD', '--', path], ['diff', ...DIFF_FLAGS, '--cached', '--', path]))

  return { path, kind: fileKind(file), at: '', ...result }
}

// 每個面板 open 時要給的標題和寬度；每次 open 都會重設它們，所以一律從這裡拿。
async function paneArgs($: EngineInterface, id: string): Promise<PaneOpenArgs> {
  if (id === MERGE_PANE) return { id, title: `Merge · ${splitPath((await read($, merge)).path).name}`, columns: MERGE_COLUMNS }
  if (id === DIFF_PANE) {
    const d = await read($, diffPane)

    return { id, title: d.at === '' ? d.path : `${d.path} @ ${d.at}` }
  }

  return { id: PANE, title: PANEL_TITLE }
}

// 開（或切到）一個面板並要焦點：已經開著的話先關再開，才會跳到最前面，而不是躲在別的分頁後面。
async function bringToFront($: EngineInterface, id: string) {
  const [panes, args] = await Promise.all([$.ui.panes(), paneArgs($, id)])
  if (panes.some(p => p.id === id)) await $.ui.close({ id })
  await $.ui.open({ ...args, focus: true })
}

// 點檔案：一定開一個獨立的 diff 面板並切過去；關掉面板交給面板自己的關閉鈕。
async function openDiff($: EngineInterface, path: string) {
  const pane = await readDiff($, (await read($, view)).files, path)
  await update($, diffPane, () => pane)
  await bringToFront($, DIFF_PANE)
}

// 重新讀 git 狀態、檔案清單、分支清單，保留原本點開的檔案；最後只寫一次 view，只重畫一次。
async function refresh($: EngineInterface) {
  let status
  let refs
  let names
  let others: (RepoSummary | undefined)[]
  try {
    repoList = await findRepos($)
    // 選中的 repo 還在就留著，不在了（或還沒選過）就換成第一個。
    repo = repoList.find(c => c.root === repo?.root) ?? repoList[0]
    if (repo === undefined) {
      await setView($, { ...EMPTY, isLoaded: true, isRepo: false })

      return
    }
    ;[status, refs, names, others] = await Promise.all([
      git($, STATUS_ARGS),
      git($, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']),
      readGitDir($),
      Promise.all(repoList.map(c => (c === repo ? undefined : summarize($, c)))),
    ])
  } catch {
    await setView($, { isLoaded: true, isRepo: false, error: NO_GIT })

    return
  }

  // 那排 repo：選中的那個用下面完整讀到的狀態，其他的用 summarize 的。
  const active = repo
  const repos = (files: GitFile[]) => others.map(o => o ?? toSummary(active, files))

  if (status.exitCode !== 0) {
    await update($, diffPane, d => (d.at === '' ? EMPTY_DIFF : d))
    await setView($, {
      isLoaded: true,
      isRepo: false,
      error: isNotRepo(status) ? '' : status.stderr.trim(),
      files: [],
      branches: [],
      repos: repos([]),
      repo: active.name,
    })

    return
  }

  const { files } = parseStatus(status.stdout)
  // 差異面板開著工作區的檔案就重讀；那個檔案已經沒有變更了（readDiff 給空的），把面板也關掉。
  // 開著的是 commit 裡的檔案就不用動，commit 不會變。
  const shown = await read($, diffPane)
  const pane = shown.at === '' && shown.path !== '' ? await readDiff($, files, shown.path) : shown
  await Promise.all([
    setView($, {
      isLoaded: true,
      isRepo: true,
      error: '',
      files,
      repos: repos(files),
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

// 桌面版的面板沒有焦點時，按下滑鼠會先拿焦點、整個面板重畫，按到的按鈕被換掉，那一下就不算。
// 點分頁標籤切到 Soap Panel 或合併面板時引擎不會通知、也不給焦點，所以定時看一下：
// 它「剛被切到前面」又沒焦點，就先把焦點給它，第一下點擊才點得到。
// 只在從看不見變成看得見的那一刻給，平常在輸入框打字不會被搶。
// 按完按鈕也可能丟焦點（切分支時被點的那列搬位置、abort 後整區消失），
// 所以每個按鈕的動作做完後的一小段時間內也補（act）。
const FOCUS_WATCH_MS = 200
const REFOCUS_AFTER_PRESS_MS = 600
// 要補焦點的面板。diff 面板沒有按鈕，不用。
const FOCUS_PANES = [PANE, MERGE_PANE]
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

const NO_MESSAGES = { branchError: '', deleteArmed: null, opError: '', isAbortArmed: false } as const

// 換分頁時清掉切換／刪除分支、abort／continue 失敗的訊息和待確認的刪除、abort；沒有要清的就不寫，免得面板白白重畫。
async function clearGitMessages($: EngineInterface) {
  await update($, view, v =>
    v.branchError === '' && v.deleteArmed === null && v.opError === '' && !v.isAbortArmed ? v : { ...v, ...NO_MESSAGES },
  )
}

// 換分頁（上層 Tab 或子分頁）時清掉的東西：錯誤訊息、待確認的 abort、branch 和 log 的搜尋。
async function leaveTab($: EngineInterface) {
  await Promise.all([clearGitMessages($), clearBranchQuery($), clearLogQuery($)])
}

async function clearBranchQuery($: EngineInterface) {
  await update($, branchQuery, () => '')
}

async function switchBranch($: EngineInterface, name: string, isRemote: boolean) {
  const args = isRemote ? ['switch', '--track', name] : ['switch', name]
  try {
    const r = await git($, args)
    if (r.exitCode !== 0) {
      await setView($, { branchError: r.stderr.trim() || `Failed to switch to ${name}` })

      return
    }
  } catch {
    await setView($, { branchError: NO_GIT })

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
  disarmTimer = $.clock.after(DELETE_ARM_MS, () => void update($, view, v => (v.deleteArmed === null ? v : { ...v, deleteArmed: null })))
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

// ───── log 分頁 ─────

async function setLog($: EngineInterface, patch: Partial<LogView>) {
  await update($, log, l => ({ ...l, ...patch }))
}

const NO_COMMIT: Partial<LogView> = { commit: null, files: null, commitError: '' }

// 分支的完整 ref：本地和遠端可能同名，用完整的才不會認錯。
const branchRef = (b: GitBranch) => `refs/${b.isRemote ? 'remotes' : 'heads'}/${b.name}`

// log 分頁看的分支：按過 log 的那個；沒按過（或那個分支已經不在了）就是目前分支；detached 時沒有。
function logBranch(v: GitView, l: LogView) {
  return v.branches.find(b => l.ref !== '' && branchRef(b) === l.ref) ?? v.branches.find(b => b.isCurrent)
}

type LogRead = { commits: GitCommit[]; unpushed: string[]; isTruncated: boolean; error: string }

// 讀 ref 的 commit（limit 沒給就是整條），和其中哪些還沒 push：有 upstream 比 upstream；
// 沒有的話比所有遠端分支，新分支從 main 分出來後加的才算。遠端分支本身都在遠端上，不會有標記。
async function readLog($: EngineInterface, ref: string, upstream: string, limit?: number): Promise<LogRead> {
  const [r, ahead] = await Promise.all([
    git($, ['log', ref, ...(limit === undefined ? [] : [`--max-count=${limit + 1}`]), `--format=${LOG_FORMAT}`]),
    git($, ['rev-list', ...(limit === undefined ? [] : [`--max-count=${limit}`]), ref, '--not', upstream === '' ? '--remotes' : upstream]),
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

// 搜尋用的整條分支歷史：打字、Load more 時從這裡過濾，不用每次都跑 git。換 repo 或分支就重讀，
// refresh（回合結束）也重讀，歷史可能變了。git 最多給 4 MiB（大約兩萬多筆），超過的只搜最新的那些。
let history: { key: string; load: Promise<LogRead> } | undefined

function readHistory($: EngineInterface, ref: string, upstream: string, isFresh: boolean) {
  const key = `${repo?.root ?? ''}\n${ref}`
  if (isFresh || history?.key !== key) history = { key, load: readLog($, ref, upstream) }

  return history.load
}

// 讀 log 分頁的 commit，列前 limit 筆（沒給就是目前的筆數）；有搜尋時從整條分支的歷史裡挑出符合的。
// isFresh 是 false 時（打字、Load more）沿用讀過的歷史。
async function loadLog($: EngineInterface, { isFresh = true, limit }: { isFresh?: boolean; limit?: number } = {}) {
  const [v, l, query] = await Promise.all([read($, view), read($, log), read($, logQuery)])
  const branch = logBranch(v, l)
  // 按過的分支已經不在了：回到目前分支。
  const isPicked = branch !== undefined && l.ref !== '' && branchRef(branch) === l.ref
  const ref = isPicked ? l.ref : 'HEAD'
  const upstream = branch !== undefined && !branch.isRemote && branch.track !== '[gone]' ? branch.upstream : ''
  const count = limit ?? l.limit
  const isSearching = searchWords(query).length > 0
  if (!isSearching) history = undefined
  try {
    const found = isSearching
      ? await readHistory($, ref, upstream, isFresh).then(h => ({ ...h, commits: filterCommits(h.commits, query) }))
      : await readLog($, ref, upstream, count)
    // 讀的時候搜尋的字又變了：交給後面那次。
    if ((await read($, logQuery)) !== query) return
    const commits = found.commits.slice(0, count)
    const ahead = new Set(found.unpushed)
    await setLog($, {
      ref: isPicked ? l.ref : '',
      isLoaded: true,
      limit: count,
      commits,
      hasMore: found.commits.length > count,
      isTruncated: found.isTruncated,
      // 只留列出來的那些，整條歷史的可能很多。
      unpushed: commits.filter(c => ahead.has(c.sha)).map(c => c.sha),
      error: found.error,
    })
  } catch {
    await setLog($, { isLoaded: true, error: NO_GIT })
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
  await update($, logQuery, () => '')
}

// 換子分頁。log 不在看的時候不讀，換過來才讀。
async function selectSubTab($: EngineInterface, id: GitSubTab) {
  await Promise.all([update($, subTab, () => id), leaveTab($)])
  if (id === 'log') await loadLog($)
}

// branch 分頁的 log 按鈕：換到 log 分頁看那個分支，從最近的 LOG_PAGE 筆開始。
// 按目前分支那列就是回到「跟著目前分支」，之後切分支 log 也跟著換。
async function viewLog($: EngineInterface, b: GitBranch) {
  await update($, log, () => ({ ...EMPTY_LOG, ref: b.isCurrent ? '' : branchRef(b) }))
  await selectSubTab($, 'log')
}

async function loadMoreLog($: EngineInterface) {
  await loadLog($, { isFresh: false, limit: (await read($, log)).limit + LOG_PAGE })
}

// commit 跟誰比：merge commit 比第一個 parent（這次 merge 帶進來什麼），第一個 commit 比空的。
const commitRange = (c: GitCommit) => (c.parents[0] === undefined ? ['--root', c.sha] : [c.parents[0], c.sha])

// 點 commit：列表換成它改了哪些檔案。讀到的時候已經換成別筆（或按了 Back）就丟掉。
async function openCommit($: EngineInterface, c: GitCommit) {
  await setLog($, { ...NO_COMMIT, commit: c })
  let patch: Partial<LogView>
  try {
    const r = await git($, ['diff-tree', '-r', '-M', '--name-status', '-z', '--no-commit-id', ...commitRange(c)])
    patch = r.exitCode === 0 ? { files: parseCommitFiles(r.stdout) } : { files: [], commitError: r.stderr.trim() }
  } catch {
    patch = { files: [], commitError: NO_GIT }
  }
  await update($, log, l => (l.commit?.sha === c.sha ? { ...l, ...patch } : l))
}

// 點 commit 裡的檔案：在 diff 面板看它在這個 commit 的差異。改名的檔案兩個路徑都要給，git 才認得出是改名。
async function openCommitDiff($: EngineInterface, c: GitCommit, f: CommitFile) {
  const paths = f.oldPath === '' ? [f.path] : [f.oldPath, f.path]
  const result = await runDiff($, ['diff-tree', '-p', '-M', ...DIFF_FLAGS, '--no-commit-id', ...commitRange(c), '--', ...paths])
  await update($, diffPane, () => ({ path: f.path, kind: letterKind(f.letter), at: c.shortSha, ...result }))
  await bringToFront($, DIFF_PANE)
}

// ───── 解衝突 ─────

async function setMerge($: EngineInterface, patch: Partial<MergeView>) {
  await update($, merge, m => ({ ...m, ...patch }))
}

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
  const [text, listed, m] = await Promise.all([
    $.fs.read(inRepo(path)).catch(() => null),
    listStages($, path).catch(() => null),
    read($, merge),
  ])
  const parsed = text === null ? null : parseConflicts(text)
  let next: MergeView = { ...EMPTY_MERGE, path }
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

async function closeMerge($: EngineInterface) {
  await update($, merge, () => EMPTY_MERGE)
  await $.ui.close({ id: MERGE_PANE })
}

// refresh 之後：合併面板的檔案已經不是衝突了（解掉了、abort 了）就關掉，否則重讀一次（檔案可能被改過）。
async function syncMerge($: EngineInterface, files: GitFile[]) {
  const m = await read($, merge)
  if (m.path === '' || m.isBusy) return
  const file = files.find(f => f.path === m.path)
  if (file === undefined || !isConflict(file)) {
    await closeMerge($)

    return
  }
  await loadMerge($, m.path)
}

// 解掉合併面板上的檔案：做事的期間面板顯示處理中；失敗把錯誤留在面板上，
// 成功就關掉合併面板、重讀狀態，焦點交回 Soap Panel。
async function resolveFile($: EngineInterface, what: string, work: (path: string) => Promise<unknown>) {
  const m = await read($, merge)
  if (m.isBusy || m.path === '') return
  await setMerge($, { isBusy: true, error: '' })
  try {
    await work(m.path)
  } catch (err) {
    await setMerge($, { isBusy: false, error: `${what} failed: ${errorText(err)}` })

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
async function askClaude($: EngineInterface) {
  const [m, v] = await Promise.all([read($, merge), read($, view)])
  if (m.path === '') return
  const during = v.op === '' ? '' : ` (a ${v.op} is in progress; do not continue or abort it)`
  await $.prompt.submit({
    text: `Resolve the git conflicts in \`${inRepo(m.path)}\`${during}. Keep what both sides meant to do, remove every conflict marker, then run \`git add\` on the file.`,
    asUser: true,
  })
  $.ui.toast('Sent to Claude')
}

// abort／continue：成功跳 toast，失敗把錯誤留在 conflict 分頁，最後重讀狀態。
async function runOp($: EngineInterface, op: Exclude<MergeOp, ''>, args: string[], done: string, env?: Record<string, string>) {
  let opError = ''
  try {
    await gitOk($, args, env === undefined ? undefined : { env })
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

async function setServices($: EngineInterface, patch: Partial<ServicesView>) {
  await update($, services, v => ({ ...v, ...patch }))
}

// 指令失敗時的錯誤：stderr、stdout，都沒有就說它的結束碼。
const failure = (r: ProcessRunResult, what: string) =>
  new Error(r.stderr.trim() || r.stdout.trim() || `${what} exited with ${r.exitCode}`)

// 掃一次：這個資料夾的服務，和目前所有活著的 PID（重跑後的檢查用）。
async function scan($: EngineInterface) {
  const [r, cwd] = await Promise.all([$.process.run(SCAN_ARGV), $.session.cwd()])
  if (r.exitCode !== 0) throw failure(r, 'Process scan')
  const result = JSON.parse(r.stdout) as ScanResult

  return { items: findServices(result, cwd), alive: new Set(result.pids) }
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
        const isMissing = /ENOENT|not found|cannot start/i.test(errorText(err))
        await setServices($, {
          isLoaded: true,
          error: isMissing ? 'Services needs Windows PowerShell (Windows only for now).' : `Scan failed: ${errorText(err)}`,
        })
      }
    } while (isRescanWanted)
  } finally {
    isScanning = false
  }
}

async function setPending($: EngineInterface, pid: number, action: ServiceAction | undefined) {
  await update($, services, v => ({
    ...v,
    pending: [...v.pending.filter(p => p.pid !== pid), ...(action === undefined ? [] : [{ pid, action }])],
  }))
}

// 停掉／重跑一個服務。動手前重新掃一次，確認還是同一個程序（PID 沒有被別人拿去用），才砍整棵程序樹。
async function runServiceAction($: EngineInterface, target: Service, action: ServiceAction) {
  if ((await read($, services)).pending.some(p => p.pid === target.pid)) return
  await setPending($, target.pid, action)
  await setServices($, { actionError: '' })
  try {
    const current = (await scan($)).items.find(s => s.pid === target.pid && s.startedAt === target.startedAt)
    if (current === undefined) throw new Error(`${target.tool} · ${target.name} already exited.`)
    if (action === 'restart' && current.command === '') throw new Error(`Cannot read the command line of ${current.tool} · ${current.name}.`)

    const kill = await $.process.run(['taskkill', '/PID', String(current.pid), '/T', '/F'])
    if (kill.exitCode !== 0) throw failure(kill, 'taskkill')

    if (action === 'restart') {
      await $.clock.sleep(RESTART_GAP_MS)
      const launch = await $.process.run(LAUNCH_ARGV, { env: { SOAP_CMD: current.command, SOAP_DIR: current.dir } })
      if (launch.exitCode !== 0) throw failure(launch, 'Restart')
      watchRestart($, `${current.tool} · ${current.name}`, Number(launch.stdout.trim()))
      $.ui.toast(`Restarted ${current.tool} · ${current.name}`)
    } else {
      $.ui.toast(`Stopped ${current.tool} · ${current.name}`)
    }
  } catch (err) {
    await setServices($, { actionError: `${action === 'stop' ? 'Stop' : 'Restart'} failed: ${errorText(err)}` })
  } finally {
    await setPending($, target.pid, undefined)
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

async function selectTab($: EngineInterface, id: TabId) {
  await Promise.all([update($, tab, () => id), leaveTab($)])
  // 掃描要一秒左右，不等它：先切過去畫「掃描中」或舊清單。
  if (id === 'services') void refreshServices($).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'soap-panel',
      description: 'Open Soap Panel (Git panel)',
    })
    // 先開面板（畫「讀取中…」），git 在背景讀，不擋住 session 開始。
    void $.ui.open({ id: PANE, title: PANEL_TITLE })
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
    await $.ui.open({ id: PANE, title: PANEL_TITLE })

    return { text: 'Soap Panel opened.' }
  })

  // 每個回合結束後，檔案可能已經變了，順手更新。
  on('turn.complete', async ($, e, next) => {
    try {
      await refresh($)
    } catch {
      // 讀不到就維持舊畫面，不要擋住回合結束。
    }

    return next(e)
  })

  // 自己按掉 diff 面板時：清掉選中的檔案，並把焦點交回 Soap Panel。
  // 桌面版的面板沒有焦點時，按下滑鼠會先拿焦點、整個面板重畫，按到的按鈕被換掉，那一下就不算；
  // 先把焦點給它，回來的第一下才點得到。
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === DIFF_PANE && e.origin.kind === 'person') {
      await update($, diffPane, () => EMPTY_DIFF)
      await focusPanel($)
    }
    // 合併面板被按掉：放掉選到一半的結果（檔案沒動過，下次打開從頭選）。
    if (e.id === MERGE_PANE && e.origin.kind === 'person') {
      await update($, merge, () => EMPTY_MERGE)
      await focusPanel($)
    }

    return result
  }).catch(($, e, next) => next(e)) // 清不掉就算了，絕不能擋住關面板。

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // 終端機沒有 Svg，那邊退回文字按鈕。
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const isTerminal = e.surface === 'terminal'
    const [activeTab, activeSub, v, isRemoteOpen, query, sv, lg, lq, usage, now] = await Promise.all([
      read($, tab),
      read($, subTab),
      read($, view),
      read($, showRemote),
      read($, branchQuery),
      read($, services),
      read($, log),
      read($, logQuery),
      // 讀不到用量就當作還沒有讀數，不要讓整個面板畫不出來。
      $.session.usage().catch(() => undefined),
      $.clock.now(),
    ])
    const windows = usage?.rateLimits ?? []

    // 只有圖示的按鈕，三層疊起來（後畫的 absolute 疊在上面）：
    // 1. 墊底的 Button 撐出外框大小，選中的底色畫在外框上；它被蓋住，點不到；
    // 2. Svg 那層鋪滿外框、置中；
    // 3. 最上層是一模一樣的 Button，剛好蓋滿外框，接點擊，hover 的亮底也就是外框大小。
    // tint：圖示固定用這個顏色（停止鈕的紅色）；終端機沒有 Svg，就在按鈕前面放一個同色的方塊。
    // tint.background：外框固定用這個底色（等著確認刪除的紅底），蓋過選中的底色。
    // 這個面板上的按鈕都經過 act：動作做完後丟了焦點會補回來。
    const iconButton = (
      key: string,
      icon: IconName,
      label: string,
      isActive: boolean,
      action: () => unknown,
      tint?: { theme: string; hex: string; background?: string },
    ) => {
      const onPress = act($, PANE, action)

      return Svg === undefined ? (
        <Box key={`${key}:box`}>
          {tint !== undefined && <Text color={tint.theme}>■</Text>}
          <Button key={key} label={label} variant={isActive ? 'primary' : 'secondary'} onPress={onPress} />
        </Box>
      ) : (
        <Box key={`${key}:box`} position="relative" backgroundColor={tint?.background ?? (isActive ? ACTIVE_BG : undefined)}>
          <Button key={`${key}:spacer`} label={ICON_BUTTON_LABEL} plain onPress={onPress} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
            <Svg source={iconSvg(icon, isActive, tint?.hex)} alt={label} width={ICON_PX} height={ICON_PX} />
          </Box>
          <Box position="absolute" top={0} left={0}>
            <Button key={key} label={ICON_BUTTON_LABEL} plain onPress={onPress} />
          </Box>
        </Box>
      )
    }

    // 整行都能點的列表項目；indent 是名稱前面空幾格（預設 2 給列表項目，標題列給 0）。
    // 桌面版：內容照常排，上面疊一顆透明按鈕。按鈕本身是 fit-content，靠一長串不換行空白撐開；
    // 包它的那層比整行寬很多、超出的部分被裁掉，按鈕就不會被壓到整行寬而在最右邊畫出「…」，
    // 看得到的 hover 亮底剛好是整行。
    // 終端機：疊上去的空白會蓋掉底下的字，所以只有名稱是按鈕。
    // isTruncated：名稱太長時在桌面版截成「…」，讓 rest 留在同一行（commit 的 subject）。
    // trailing：放在整行最右邊、自己能按的東西（branch 列的 log 圖示），不在透明按鈕底下，才按得到。
    const pressRow = (row: {
      key: string
      label: string
      onPress: () => unknown
      isDim?: boolean
      isBold?: boolean
      isTruncated?: boolean
      color?: string
      indent?: number
      lead?: RenderChildren
      rest?: RenderChildren
      trailing?: RenderChildren
    }) => {
      if (isTerminal) {
        return (
          <Box key={`${row.key}:row`} gap={1} paddingLeft={row.indent ?? 2} hover={{ backgroundColor: ACTIVE_BG }}>
            {row.lead}
            <Button key={row.key} label={row.label} plain dimColor={row.isDim} onPress={act($, PANE, row.onPress)} />
            {row.rest}
            {row.trailing}
          </Box>
        )
      }
      const label = (
        <Text bold={row.isBold} color={row.color} dimColor={row.isDim} wrap={row.isTruncated ? 'truncate-end' : undefined}>
          {row.label}
        </Text>
      )
      const hasTrailing = row.trailing !== undefined
      const pressable = (
        <Box key={`${row.key}:row`} position="relative" flexGrow={hasTrailing ? 1 : undefined} flexShrink={hasTrailing ? 1 : undefined}>
          <Box gap={1} paddingLeft={row.indent ?? 2}>
            {row.lead}
            {row.isTruncated ? (
              <Box flexShrink={1} overflow="hidden">
                {label}
              </Box>
            ) : (
              label
            )}
            {row.rest}
          </Box>
          <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
            <Box width={ROW_OVERLAY_WIDTH} flexShrink={0}>
              <Button key={row.key} label={ROW_BUTTON_LABEL} plain onPress={act($, PANE, row.onPress)} />
            </Box>
          </Box>
        </Box>
      )

      return hasTrailing ? (
        <Box key={`${row.key}:line`} gap={1} alignItems="center">
          {pressable}
          <Box flexShrink={0}>{row.trailing}</Box>
        </Box>
      ) : (
        pressable
      )
    }

    // 一個檔案一列：彩色狀態字母、檔名、淡色資料夾。diff 分頁和 log 分頁點開的 commit 共用。
    const pathRow = (key: string, path: string, letter: string, kind: FileKind, onPress: () => unknown) => {
      const { name, dir } = splitPath(path)

      return pressRow({
        key,
        label: name,
        onPress,
        lead: (
          <Text bold color={KIND_STYLE[kind].theme}>
            {letter}
          </Text>
        ),
        rest:
          dir === '' ? null : (
            <Text dimColor wrap="truncate-start">
              {dir}
            </Text>
          ),
      })
    }

    // branch、log 分頁最上面的搜尋框。手機版沒有 Input，就不畫。邊打邊過濾；桌面版拔不掉框旁邊的 submit 按鈕，
    // 就讓它（和 Enter）清空搜尋。框不能設寬度、撐不滿，所以整組水平置中。
    const searchField = (key: string, value: string, onInput: (text: string) => unknown, onClear: () => unknown) =>
      'Input' in ui ? (
        <Box key={`${key}:row`} width="100%" justifyContent="center">
          <ui.Input
            key={key}
            placeholder="Search"
            value={value}
            submitLabel="Clear"
            onInput={text => void onInput(text)}
            onSubmit={() => void onClear()}
          />
        </Box>
      ) : null

    // 項目之間插入直線分隔。
    const withDividers = (items: RenderChildren[], prefix: string) =>
      items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${prefix}:div:${i}`} dimColor>│</Text>, item]))

    // 一排置中的圖示分頁，中間用直線隔開。tints：某幾個分頁的圖示固定用這個顏色（有衝突時 conflict 變紅）。
    const iconBar = <T extends string>(
      prefix: string,
      items: { id: T; label: string; icon: IconName }[],
      active: T,
      select: (id: T) => unknown,
      tints: Partial<Record<T, { theme: string; hex: string }>> = {},
    ) => (
      <Box gap={1} alignItems="center" justifyContent="center" width="100%">
        {withDividers(
          items.map(t => iconButton(`${prefix}:${t.id}`, t.icon, t.label, t.id === active, () => select(t.id), tints[t.id])),
          prefix,
        )}
      </Box>
    )

    // 拉滿整行的橫條圖（stretchedSvg 畫的），落在這一列的正中間。
    const stretched = (source: string, alt: string, heightPx: number) =>
      Svg === undefined ? null : (
        <Box width="100%" height={1} overflow="hidden" alignItems="center">
          <Svg source={source} alt={alt} width={DIVIDER_PX} height={heightPx} />
        </Box>
      )

    // 分隔線：夾在兩條線中間的東西就會上下對稱。
    const divider =
      Svg === undefined ? (
        <Box width="100%" height={1} overflow="hidden">
          <Text dimColor>{DIVIDER_TEXT}</Text>
        </Box>
      ) : (
        stretched(DIVIDER_SVG, 'Divider', 1)
      )

    const error = activeTab === 'git' && v.error !== '' ? <Text color="error">{v.error}</Text> : null

    // repo 排成一排：「a*」是有未提交的變更，「!」是有衝突。session 資料夾本身是 repo 時只有它一個；
    // 不是的話是下一層的 repo，點了換 Git 分頁看的 repo；面板不會自己換。
    const repoBar =
      v.repos.length === 0 ? null : (
        <Box gap={1} flexWrap="wrap" justifyContent="center" width="100%">
          {v.repos.map(r => (
            <Button
              key={`repo:${r.name}`}
              label={`${r.name}${r.isDirty ? '*' : ''}${r.hasConflict ? ' !' : ''}`}
              variant={r.name === v.repo ? 'primary' : 'secondary'}
              onPress={act($, PANE, () => selectRepo($, r.name))}
            />
          ))}
        </Box>
      )

    let body
    if (activeTab === 'services') {
      // 一個服務一行：● 工具 · 專案名 · port，右邊重跑、停止（紅色）。
      const serviceRow = (s: Service) => {
        const pending = sv.pending.find(p => p.pid === s.pid)
        const dot = <Text dimColor>{' · '}</Text>

        return (
          <Box key={`svc:${s.pid}`} gap={1} alignItems="center" paddingLeft={2}>
            <Text color={pending === undefined ? 'success' : 'warning'}>●</Text>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Text>{s.tool}</Text>
              {dot}
              <Text bold wrap="truncate-end">
                {s.name}
              </Text>
              {s.ports.length > 0 && dot}
              {s.ports.length > 0 && <Text color="suggestion">{s.ports.map(p => `:${p}`).join(' ')}</Text>}
            </Box>
            {pending === undefined ? (
              <Box flexShrink={0}>
                {iconButton(`svc:restart:${s.pid}`, 'restart', 'Restart', false, () => void runServiceAction($, s, 'restart'))}
                {iconButton(`svc:stop:${s.pid}`, 'stop', 'Stop', false, () => void runServiceAction($, s, 'stop'), USAGE_LOW)}
              </Box>
            ) : (
              <Text dimColor>{pending.action === 'stop' ? 'Stopping…' : 'Restarting…'}</Text>
            )}
          </Box>
        )
      }

      // 照 repo 分組，跟 diff 分頁的 Staged／Unstaged 一樣：標題是 repo 名（不寫數量），下面是它的服務。
      // 組的順序跟上面那排 repo 一樣；不在任何 repo 裡的放最後的 Other。還沒讀到 repo 時全部放在 Running。
      const groupOf = new Map(sv.items.map(s => [s, v.repos.find(r => isInFolder(s.dir, r.root))?.name ?? 'Other']))
      const serviceGroups =
        v.repos.length === 0
          ? [{ name: 'Running', items: sv.items }]
          : [...v.repos.map(r => r.name), 'Other']
              .map(name => ({ name, items: sv.items.filter(s => groupOf.get(s) === name) }))
              .filter(g => g.items.length > 0)

      body = (
        <Box flexDirection="column" gap={1}>
          {sv.error !== '' && <Text color="error">{sv.error}</Text>}
          {sv.actionError !== '' && <Text color="error">{sv.actionError}</Text>}
          {!sv.isLoaded ? (
            <Text dimColor>Scanning…</Text>
          ) : sv.items.length === 0 ? (
            <Text dimColor>No services running in this folder.</Text>
          ) : (
            <Box flexDirection="column" gap={1}>
              {serviceGroups.map(g => (
                <Box key={`svc-group:${g.name}`} flexDirection="column">
                  <Text bold dimColor>{g.name}</Text>
                  {g.items.map(serviceRow)}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    } else if (!v.isLoaded) {
      body = <Text dimColor>Loading…</Text>
    } else if (!v.isRepo) {
      body = <Text dimColor>This folder is not a git repo.</Text>
    } else if (activeSub === 'diff') {
      const groups = groupFiles(v.files)
      // 點檔案：衝突的開合併面板，其他開差異面板。
      const fileRow = (group: FileGroupId, entry: FileEntry) =>
        pathRow(`file:${group}:${entry.file.path}`, entry.file.path, entry.letter, entry.kind, () =>
          entry.kind === 'conflict' ? openMerge($, entry.file.path) : openDiff($, entry.file.path),
        )

      body =
        v.files.length === 0 ? (
          <Text dimColor>No uncommitted changes.</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {FILE_GROUPS.filter(g => groups[g.id].length > 0).map(g => (
              <Box key={`group:${g.id}`} flexDirection="column">
                <Text bold dimColor>{`${g.label} · ${groups[g.id].length}`}</Text>
                {groups[g.id].map(entry => fileRow(g.id, entry))}
              </Box>
            ))}
          </Box>
        )
    } else if (activeSub === 'branch') {
      // parseBranches 已經排好：目前分支第一個，其餘照名稱。切換後被點的那列會搬位置、面板丟掉焦點，
      // 由 focusWhenShown 補回來。
      // 搜尋時只留名稱符合的分支，Remote 直接展開（不用再按 ▸），沒有符合的那組整組不畫。
      const isSearching = searchWords(query).length > 0
      const isRemoteShown = isSearching || isRemoteOpen
      const shown = filterBranches(v.branches, query)
      const locals = shown.filter(b => !b.isRemote)
      const remotes = shown.filter(b => b.isRemote)
      const hasCurrent = locals[0]?.isCurrent === true
      const search = searchField(
        'branch:search',
        query,
        text => update($, branchQuery, () => text),
        () => clearBranchQuery($),
      )
      // 目前分支的 ● 落在縮排的空位裡，名稱跟其他分支對齊；點它不做事。
      // 右邊的 log 圖示按了到 log 分頁看這個分支；不是目前分支的本地分支前面多一個垃圾桶，按了換成打勾。
      const branchRow = (b: GitBranch) => {
        const id = `${b.isRemote ? 'r' : 'l'}:${b.name}`
        const logButton = iconButton(`log:${id}`, 'log', 'Log', false, () => viewLog($, b))
        const canDelete = !b.isRemote && !b.isCurrent
        const armed = canDelete && v.deleteArmed?.name === b.name ? v.deleteArmed : null
        const deleteButton =
          canDelete &&
          iconButton(
            `delete:${id}`,
            armed === null ? 'trash' : 'check',
            armed === null ? 'Delete' : armed.isForce ? 'Force delete' : 'Confirm',
            false,
            () => deleteBranch($, b.name),
            armed === null ? undefined : ARMED_TINT,
          )

        return pressRow({
          key: `switch:${id}`,
          label: b.name,
          isDim: b.isRemote,
          isBold: b.isCurrent,
          color: b.isCurrent ? 'success' : undefined,
          indent: b.isCurrent ? 0 : undefined,
          lead: b.isCurrent ? <Text color="success">●</Text> : undefined,
          onPress: b.isCurrent ? () => undefined : () => switchBranch($, b.name, b.isRemote),
          trailing: (
            <Box key={`trailing:${id}`} gap={1} alignItems="center">
              {deleteButton}
              {logButton}
            </Box>
          ),
        })
      }

      // 兩組的標題對齊最左邊、分支名稱縮兩格；切換失敗的訊息在最上面，換分頁就清掉。
      body = (
        <Box flexDirection="column" gap={1}>
          {v.branchError !== '' && <Text color="error">{v.branchError}</Text>}
          {v.deleteArmed?.isForce === true && (
            <Text color="error">{`${v.deleteArmed.name} has unmerged commits; press again to force delete and lose them.`}</Text>
          )}
          {search}
          {isSearching && shown.length === 0 && <Text dimColor>No matching branches.</Text>}
          {(!isSearching || locals.length > 0) && (
            <Box flexDirection="column">
              <Text bold dimColor>{`Local · ${locals.length}`}</Text>
              {!isSearching && !hasCurrent && (
                <Box paddingLeft={2}>
                  <Text dimColor>No current branch (detached HEAD?)</Text>
                </Box>
              )}
              {locals.map(branchRow)}
            </Box>
          )}
          {remotes.length > 0 && (
            <Box flexDirection="column">
              {isSearching ? (
                <Text bold dimColor>{`Remote · ${remotes.length}`}</Text>
              ) : (
                pressRow({
                  key: 'remote:toggle',
                  label: `Remote · ${remotes.length} ${isRemoteOpen ? '▾' : '▸'}`,
                  isDim: true,
                  isBold: true,
                  indent: 0,
                  onPress: () => update($, showRemote, open => !open),
                })
              )}
              {isRemoteShown && remotes.map(branchRow)}
            </Box>
          )}
        </Box>
      )
    } else if (activeSub === 'log' && lg.commit !== null) {
      // 點開的 commit：最上面 ← Back，下面是它改了哪些檔案，點了在 diff 面板看差異。
      const c = lg.commit
      const commitFileRow = (f: CommitFile) =>
        pathRow(`commit-file:${f.path}`, f.path, f.letter, letterKind(f.letter), () => openCommitDiff($, c, f))

      body = (
        <Box flexDirection="column" gap={1}>
          {pressRow({ key: 'log:back', label: '← Back', isDim: true, isBold: true, indent: 0, onPress: () => setLog($, NO_COMMIT) })}
          <Box flexDirection="column">
            <Text bold>{c.subject}</Text>
            <Text dimColor>
              {[c.shortSha, c.author, formatAgo(c.time, now), c.parents.length > 1 ? 'merge, vs first parent' : '']
                .filter(s => s !== '')
                .join(' · ')}
            </Text>
          </Box>
          {lg.commitError !== '' && <Text color="error">{lg.commitError}</Text>}
          {lg.files === null ? (
            <Text dimColor>Loading…</Text>
          ) : lg.files.length === 0 ? (
            lg.commitError === '' && <Text dimColor>No files changed.</Text>
          ) : (
            <Box flexDirection="column">
              <Text bold dimColor>{`Files · ${lg.files.length}`}</Text>
              {lg.files.map(commitFileRow)}
            </Box>
          )}
        </Box>
      )
    } else if (activeSub === 'log') {
      // 一筆 commit 一列：短 sha、subject、作者 · 多久前；還沒 push 的在 sha 前面標黃色 ↑（落在縮排的空位裡）。
      const unpushed = new Set(lg.unpushed)
      const commitRow = (c: GitCommit) => {
        const isUnpushed = unpushed.has(c.sha)

        return pressRow({
          key: `commit:${c.sha}`,
          label: c.subject,
          isTruncated: true,
          indent: isUnpushed ? 0 : undefined,
          lead: [
            isUnpushed && (
              <Text key={`commit:${c.sha}:unpushed`} color="warning">
                ↑
              </Text>
            ),
            <Text key={`commit:${c.sha}:sha`} color="suggestion">
              {c.shortSha}
            </Text>,
          ],
          rest: (
            <Box flexShrink={0}>
              <Text dimColor>{`${c.author} · ${formatAgo(c.time, now)}`}</Text>
            </Box>
          ),
          onPress: () => openCommit($, c),
        })
      }

      // 搜尋時標題的數字是符合的筆數（超過列出的就加 +）。
      const isSearching = searchWords(lq).length > 0
      body = (
        <Box flexDirection="column" gap={1}>
          {lg.error !== '' && <Text color="error">{lg.error}</Text>}
          {searchField('log:search', lq, text => searchLog($, text), () => searchLog($, ''))}
          {!lg.isLoaded ? (
            <Text dimColor>Loading…</Text>
          ) : (
            <Box flexDirection="column">
              <Text bold dimColor>{`${logBranch(v, lg)?.name ?? 'HEAD (detached)'} · ${lg.commits.length}${lg.hasMore ? '+' : ''}`}</Text>
              {lg.commits.length === 0 && lg.error === '' && (
                <Box paddingLeft={2}>
                  <Text dimColor>{isSearching ? 'No matching commits.' : 'No commits yet.'}</Text>
                </Box>
              )}
              {lg.commits.map(commitRow)}
            </Box>
          )}
          {isSearching && lg.isTruncated && <Text dimColor>History is too long; searched only the newest commits.</Text>}
          {lg.hasMore && <Button key="log:more" label="Load more" onPress={act($, PANE, () => loadMoreLog($))} />}
        </Box>
      )
    } else {
      // 停在 merge／rebase 時：最上面是進行中的操作和 Abort／Continue（衝突全解完才有 Continue），
      // 下面是還沒解的檔案，點了開三欄的合併面板。
      const conflicts = v.files.filter(isConflict)
      const opLabel = v.op === '' ? '' : OP_LABEL[v.op]
      const conflictRow = (f: GitFile) => {
        const { name, dir } = splitPath(f.path)

        return pressRow({
          key: `conflict:${f.path}`,
          label: name,
          onPress: () => openMerge($, f.path),
          lead: (
            <Text bold color={KIND_STYLE.conflict.theme}>
              !
            </Text>
          ),
          rest: (
            <Text dimColor wrap="truncate-start">
              {[conflictLabel(f), dir].filter(s => s !== '').join(' · ')}
            </Text>
          ),
        })
      }

      body = (
        <Box flexDirection="column" gap={1}>
          {v.opError !== '' && <Text color="error">{v.opError}</Text>}
          {v.op !== '' && (
            <Box flexDirection="column">
              <Text bold color="warning">{`${opLabel} in progress`}</Text>
              <Box gap={1} flexWrap="wrap">
                {conflicts.length === 0 && (
                  <Button key="op:continue" label={`Continue ${v.op}`} variant="primary" onPress={act($, PANE, () => continueOp($))} />
                )}
                {v.isAbortArmed
                  ? [
                      <Button key="op:abort" label={`Yes, abort ${v.op}`} onPress={act($, PANE, () => abortOp($))} />,
                      <Button key="op:abort-cancel" label="Cancel" onPress={act($, PANE, () => setView($, { isAbortArmed: false }))} />,
                    ]
                  : [<Button key="op:abort" label={`Abort ${v.op}`} onPress={act($, PANE, () => abortOp($))} />]}
              </Box>
              {v.isAbortArmed && <Text color="warning">Aborting throws away every resolution made so far.</Text>}
            </Box>
          )}
          {conflicts.length === 0 ? (
            <Text dimColor>{v.op === '' ? 'No conflicts.' : 'All conflicts resolved.'}</Text>
          ) : (
            <Box flexDirection="column">
              <Text bold dimColor>{`Conflicts · ${conflicts.length}`}</Text>
              {conflicts.map(conflictRow)}
            </Box>
          )}
        </Box>
      )
    }

    // 底部用量的其中一半：「5h · 93% · 2h 26m」一行，下面一條剩餘用量的 bar；還沒有讀數就是「5h · —」。
    const usageHalf = (w: (typeof USAGE_WINDOWS)[number]) => {
      const reading = windows.find(r => r.kind === w.kind)
      const remaining = reading === undefined ? 0 : Math.max(0, Math.min(100, 100 - reading.percentUsed))
      const percent = `${Math.round(remaining)}%`
      const resetIn = reading === undefined ? '' : formatResetIn(reading.resetsAt, now)
      const level = usageLevel(remaining)
      const cells = Math.round((remaining / 100) * USAGE_BAR_CELLS)

      return (
        <Box key={`usage:${w.kind}`} width="50%" flexDirection="column" paddingX={1}>
          <Box>
            <Text dimColor>{`${w.label} · `}</Text>
            {reading === undefined ? (
              <Text dimColor>—</Text>
            ) : (
              <Text bold color={level.theme}>
                {percent}
              </Text>
            )}
            {resetIn !== '' && <Text dimColor>{` · ${resetIn}`}</Text>}
          </Box>
          {reading !== undefined &&
            (Svg === undefined ? (
              <Text color={level.theme}>{`${'█'.repeat(cells)}${'░'.repeat(USAGE_BAR_CELLS - cells)}`}</Text>
            ) : (
              stretched(
                stretchedSvg(USAGE_BAR_PX, [
                  { width: 100, fill: ACTIVE_BG },
                  { width: remaining, fill: level.hex },
                ]),
                `${percent} left`,
                USAGE_BAR_PX,
              )
            ))}
        </Box>
      )
    }

    // 整棵樹至少跟面板一樣高、內容區撐滿剩下的高度，用量就會被推到面板最底下；
    // 內容比面板還長時用量跟在後面。面板的高度只有引擎知道（bodyRows），百分比高度量不到。
    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows}>
        <Box flexDirection="column" gap={1} flexGrow={1}>
          <Box flexDirection="column">
            {iconBar('tab', TABS, activeTab, id => void selectTab($, id))}
            {divider}
            {activeTab === 'git' && repoBar}
            {activeTab === 'git' && repoBar !== null && divider}
            {activeTab === 'git' &&
              iconBar(
                'sub',
                SUB_TABS,
                activeSub,
                id => void selectSubTab($, id),
                v.files.some(isConflict) ? { conflict: USAGE_LOW } : {},
              )}
            {activeTab === 'git' && divider}
          </Box>
          {error}
          {body}
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {divider}
          <Box width="100%">{USAGE_WINDOWS.map(usageHalf)}</Box>
        </Box>
      </Box>
    )
  })

  // 選中檔案的差異，開在自己的面板裡：diff 分頁的未提交變更，或 log 分頁某個 commit 裡的檔案（標題後面加 @ sha）。
  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Code, Text } = $.ui.resolve(e)
    const shown = await read($, diffPane)

    if (shown.path === '') return <Text dimColor>No file selected.</Text>

    const kind = KIND_STYLE[shown.kind]

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text bold color={kind.theme}>
            {kind.label}
          </Text>
          <Text bold>{shown.path}</Text>
          {shown.at !== '' && <Text dimColor>{`@ ${shown.at}`}</Text>}
        </Box>
        {shown.error !== '' && <Text color="error">{shown.error}</Text>}
        {shown.diff === '' ? (
          <Text dimColor>No text diff to show (binary file, or only the mode changed).</Text>
        ) : (
          <Code source={shown.diff} format="diff" path={shown.path} />
        )}
        {shown.isTruncated && <Text dimColor>Diff is too long; showing only the beginning.</Text>}
      </Box>
    )
  })

  // 解衝突的三欄面板，像 JetBrains 的合併視窗：左邊 Ours、右邊 Theirs、中間是結果。
  // 每段衝突左邊按「Accept ≫」、右邊按「≪ Accept」把那一邊放進中間，中間也可以兩邊都要或重選；
  // 全部選好才能 Apply（寫回檔案並 git add）。
  // 只畫當下用得到的按鈕。按了之後按鈕被換掉（例如變成 Reset）會丟焦點，由 act 在之後補回來。
  on('ui.render', { component: 'Pane', requestId: MERGE_PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const [m, v] = await Promise.all([read($, merge), read($, view)])
    const press = (fn: () => unknown) => act($, MERGE_PANE, fn)

    if (m.path === '') return <Text dimColor>No conflicted file open.</Text>

    const title = (
      <Box gap={1}>
        <Text bold color={KIND_STYLE.conflict.theme}>
          {KIND_STYLE.conflict.label}
        </Text>
        <Text bold>{m.path}</Text>
      </Box>
    )
    const error = m.error !== '' ? <Text color="error">{m.error}</Text> : null
    // rebase 時 ours／theirs 跟直覺相反，提醒一下。
    const rebaseHint =
      v.op === 'rebase' ? (
        <Text dimColor>Rebasing: ours is the branch you are rebasing onto, theirs is your commit being replayed.</Text>
      ) : null

    // 沒有衝突標記可以一段一段選：整個檔案用某一邊，或照目前的樣子標成已解決。
    if (!m.hasMarkers) {
      return (
        <Box flexDirection="column" gap={1}>
          {title}
          {error}
          {rebaseHint}
          <Text dimColor>
            This file has no conflict markers to pick from (one side deleted it, it is binary, or the markers were already
            removed). Choose the whole file:
          </Text>
          {m.isBusy ? (
            <Text dimColor>Working…</Text>
          ) : (
            <Box gap={1} flexWrap="wrap">
              <Button key="merge:take-ours" label="Use ours" onPress={press(() => takeSide($, 'ours'))} />
              <Button key="merge:take-theirs" label="Use theirs" onPress={press(() => takeSide($, 'theirs'))} />
              <Button key="merge:take-as-is" label="Mark resolved as is" onPress={press(() => takeSide($, 'as-is'))} />
              <Button key="merge:claude" label="Ask Claude" onPress={press(() => askClaude($))} />
            </Box>
          )}
        </Box>
      )
    }

    const conflicts = m.chunks.filter(c => c.kind === 'conflict')
    const done = conflicts.filter(c => c.choice !== 'none').length
    const isAllResolved = done === conflicts.length

    // 程式碼一律包一層撐滿整格的 Box：桌面版的 Code 只跟內容一樣寬（有個最小寬度），
    // 短的那幾格會比長的窄；要它跟著撐到整格寬，每一格的程式碼區塊才會一樣寬。
    const code = (lines: string[], startLine?: number) =>
      lines.length === 0 ? (
        <Text dimColor>(nothing)</Text>
      ) : (
        <Box width="100%" flexDirection="column" alignItems="stretch">
          <Code source={lines.join('\n')} path={m.path} startLine={startLine} />
        </Box>
      )

    // 一格：外框的顏色（淡掉的沒框色）、框上一排標籤和按鈕（跟程式碼隔一行）、程式碼。null 是空格子。
    type Cell = { color?: string; isDim?: boolean; bar?: RenderChildren; content: RenderChildren } | null
    // 三欄一列，固定各占 MERGE_COLUMN_WIDTH（剩下的當欄距）。每一格都由這裡包上一樣的外框：
    // 桌面版沒包框的 Code 會比有框的窄一點，全部同一種結構，每一列的欄寬才會一致。
    // 左欄的那排按鈕靠右（靠近中間）、右欄的靠左；同一列的三格一樣高，所以每一段左右對齊。
    const columns = (key: string, cells: RenderChildren[]) => (
      <Box key={key} flexDirection="row" justifyContent="space-between" width="100%">
        {cells.map((cell, i) => (
          <Box key={`${key}:${i}`} flexDirection="column" width={MERGE_COLUMN_WIDTH} flexShrink={0} overflow="hidden">
            {cell}
          </Box>
        ))}
      </Box>
    )
    const BAR_ALIGN = ['flex-end', 'flex-start', 'flex-start'] as const
    const row = (key: string, cells: [Cell, Cell, Cell]) =>
      columns(
        key,
        cells.map((cell, i) =>
          cell === null ? null : (
            <Box
              flexDirection="column"
              alignItems="stretch"
              gap={1}
              paddingX={1}
              borderStyle="round"
              borderColor={cell.color}
              borderDimColor={cell.isDim}
            >
              {cell.bar !== undefined && (
                <Box gap={1} flexWrap="wrap" alignItems="center" justifyContent={BAR_ALIGN[i]}>
                  {cell.bar}
                </Box>
              )}
              {cell.content}
            </Box>
          ),
        ),
      )

    // 三欄各自的下一個行號：左邊照 ours 的檔案算、右邊照 theirs、中間照結果（還沒選的衝突不佔行）。
    const at = { ours: 1, result: 1, theirs: 1 }
    const advance = (ours: number, result: number, theirs: number) => {
      at.ours += ours
      at.result += result
      at.theirs += theirs
    }
    const rows: RenderChildren[] = []
    const sameRows = (key: string, lines: string[]) => {
      const cell = (startLine: number): Cell => ({ isDim: true, content: code(lines, startLine) })
      rows.push(row(key, [cell(at.ours), cell(at.result), cell(at.theirs)]))
      advance(lines.length, lines.length, lines.length)
    }

    m.chunks.forEach((c, k) => {
      if (c.kind === 'same') {
        // 檔頭只留下一段改動前的幾行、檔尾只留上一段改動後的幾行，中間的段落兩頭都留，其餘收起來。
        const head = k === 0 ? 0 : MERGE_CONTEXT
        const tail = k === m.chunks.length - 1 ? 0 : MERGE_CONTEXT
        if (c.lines.length <= head + tail + 1) {
          sameRows(`same:${k}`, c.lines)

          return
        }
        if (head > 0) sameRows(`same:${k}:head`, c.lines.slice(0, head))
        const hidden = c.lines.length - head - tail
        rows.push(
          <Box key={`same:${k}:gap`} justifyContent="center" width="100%">
            <Text dimColor>{`⋯ ${hidden} unchanged line${hidden === 1 ? '' : 's'}`}</Text>
          </Box>,
        )
        advance(hidden, hidden, hidden)
        if (tail > 0) sameRows(`same:${k}:tail`, c.lines.slice(c.lines.length - tail))

        return
      }

      const out = chunkResult(c) ?? []

      // 只有一邊改的（或兩邊改得一樣）：git 會自己合，不用選。改的那邊和中間是藍框，
      // 中間可以 Undo（結果留原本的樣子）再 Apply 回來；沒改的那邊淡掉，顯示原本的樣子。
      if (c.kind === 'auto') {
        const label = c.from === 'both' ? 'Same change on both sides' : `Auto-merged from ${c.from}`
        const side = (lines: string[], startLine: number, isChanged: boolean): Cell =>
          isChanged
            ? { color: 'suggestion', bar: <Text color="suggestion">changed</Text>, content: code(lines, startLine) }
            : lines.length === 0
              ? null
              : { isDim: true, content: code(lines, startLine) }
        const middle: Cell = {
          color: c.isApplied ? 'suggestion' : undefined,
          isDim: !c.isApplied,
          bar: [
            <Text key="state" color={c.isApplied ? 'suggestion' : undefined} dimColor={!c.isApplied}>
              {c.isApplied ? label : `${label} · undone`}
            </Text>,
            <Button
              key={`merge:toggle:${k}`}
              label={c.isApplied ? 'Undo' : 'Apply'}
              onPress={press(() => editChunks($, cs => toggleApplied(cs, k)))}
            />,
          ],
          content: code(out, at.result),
        }
        rows.push(
          row(`auto:${k}`, [side(c.ours, at.ours, c.from !== 'theirs'), middle, side(c.theirs, at.theirs, c.from !== 'ours')]),
        )
        advance(c.ours.length, out.length, c.theirs.length)

        return
      }

      const isOpen = c.choice === 'none'
      const pick = (choice: MergeChoice) => press(() => editChunks($, cs => choose(cs, k, choice)))
      // 還沒選：三格都是紅框。選好了：中間和被選進去的那邊綠框，沒被選的那邊淡掉。
      const side = (which: 'ours' | 'theirs', lines: string[], startLine: number): Cell => {
        const isTaken = takesSide(c.choice, which)

        return {
          color: isOpen ? 'error' : isTaken ? 'success' : undefined,
          isDim: !isOpen && !isTaken,
          bar: (
            <Button
              key={`merge:${which}:${k}`}
              label={which === 'ours' ? 'Accept ≫' : '≪ Accept'}
              dimColor={c.choice === which}
              onPress={pick(which)}
            />
          ),
          content: code(lines, startLine),
        }
      }
      const middle: Cell = {
        color: isOpen ? 'error' : 'success',
        // 只放用得到的按鈕：還沒選時是「兩邊都要」，選好之後只剩 Reset。
        bar: isOpen
          ? [
              <Text key="state" bold color="error">
                Conflict
              </Text>,
              <Button key={`merge:both:${k}`} label="Ours + Theirs" onPress={pick('ours-theirs')} />,
              <Button key={`merge:both-rev:${k}`} label="Theirs + Ours" onPress={pick('theirs-ours')} />,
            ]
          : [
              <Text key="state" bold color="success">
                Resolved
              </Text>,
              <Button key={`merge:reset:${k}`} label="Reset" onPress={pick('none')} />,
            ],
        // 還沒選時中間顯示兩邊改之前的樣子；原本那裡沒有東西，就是兩邊在同一處各自加了內容。
        content: !isOpen ? (
          code(out, at.result)
        ) : c.base === null ? (
          <Text dimColor>Pick a side, or both.</Text>
        ) : c.base.length === 0 ? (
          <Text dimColor>Both sides added lines here. Pick a side, or both.</Text>
        ) : (
          <Box flexDirection="column">
            <Text dimColor>Base (before either side changed it):</Text>
            {code(c.base)}
          </Box>
        ),
      }

      rows.push(row(`conflict:${k}`, [side('ours', c.ours, at.ours), middle, side('theirs', c.theirs, at.theirs)]))
      advance(c.ours.length, out.length, c.theirs.length)
    })

    const columnTitle = (label: string, detail: string, align: 'flex-start' | 'center' | 'flex-end') => (
      <Box justifyContent={align} gap={1}>
        <Text bold>{label}</Text>
        {detail !== '' && <Text dimColor>{detail}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        {title}
        {error}
        {rebaseHint}
        {/* 第二行：進度和上一段／下一段；第三行：整個檔案的動作。 */}
        <Box gap={1} flexWrap="wrap" alignItems="center">
          <Text color={isAllResolved ? 'success' : 'warning'}>{`${done} of ${conflicts.length} conflicts resolved`}</Text>
          {/* 面板拿著鍵盤時按 n／m 也行，跟 , . 一樣左邊往前、右邊往後；桌面版會在按鈕旁標出快捷鍵。 */}
          {conflicts.length > 0 && [
            <Button key="merge:prev" label="↑ Previous" hotkey="n" onPress={press(() => jumpConflict($, -1))} />,
            <Button key="merge:next" label="↓ Next" hotkey="m" onPress={press(() => jumpConflict($, 1))} />,
          ]}
        </Box>
        <Box gap={1} flexWrap="wrap" alignItems="center">
          <Button key="merge:all-ours" label="All ours" onPress={press(() => editChunks($, cs => chooseAll(cs, 'ours')))} />
          <Button key="merge:all-theirs" label="All theirs" onPress={press(() => editChunks($, cs => chooseAll(cs, 'theirs')))} />
          <Button key="merge:claude" label="Ask Claude" onPress={press(() => askClaude($))} />
          {/* 每段衝突都選好才能 Apply；套用中換成文字，不能再按一次。 */}
          {m.isBusy ? (
            <Text dimColor>Applying…</Text>
          ) : isAllResolved ? (
            <Button key="merge:apply" label="Apply & mark resolved" variant="primary" onPress={press(() => applyMerge($))} />
          ) : null}
        </Box>
        <Box flexDirection="column" gap={1}>
          {columns('titles', [
            columnTitle('Ours', m.oursLabel, 'flex-start'),
            columnTitle('Result', '', 'center'),
            columnTitle('Theirs', m.theirsLabel, 'flex-end'),
          ])}
          {rows}
        </Box>
      </Box>
    )
  })
}
