// 測試共用的資料和 helper。

import type { test } from 'claude-code/testing'

import type { ScanProc, ScanResult } from '../types'

type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
export type TestEngine = Parameters<TestBody>[0]
export type TestOn = Parameters<TestBody>[1]

// ───── 面板測試的 helper ─────

// 面板的 props：引擎畫面板時一定會給，測試照實給一份。
const PANE_PROPS = {
  title: 'Soap Panel',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

// 面板打開時在 Files 分頁；測試大多從 Git 開始，掛上後先按到 Git。tab 給 'files' 就停在打開時的樣子。
export async function mountPane($: TestEngine, surface: 'terminal' | 'desktop' = 'terminal', tab: 'git' | 'files' = 'git') {
  const ui = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  if (tab === 'git') await ui.press({ key: 'tab:git' })

  return ui
}

export type Pane = Awaited<ReturnType<typeof mountPane>>

// 打開 Tools 分頁的一個子分頁（Services、DB、HTTP）。
export async function openTool(ui: Pane, sub: 'services' | 'db' | 'http') {
  await ui.press({ key: 'tab:tools' })
  await ui.press({ key: `sub:${sub}` })
}

// 使用者打 /soap-mods:open 打開面板。
export const openPanel = ($: TestEngine) =>
  $.command.run({ command: 'soap-mods:open', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

// 面板開起來要的引擎回應：開／列／關 pane（打開了就在前面）、session 資料夾（給函式就每次問它）、時間、回合結束。now 給 null：測試自己用 mock.clock
// （clock.now 先登記的算數，兩個都登記的話 mock.clock 推不動時間）。
export function stubPanel(on: TestOn, { root = '/repo', now = 0 }: { root?: string | (() => string); now?: number | null } = {}) {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'soap-panel', title: 'Soap Panel', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.close', () => ({ value: undefined }))
  on('session.root', () => ({ value: typeof root === 'string' ? root : root() }))
  on('turn.complete', () => ({ text: '' }))
  if (now !== null) on('clock.now', () => ({ value: now }))
}

// 跳過的 toast，照順序。
export function recordToasts(on: TestOn) {
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return toasts
}

// $.store 放在記憶體裡的 store（key → 值），測試讀它看存了什麼。
export function stubStore(on: TestOn, store: Record<string, unknown>) {
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    delete store[e.key]

    return { value: undefined }
  })
}

// Claude 的一個回合結束：面板在背景重讀看得到的東西，重畫一次等它讀完、畫好。要先 stubPanel。
export async function endTurn($: TestEngine, ui: Pane) {
  await $.turn.complete({ answer: '', reason: 'answer', durationMs: 0, isAborted: false, turnId: 'turn' })
  await ui.redraw()
}

// 引擎會把 fs、process 的路徑轉成這台電腦的絕對路徑（Windows 加磁碟代號、換反斜線），比對前轉回 /repo 這種寫法。
export const posix = (p: string | undefined) => p?.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// process.run 的結果：成功印出 stdout；失敗印出 stderr。
export const ok = (stdout: string) => ({
  value: {
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})
export const fail = (stderr: string, exitCode = 128) => ({ value: { ...ok('').value, exitCode, stderr } })

type RunResult = ReturnType<typeof ok>
type RunEvent = { argv: readonly string[]; init?: { cwd?: string; env?: Record<string, string>; stdin?: string } }

// macOS 的 Keychain：一張表（account → 存進去的十六進位），counts.reads 是印出機密（-w）的次數。不是 security 的指令回 undefined，交給呼叫的人。
export function fakeKeychain(items: Record<string, string> = {}) {
  const counts = { reads: 0 }
  const run = (e: RunEvent): RunResult | undefined => {
    const [cmd, sub] = e.argv
    if (cmd !== 'security') return undefined
    const account = e.argv[e.argv.indexOf('-a') + 1] ?? ''
    if (sub === '-i') {
      const [, id = '', hex = ''] = /-a (\S+)(?: -T "")? -w (\S+)/.exec(e.init?.stdin ?? '') ?? []
      items[id] = hex

      return ok('')
    }
    if (sub === 'find-generic-password') {
      const hex = items[account]
      if (hex === undefined) return fail('The specified item could not be found in the keychain.', 44)
      if (!e.argv.includes('-w')) return ok('keychain: "login.keychain-db"\n')
      counts.reads += 1

      return ok(`${hex}\n`)
    }
    if (sub === 'delete-generic-password') {
      delete items[account]

      return ok('')
    }

    return undefined
  }

  return { items, counts, run }
}

// session 資料夾 /repo 就是一個 git repo：status 是 git status 印出的（會變的話給函式）、branches 是 for-each-ref 的每一行（branchLine）。
// run 先看每個 git 指令（cmd 從子指令開始），給了結果就用它的，沒給就照上面的回。
export function gitRepo(
  on: TestOn,
  repo: { status: string | (() => string); branches?: string[] | (() => string[]); run?: (cmd: string[], e: RunEvent) => RunResult | Promise<RunResult> | undefined },
) {
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    const own = repo.run?.(cmd, e)
    if (own !== undefined) return own
    if (cmd[0] === 'rev-parse') return ok('/repo\n/repo/.git\n')
    if (cmd[0] === 'status') return ok(typeof repo.status === 'function' ? repo.status() : repo.status)
    if (cmd[0] === 'for-each-ref') {
      const branches = typeof repo.branches === 'function' ? repo.branches() : (repo.branches ?? [])

      return ok([...branches, ''].join('\n'))
    }

    return ok('')
  })
}

// git for-each-ref 印出的一行分支：目前分支標 *，origin/ 開頭的是遠端分支。
export const branchLine = (
  name: string,
  { isCurrent = false, upstream = '', track = '', ago = '1 day ago', subject = 'Wip' }: { isCurrent?: boolean; upstream?: string; track?: string; ago?: string; subject?: string } = {},
) => [isCurrent ? '*' : ' ', `refs/${name.startsWith('origin/') ? 'remotes' : 'heads'}/${name}`, name, upstream, track, ago, subject].join('\t')

// http.fetch 的結果：body 不是字串就轉成 JSON。
export const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  value: { status, ok: status >= 200 && status < 300, headers, text: typeof body === 'string' ? body : JSON.stringify(body) },
})

// fs.list 列出的一筆。
export const fsEntry = (name: string, kind: 'file' | 'dir' | 'other' = 'file', size = 0) => ({ name, kind, size, mtimeMs: 0, isLink: false })

// 計時器裡跑的工作要多等幾輪才寫進畫面：一直找到為止（最多 tries 輪）。
export async function waitFor<T>(find: () => Promise<T | undefined>, tries = 20): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const found = await find()
    if (found !== undefined) return found
    await Promise.resolve()
  }

  return find()
}

// ───── 資料 ─────

export const ROOT = 'C:\\proj'
export const proc = (p: Partial<ScanProc> & Pick<ScanProc, 'pid' | 'ppid' | 'name'>): ScanProc => ({
  cmd: null,
  exe: null,
  cwd: null,
  started: 1000,
  ...p,
})

// 桌面版（Claude.exe 90）開引擎（claude.exe 100）。使用者在專案資料夾開的 PowerShell 跑 npm run dev（npm → cmd /c → node vite）
// 和 cargo run，Claude 的 Bash 跑 dotnet run（dotnet → Api.exe），桌面版的 launch.json 預覽跑 go run；
// 不算的：引擎自己開的 MCP server（直接開的、npx 包一層 cmd /c 的）、別的專案的 node、沒開 port 的 language server。
export const SCAN: ScanResult = {
  self: [300, 100, 90, 1],
  pids: [],
  procs: [
    proc({ pid: 1, ppid: 0, name: 'explorer.exe' }),
    proc({ pid: 90, ppid: 1, name: 'Claude.exe' }),
    proc({ pid: 100, ppid: 90, name: 'claude.exe' }),
    proc({ pid: 70, ppid: 90, name: 'go.exe', cmd: '"C:\\Program Files\\Go\\bin\\go.exe" -C go-server run .', cwd: 'C:\\proj\\go-server\\' }),
    proc({
      pid: 71,
      ppid: 70,
      name: 'go-server.exe',
      exe: 'C:\\Temp\\go-build1\\b001\\exe\\go-server.exe',
      cmd: 'C:\\Temp\\go-build1\\b001\\exe\\go-server.exe',
      cwd: 'C:\\proj\\go-server\\',
      started: 2000,
    }),
    proc({ pid: 80, ppid: 100, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c npx some-mcp' }),
    proc({ pid: 81, ppid: 80, name: 'node.exe', cmd: 'node some-mcp.js', cwd: 'C:\\proj\\', started: 2000 }),
    proc({ pid: 300, ppid: 100, name: 'powershell.exe' }),
    // 使用者的終端機：工作目錄也在專案裡，但絕不能被併進服務（不然「停止」會砍掉它）。
    proc({ pid: 10, ppid: 1, name: 'powershell.exe', cwd: 'C:\\proj\\' }),
    proc({ pid: 15, ppid: 10, name: 'cargo.exe', cmd: 'cargo run', cwd: 'C:\\proj\\rs\\' }),
    proc({
      pid: 16,
      ppid: 15,
      name: 'app.exe',
      cmd: 'target\\debug\\app.exe',
      exe: 'C:\\proj\\rs\\target\\debug\\app.exe',
      cwd: 'C:\\proj\\rs\\',
      started: 2000,
    }),
    proc({ pid: 55, ppid: 1, name: 'node.exe', cmd: 'node tsserver.js', cwd: 'C:\\proj\\' }),
    proc({
      pid: 11,
      ppid: 10,
      name: 'node.exe',
      cmd: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev',
      cwd: 'C:\\proj\\web\\',
    }),
    proc({ pid: 12, ppid: 11, name: 'cmd.exe', cmd: 'C:\\WINDOWS\\system32\\cmd.exe /d /s /c vite', cwd: 'C:\\proj\\web\\' }),
    proc({
      pid: 13,
      ppid: 12,
      name: 'node.exe',
      cmd: '"C:\\Program Files\\nodejs\\node.exe" C:\\proj\\web\\node_modules\\vite\\bin\\vite.js',
      cwd: 'C:\\proj\\web\\',
    }),
    proc({ pid: 20, ppid: 100, name: 'bash.exe', cmd: 'bash.exe -c "dotnet run"' }),
    proc({ pid: 21, ppid: 20, name: 'dotnet.exe', cmd: '"C:\\Program Files\\dotnet\\dotnet.exe" run', cwd: 'C:\\Proj\\api\\', started: 2000 }),
    proc({
      pid: 22,
      ppid: 21,
      name: 'Api.exe',
      cmd: 'C:\\proj\\api\\bin\\Debug\\net8.0\\Api.exe',
      exe: 'C:\\proj\\api\\bin\\Debug\\net8.0\\Api.exe',
      started: 3000,
    }),
    proc({ pid: 30, ppid: 100, name: 'node.exe', cmd: 'node mcp-server.js', cwd: 'C:\\proj\\' }),
    proc({ pid: 40, ppid: 10, name: 'node.exe', cmd: 'node server.js', cwd: 'C:\\other\\' }),
    // PID 50 的父程序 PID 60 比它晚開：原本的父程序早就結束、PID 被拿去用了，不能往上併。
    proc({ pid: 60, ppid: 1, name: 'node.exe', cmd: 'node unrelated.js', cwd: 'C:\\elsewhere', started: 9000 }),
    proc({ pid: 50, ppid: 60, name: 'node.exe', cmd: 'node server.js', cwd: 'C:\\proj\\', started: 5000 }),
  ],
  ports: [
    { port: 5173, pid: 13 },
    { port: 5000, pid: 22 },
    { port: 5001, pid: 22 },
    { port: 5000, pid: 22 },
    { port: 9999, pid: 30 },
    { port: 3000, pid: 40 },
    { port: 8081, pid: 71 },
    { port: 9998, pid: 81 },
    { port: 4000, pid: 50 },
    { port: 7000, pid: 16 },
  ],
}
SCAN.pids = SCAN.procs.map(p => p.pid)

// 停在 merge、有一段衝突的檔案。
export const CONFLICTED = ['import a', '<<<<<<< HEAD', 'const x = 1', '=======', 'const x = 2', '>>>>>>> feature', 'end', ''].join('\n')

// macOS：桌面版（Claude 80）開引擎（claude 100），引擎用 /bin/sh 900 掃描。使用者在終端機（-zsh 10）跑
// npm run dev（npm → sh -c vite → node vite）；引擎自己開的 MCP server（node 30）不算。
// 第二行是同一刻的本地時間和 epoch（這裡時區是 +8）。
export const MAC_ROOT = '/Users/me/proj'
const MAC_EPOCH = Date.UTC(2026, 9, 12, 2, 0, 0) / 1000
export const MAC_SCAN_OUT = `900
2026 10 12 10 00 00 ${MAC_EPOCH}
#comm
    1     0 Tue Oct  6 15:08:47 2026     /sbin/launchd
   80     1 Mon Oct 12 09:00:00 2026     /Applications/Claude.app/Contents/MacOS/Claude
  100    80 Mon Oct 12 09:00:01 2026     /Users/me/Library/Application Support/Claude/claude-code/2.1.295/claude.app/Contents/MacOS/claude
  900   100 Mon Oct 12 10:00:00 2026     /bin/sh
   10     1 Mon Oct 12 09:10:00 2026     -zsh
   11    10 Mon Oct 12 09:20:00 2026     node
   12    11 Mon Oct 12 09:20:01 2026     /bin/sh
   13    12 Mon Oct 12 09:20:01 2026     node
   30   100 Mon Oct 12 09:00:02 2026     node
#ports
p13
f20
n*:5173
f21
n[::1]:5173
p30
f22
n127.0.0.1:9999
`
// 第二步的 ps -o pid=,args=：只問用得到的那幾個程序。
export const MAC_ARGS_OUT = `   10 -zsh
   11 npm run dev
   12 sh -c vite
   13 node /Users/me/proj/web/node_modules/.bin/vite
   30 node mcp-server.js
   80 /Applications/Claude.app/Contents/MacOS/Claude
  100 claude
  900 /bin/sh -c echo
`
const NODE = '/Users/me/.nvm/versions/node/v24.14.0/bin/node'
export const MAC_FILES_OUT = [
  ...['p10', 'fcwd', `n${MAC_ROOT}`, 'ftxt', 'n/bin/zsh'],
  ...['p11', 'fcwd', `n${MAC_ROOT}/web`, 'ftxt', `n${NODE}`, 'ftxt', 'n/usr/lib/dyld'],
  ...['p12', 'fcwd', `n${MAC_ROOT}/web`, 'ftxt', 'n/bin/sh'],
  ...['p13', 'fcwd', `n${MAC_ROOT}/web`, 'ftxt', `n${NODE}`],
  ...['p30', 'fcwd', `n${MAC_ROOT}`, 'ftxt', `n${NODE}`],
  '',
].join('\n')
// ps -o pid=,ppid=,lstart=：npm 那棵樹底下還有一個 esbuild（99）。77 的父程序是 13，但比 13 早開：
// 原本的父程序早就結束、PID 被 13 拿去用了，不是 npm 的子孫。
export const MAC_PPIDS_OUT = [
  '    1     0 Tue Oct  6 15:08:47 2026',
  '   11    10 Mon Oct 12 09:20:00 2026',
  '   12    11 Mon Oct 12 09:20:01 2026',
  '   13    12 Mon Oct 12 09:20:01 2026',
  '   99    13 Mon Oct 12 09:20:05 2026',
  '   77    13 Mon Oct 12 08:00:00 2026',
  '   30   100 Mon Oct 12 09:00:02 2026',
  '',
].join('\n')
