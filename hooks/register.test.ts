import { expect, mock, test } from 'claude-code/testing'

import type { ScanProc, ScanResult } from '../types'
import { fileKind, formatTrack, groupFiles, parseBranches, parseStatus, splitPath, toHunks } from './git'
import { findServices, serviceIdentity, splitArgs } from './services'
import type { DiffHunk } from './merge'
import { buildResult, choose, conflictLabel, detectOp, diffLines, isResolved, keepChoices, merge3, parseConflicts, toggleApplied } from './merge'

// 面板的 props：引擎畫面板時一定會給，測試照實給一份。
const PANE_PROPS = {
  title: 'Soap Panel',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

test('the pane draws the Git tab with its three sub tabs on each surface', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'soap-mods',
      surface,
      component: 'Pane',
      requestId: 'soap-panel',
      props: PANE_PROPS,
    })
    expect(await ui.find({ key: 'tab:git' })).toBeDefined()
    for (const sub of ['diff', 'branch', 'conflict']) {
      expect(await ui.find({ key: `sub:${sub}` })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('the bottom of the pane shows 5h and weekly remaining, half each', async ($, on) => {
  const now = Date.parse('2026-10-09T10:00:00Z')
  on('clock.now', () => ({ value: now }))
  on('session.usage', () => ({
    value: {
      startedAt: now,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-09T12:13:00Z' },
        { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-10-12T13:00:00Z' },
      ],
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
    expect(await ui.find({ key: 'usage:five_hour' })).toBeDefined()
    expect(await ui.find({ key: 'usage:seven_day' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h · ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '77%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly · ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '15%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 2h 13m' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' · 3d 3h 0m' })).toBeDefined()
    await ui.unmount()
  }
})

const ok = (stdout: string) => ({
  value: {
    exitCode: 0,
    stdout,
    stderr: '',
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
})

const SWITCH_FAILED = "fatal: a branch named 'main' already exists"

test('the pane lists changes, shows a diff and the branches, and switches sub tabs', async ($, on) => {
  const diffOpens: string[] = []
  on('ui.open', (_$, e) => {
    if (e.id === 'soap-diff') diffOpens.push(e.title ?? '')

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', (_$, e) => {
    const cmd = e.argv.slice(3)
    if (cmd[0] === 'switch') return { value: { ...ok('').value, exitCode: 128, stderr: SWITCH_FAILED } }
    if (cmd[0] === 'status') return ok('## main...origin/main [ahead 1]\0 M a.ts\0')
    if (cmd[0] === 'diff') return ok('diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n')
    if (cmd[0] === 'for-each-ref') {
      return ok(
        [
          '*\trefs/heads/main\tmain\torigin/main\t\t1 hour ago\tAdd panel',
          ' \trefs/heads/dev\tdev\t\t\t2 days ago\tWip',
          ' \trefs/remotes/origin/main\torigin/main\t\t\t1 hour ago\tAdd panel',
          '',
        ].join('\n'),
      )
    }

    return ok('')
  })
  await $.command.run({
    command: 'soap-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  const ui = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'soap-panel',
    props: PANE_PROPS,
  })
  expect(await ui.find({ key: 'file:unstaged:a.ts' })).toBeDefined()

  // 沒點之前不顯示差異；點了才在自己的面板裡看。
  await ui.press({ key: 'file:unstaged:a.ts' })
  const diff = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'soap-diff',
    props: PANE_PROPS,
  })
  expect(await diff.find({ type: 'Code' })).toBeDefined()
  await diff.unmount()

  // 桌面版整行都是按鈕：同一個 key 疊在整行上面，按下去一樣開差異面板。
  const desk = await $.ui.mount({
    plugin: 'soap-mods',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'soap-panel',
    props: PANE_PROPS,
  })
  expect(await desk.find({ type: 'Text', text: 'a.ts' })).toBeDefined()
  await desk.press({ key: 'file:unstaged:a.ts' })
  await desk.unmount()
  // 同一個檔案點兩次，兩次都是打開（不會變成收起來）。
  expect(diffOpens).toEqual(['a.ts', 'a.ts'])

  await ui.press({ key: 'sub:branch' })
  // 目前分支也算在 Local 裡，跟其他分支一樣是一列按鈕（點了不會被換掉，面板才不會丟焦點）。
  expect(await ui.find({ type: 'Text', text: 'Local · 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '●' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:main' })).toBeDefined()
  expect(await ui.find({ key: 'switch:l:dev' })).toBeDefined()
  // 遠端分支預設收起，按一下才展開。
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeUndefined()
  await ui.press({ key: 'remote:toggle' })
  expect(await ui.find({ key: 'switch:r:origin/main' })).toBeDefined()
  // 切換失敗的訊息顯示在 branch 頁，換分頁就清掉。
  await ui.press({ key: 'switch:r:origin/main' })
  expect(await ui.find({ type: 'Text', text: SWITCH_FAILED })).toBeDefined()
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'sub:branch' })
  expect(await ui.find({ type: 'Text', text: SWITCH_FAILED })).toBeUndefined()

  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: 'No conflicts.' })).toBeDefined()
  await ui.unmount()
})

test('parseStatus reads the branch line, changes, renames and untracked files', () => {
  const out = [
    '## main...origin/main [ahead 1]',
    ' M src/a.ts',
    'A  b c.ts',
    'R  new.ts',
    'old.ts',
    '?? notes.md',
    '',
  ].join('\0')
  const { head, files } = parseStatus(out)
  expect(head).toBe('main...origin/main [ahead 1]')
  expect(files.map(f => f.path)).toEqual(['src/a.ts', 'b c.ts', 'new.ts', 'notes.md'])
  expect(files.map(f => `${f.x}${f.y}`)).toEqual([' M', 'A ', 'R ', '??'])
  // 差異面板的標題和檔案列的狀態字母用同一套分類。
  expect(files.map(fileKind)).toEqual(['modified', 'added', 'renamed', 'added'])
})

test('toHunks drops the diff header and cuts long diffs at a line end', () => {
  const diff = 'diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'
  expect(toHunks(diff)).toEqual({ source: '@@ -1 +1 @@\n-a\n+b\n', isTruncated: false })
  expect(toHunks('Binary files differ').source).toBe('')
  const long = `@@ -1 +1 @@\n${'+x\n'.repeat(40000)}`
  const cut = toHunks(long)
  expect(cut.isTruncated).toBe(true)
  expect(cut.source.endsWith('+x')).toBe(true)
})

test('parseBranches puts the current branch first, locals before remotes, and skips origin/HEAD', () => {
  const out = [
    ' \trefs/heads/zeta\tzeta\t\t\t2 days ago\tlast',
    '*\trefs/heads/main\tmain\torigin/main\t[ahead 1]\t1 hour ago\tAdd panel',
    ' \trefs/remotes/origin/HEAD\torigin\t\t\t1 hour ago\tAdd panel',
    ' \trefs/remotes/origin/main\torigin/main\t\t\t1 hour ago\tAdd panel',
    '',
  ].join('\n')
  const branches = parseBranches(out)
  expect(branches.map(b => b.name)).toEqual(['main', 'zeta', 'origin/main'])
  expect(branches[0]).toMatchObject({ isCurrent: true, isRemote: false, track: '[ahead 1]', subject: 'Add panel' })
  expect(branches[2]?.isRemote).toBe(true)
})

test('groupFiles splits staged, unstaged and untracked, listing a file changed on both sides twice', () => {
  const { files } = parseStatus(['MM both.ts', 'A  new.ts', ' D gone.ts', 'UU clash.ts', '?? notes.md', ''].join('\0'))
  const groups = groupFiles(files)
  const show = (id: 'staged' | 'unstaged' | 'untracked') => groups[id].map(e => `${e.letter} ${e.file.path} ${e.kind}`)
  expect(show('staged')).toEqual(['M both.ts modified', 'A new.ts added'])
  expect(show('unstaged')).toEqual(['M both.ts modified', 'D gone.ts deleted', '! clash.ts conflict'])
  expect(show('untracked')).toEqual(['U notes.md added'])
})

test('splitPath and formatTrack', () => {
  expect(splitPath('hooks/git.ts')).toEqual({ name: 'git.ts', dir: 'hooks' })
  expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' })
  expect(formatTrack('[ahead 1, behind 2]')).toBe('↑1 ↓2')
  expect(formatTrack('[behind 3]')).toBe('↓3')
  expect(formatTrack('[gone]')).toBe('upstream gone')
  expect(formatTrack('')).toBe('')
})

// ───── Services ─────

const ROOT = 'C:\\proj'
const proc = (p: Partial<ScanProc> & Pick<ScanProc, 'pid' | 'ppid' | 'name'>): ScanProc => ({
  cmd: null,
  exe: null,
  cwd: null,
  started: 1000,
  ...p,
})

// 桌面版（Claude.exe 90）開引擎（claude.exe 100）。使用者在專案資料夾開的 PowerShell 跑 npm run dev（npm → cmd /c → node vite）
// 和 cargo run，Claude 的 Bash 跑 dotnet run（dotnet → Api.exe），桌面版的 launch.json 預覽跑 go run；
// 不算的：引擎自己開的 MCP server（直接開的、npx 包一層 cmd /c 的）、別的專案的 node、沒開 port 的 language server。
const SCAN: ScanResult = {
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

test('findServices groups each project process tree, skips the engine and other folders, and adds ports', () => {
  const services = findServices(SCAN, 'C:\\Proj\\')
  expect(services.map(s => [s.pid, s.ports])).toEqual([
    [70, [8081]],
    [50, [4000]],
    [21, [5000, 5001]],
    [15, [7000]],
    [11, [5173]],
  ])
  expect(services.map(s => `${s.tool} · ${s.name}`)).toEqual([
    'go · go-server',
    'node · proj',
    'dotnet · api',
    'cargo · rs',
    'npm · web',
  ])
  // go -C 自己 cd 進去的那一層要退回來，重跑才不會變成 go-server\go-server。
  expect(services[0]?.dir).toBe('C:\\proj')
  expect(services[4]?.command).toContain('npm-cli.js')
  expect(services[4]?.dir).toBe('C:\\proj\\web')
})

test('a service wrapped in cmd /c shows the real tool, and restart reruns the wrapper as is', () => {
  const WRAPPER = 'cmd.exe /d /s /c "set ASPNETCORE_ENVIRONMENT=Development && dotnet run --project dotnet/InventoryApi"'
  const wrapped: ScanResult = {
    self: [],
    pids: [7, 8, 9, 10],
    procs: [
      proc({ pid: 7, ppid: 1, name: 'Claude.exe' }),
      proc({ pid: 8, ppid: 7, name: 'cmd.exe', cmd: WRAPPER, cwd: 'C:\\proj\\' }),
      proc({ pid: 9, ppid: 8, name: 'dotnet.exe', cmd: '"C:\\Program Files\\dotnet\\dotnet.exe" run --project dotnet/InventoryApi', cwd: 'C:\\proj\\', started: 2000 }),
      proc({
        pid: 10,
        ppid: 9,
        name: 'InventoryApi.exe',
        exe: 'C:\\proj\\dotnet\\InventoryApi\\bin\\Debug\\net10.0\\InventoryApi.exe',
        cwd: 'C:\\proj\\dotnet\\InventoryApi\\',
        started: 3000,
      }),
    ],
    ports: [{ port: 5001, pid: 10 }],
  }
  const [s] = findServices(wrapped, 'C:\\proj')
  // 停止砍的是最上層的 cmd（整棵）；名字取裡面真正的程式；重跑照原樣跑 cmd（set 環境變數那段才不會掉）。
  expect(s?.pid).toBe(8)
  expect(s && `${s.tool} · ${s.name}`).toBe('dotnet · InventoryApi')
  expect(s?.command).toBe(WRAPPER)
  expect(s?.dir).toBe('C:\\proj')
  expect(s?.ports).toEqual([5001])
})

test('command helpers', () => {
  expect(splitArgs('"C:\\a b\\x.exe"  run "--x=1 2" y')).toEqual(['C:\\a b\\x.exe', 'run', '--x=1 2', 'y'])
  // 專案名：先看 --project、-C、腳本或專案檔的路徑，都沒有就用資料夾名。
  const id = (cmd: string, dir = 'C:\\proj\\x') => serviceIdentity(cmd, dir)
  expect(id('"C:\\Program Files\\dotnet\\dotnet.exe" run --project dotnet/InventoryApi')).toEqual({ tool: 'dotnet', name: 'InventoryApi' })
  expect(id('dotnet run --project src\\Shop.Api\\Shop.Api.csproj').name).toBe('Shop.Api')
  expect(id('"dotnet" exec "C:\\proj\\api\\bin\\Debug\\net10.0\\dotnet-server.dll"').name).toBe('dotnet-server')
  expect(id('"C:\\Program Files\\Go\\bin\\go.exe" -C go/gateway-svc run .')).toEqual({ tool: 'go', name: 'gateway-svc' })
  expect(id('"C:\\Program Files\\nodejs\\node.exe" node/notify-svc/server.js')).toEqual({ tool: 'node', name: 'notify-svc' })
  expect(id('node server.js', 'C:\\proj\\web\\')).toEqual({ tool: 'node', name: 'web' })
  expect(id('node "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" run dev', 'C:\\proj\\web')).toEqual({ tool: 'npm', name: 'web' })
  expect(id('cargo run -p billing')).toEqual({ tool: 'cargo', name: 'billing' })
  expect(id('python -m uvicorn app.main:app --reload', 'C:\\proj\\py-api')).toEqual({ tool: 'python', name: 'py-api' })
  expect(id('C:\\Users\\me\\.bun\\bin\\bun.exe  run dev ', 'C:\\proj\\web')).toEqual({ tool: 'bun', name: 'web' })
})

test('the Services tab lists the running services and stops one by killing its tree', async ($, on) => {
  const calls: string[][] = []
  on('clock.now', () => ({ value: 1000 + 12 * 60_000 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    calls.push([...e.argv])
    if (e.argv[0] === 'powershell') return ok(JSON.stringify(SCAN))

    return ok('')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
    await ui.press({ key: 'tab:services' })
    // Services 沒有子分頁。
    expect(await ui.find({ key: 'sub:diff' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Running · 5' })).toBeDefined()
    // 一行：工具 · 專案名 · port；不再顯示資料夾、跑了多久、PID。
    expect(await ui.find({ type: 'Text', text: 'npm' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'web' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ':5000 :5001' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /pid/ })).toBeUndefined()
    expect(await ui.find({ key: 'svc:restart:21' })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'svc:stop:21' })
  expect(calls.some(c => c.join(' ') === 'taskkill /PID 21 /T /F')).toBe(true)
  // 引擎自己和它開的程序絕不會被砍。
  expect(calls.some(c => c[0] === 'taskkill' && ['100', '300', '30'].includes(c[2] ?? ''))).toBe(false)
  await ui.press({ key: 'tab:git' })
  expect(await ui.find({ key: 'sub:diff' })).toBeDefined()
  await ui.unmount()
})

test('restart kills the tree, then relaunches the same command in the same folder', async ($, on) => {
  const launches: Record<string, string>[] = []
  const kills: string[] = []
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'taskkill') kills.push(e.argv[2] ?? '')
    if (e.argv[0] === 'powershell' && e.init?.env?.SOAP_CMD !== undefined) {
      launches.push(e.init.env)

      return ok('4321\r\n')
    }
    // 重開的程序 4321 一直活著。
    if (e.argv[0] === 'powershell') return ok(JSON.stringify({ ...SCAN, pids: [...SCAN.pids, 4321] }))

    return ok('')
  })

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'tab:services' })
  await ui.press({ key: 'svc:restart:11' })
  expect(kills).toEqual(['11'])
  expect(launches).toHaveLength(1)
  expect(launches[0]?.SOAP_DIR).toBe('C:\\proj\\web')
  expect(launches[0]?.SOAP_CMD).toContain('npm-cli.js" run dev')
  expect(Object.keys(launches[0] ?? {}).sort()).toEqual(['SOAP_CMD', 'SOAP_DIR'])
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeUndefined()
  await ui.unmount()
})

test('a restart that dies right away says so, and the next scan does not wipe the message', async ($, on) => {
  on('clock.now', () => ({ value: 0 }))
  on('clock.sleep', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: ROOT }))
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'powershell' && e.init?.env?.SOAP_CMD !== undefined) return ok('4321\r\n')
    // 重開的程序 4321 不在活著的 PID 裡：一開就掛了。
    if (e.argv[0] === 'powershell') return ok(JSON.stringify(SCAN))

    return ok('')
  })

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'tab:services' })
  await ui.press({ key: 'svc:restart:11' })
  // 重跑後的檢查在計時器裡跑，等它寫進畫面。
  const failed = /Restart failed: npm · web exited right after starting/
  for (let i = 0; i < 20 && (await ui.find({ type: 'Text', text: failed })) === undefined; i++) await Promise.resolve()
  expect(await ui.find({ type: 'Text', text: failed })).toBeDefined()
  // 定時掃描成功也不能把重跑失敗的提示洗掉。
  await ui.press({ key: 'tab:git' })
  await ui.press({ key: 'tab:services' })
  expect(await ui.find({ type: 'Text', text: /Restart failed/ })).toBeDefined()
  await ui.unmount()
})

// ───── 解衝突 ─────

const CONFLICTED = ['import a', '<<<<<<< HEAD', 'const x = 1', '=======', 'const x = 2', '>>>>>>> feature', 'end', ''].join('\n')
// git 留著的三個版本：1 共同祖先、2 ours、3 theirs（git show :n:path）。
const STAGES: Record<string, string> = {
  ':1:src/a.ts': 'import a\nconst x = 0\nend\n',
  ':2:src/a.ts': 'import a\nconst x = 1\nend\n',
  ':3:src/a.ts': 'import a\nconst x = 2\nend\n',
}
const showStage = (args: readonly string[]) => {
  const blob = STAGES[args[1] ?? '']

  return blob === undefined ? { value: { ...ok('').value, exitCode: 128 } } : ok(blob)
}

test('parseConflicts splits agreed lines from conflicts, with labels, base, CRLF and the final newline', () => {
  const parsed = parseConflicts(CONFLICTED)
  expect(parsed).toEqual({
    chunks: [
      { kind: 'same', lines: ['import a'] },
      { kind: 'conflict', ours: ['const x = 1'], base: null, theirs: ['const x = 2'], choice: 'none' },
      { kind: 'same', lines: ['end'] },
    ],
    eol: '\n',
    hasFinalEol: true,
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
  })

  // diff3：||||||| 後面是共同祖先；CRLF 和沒有結尾換行都照原樣寫回去。
  const diff3 = ['<<<<<<< HEAD', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> dev'].join('\r\n')
  const d = parseConflicts(diff3)
  if (d === null) throw new Error('parse failed')
  expect(d.chunks).toEqual([{ kind: 'conflict', ours: ['a'], base: ['o'], theirs: ['b'], choice: 'none' }])
  expect(d.eol).toBe('\r\n')
  expect(d.hasFinalEol).toBe(false)
  expect(buildResult({ ...d, chunks: choose(d.chunks, 0, 'theirs-ours') })).toBe('b\r\na')

  // 沒有標記、或 <<<<<<< 沒有收尾，都不能一段一段選。
  expect(parseConflicts('plain\ntext\n')).toBeNull()
  expect(parseConflicts('<<<<<<< HEAD\na\n=======\nb\n')).toBeNull()
})

test('buildResult keeps the markers of a conflict still unresolved, and keepChoices carries unchanged conflicts', () => {
  const parsed = parseConflicts(CONFLICTED)
  if (parsed === null) throw new Error('parse failed')
  expect(isResolved(parsed.chunks)).toBe(false)
  expect(buildResult(parsed)).toBe(CONFLICTED)

  const ours = choose(parsed.chunks, 1, 'ours')
  expect(isResolved(ours)).toBe(true)
  expect(buildResult({ ...parsed, chunks: ours })).toBe('import a\nconst x = 1\nend\n')
  expect(buildResult({ ...parsed, chunks: choose(parsed.chunks, 1, 'ours-theirs') })).toBe('import a\nconst x = 1\nconst x = 2\nend\n')

  // 重讀後同一段衝突沒變：保留選擇；內容變了：重新選。
  expect(keepChoices(ours, parsed.chunks)).toEqual(ours)
  const changed = parseConflicts(CONFLICTED.replace('const x = 2', 'const x = 3'))
  if (changed === null) throw new Error('parse failed')
  expect(keepChoices(ours, changed.chunks)).toEqual(changed.chunks)
})

// 照 diffLines 的結果把 a 改一遍，應該剛好變成 b。
function applyHunks(a: string[], b: string[], hunks: DiffHunk[]) {
  const out: string[] = []
  let at = 0
  for (const h of hunks) {
    out.push(...a.slice(at, h.aStart), ...b.slice(h.bStart, h.bEnd))
    at = h.aEnd
  }

  return [...out, ...a.slice(at)]
}

test('diffLines finds the changed places, and applying them turns one list into the other', () => {
  expect(diffLines([], [])).toEqual([])
  expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  expect(diffLines(['a', 'b'], ['a', 'b', 'c'])).toEqual([{ aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 }])
  // 中間夾著沒變的行：是兩個分開的改動。
  expect(diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'c', 'd', 'E'])).toEqual([
    { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    { aStart: 4, aEnd: 5, bStart: 4, bEnd: 5 },
  ])

  // 亂數產生的清單：改完一定變成另一份，而且一行沒變的話一定沒有改動。
  let seed = 7
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)] ?? 'a')
    const b = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)] ?? 'a')
    expect(applyHunks(a, b, diffLines(a, b))).toEqual(b)
    expect(diffLines(a, a)).toEqual([])
  }
})

test('merge3 tells changes one side made from conflicts, as git merges them', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  // 兩邊改不同的地方：各自自動合入。
  const chunks = merge3(base, ['a', 'B', 'c', 'd', 'e', 'f', 'g'], ['a', 'b', 'c', 'd', 'e', 'F', 'g'])
  expect(chunks).toEqual([
    { kind: 'same', lines: ['a'] },
    { kind: 'auto', from: 'ours', base: ['b'], ours: ['B'], theirs: ['b'], isApplied: true },
    { kind: 'same', lines: ['c', 'd', 'e'] },
    { kind: 'auto', from: 'theirs', base: ['f'], ours: ['f'], theirs: ['F'], isApplied: true },
    { kind: 'same', lines: ['g'] },
  ])
  const merged = { chunks, eol: '\n' as const, hasFinalEol: true, oursLabel: '', theirsLabel: '' }
  expect(isResolved(chunks)).toBe(true)
  expect(buildResult(merged)).toBe('a\nB\nc\nd\ne\nF\ng\n')
  // Undo 一個自動合入的改動：結果留原本的樣子。
  expect(buildResult({ ...merged, chunks: toggleApplied(chunks, 1) })).toBe('a\nb\nc\nd\ne\nF\ng\n')

  // 兩邊改得一樣：不算衝突。
  expect(merge3(['a', 'b'], ['a', 'X'], ['a', 'X'])[1]).toEqual({
    kind: 'auto',
    from: 'both',
    base: ['b'],
    ours: ['X'],
    theirs: ['X'],
    isApplied: true,
  })

  // 改到同一行，或緊貼著（一邊改 c、一邊改 d）：衝突，跟 git 一樣。
  expect(merge3(['a', 'b'], ['a', 'X'], ['a', 'Y'])[1]).toEqual({ kind: 'conflict', ours: ['X'], base: ['b'], theirs: ['Y'], choice: 'none' })
  expect(merge3(['a', 'c', 'd', 'z'], ['a', 'C', 'd', 'z'], ['a', 'c', 'D', 'z'])).toEqual([
    { kind: 'same', lines: ['a'] },
    { kind: 'conflict', ours: ['C', 'd'], base: ['c', 'd'], theirs: ['c', 'D'], choice: 'none' },
    { kind: 'same', lines: ['z'] },
  ])

  // 沒有共同祖先（兩邊都新增了這個檔案）：一樣的部分保留，不一樣的每一段都是衝突。
  expect(merge3(null, ['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
    { kind: 'same', lines: ['a'] },
    { kind: 'conflict', ours: ['b'], base: null, theirs: ['x'], choice: 'none' },
    { kind: 'same', lines: ['c'] },
  ])
})

test('detectOp and conflictLabel', () => {
  expect(detectOp(['HEAD', 'MERGE_HEAD', 'index'])).toBe('merge')
  expect(detectOp(['rebase-merge', 'ORIG_HEAD'])).toBe('rebase')
  expect(detectOp(['CHERRY_PICK_HEAD'])).toBe('cherry-pick')
  expect(detectOp(['REVERT_HEAD'])).toBe('revert')
  expect(detectOp(['HEAD'])).toBe('')
  expect(conflictLabel({ path: 'a', x: 'U', y: 'U' })).toBe('both modified')
  expect(conflictLabel({ path: 'a', x: 'D', y: 'U' })).toBe('deleted by us')
  expect(conflictLabel({ path: 'a', x: 'U', y: 'D' })).toBe('deleted by them')
})

type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type TestEngine = Parameters<TestBody>[0]
type TestOn = Parameters<TestBody>[1]

// 停在 merge、src/a.ts 有一段衝突的 repo；git add 之後就沒有衝突了。
function conflictRepo(on: TestOn) {
  const calls: { args: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  let isAdded = false
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.list', () => ({ value: [{ name: 'MERGE_HEAD', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: CONFLICTED }))
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => {
    prompts.push(e.text)

    return { text: e.text }
  })
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3)
    calls.push({ args, cwd: e.init?.cwd, env: e.init?.env })
    if (args[0] === 'status') return ok(isAdded ? '## main\0M  src/a.ts\0' : '## main\0UU src/a.ts\0')
    if (args[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
    if (args[0] === 'show') return showStage(args)
    if (args[0] === 'add') isAdded = true

    return ok('')
  })

  return { calls, writes, prompts }
}

const openPanel = ($: TestEngine) =>
  $.command.run({
    command: 'soap-panel',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

test('the conflict tab lists conflicted files, and the merge pane resolves one, git adds it, then continues', async ($, on) => {
  const { calls, writes } = conflictRepo(on)
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:conflict' })
  expect(await ui.find({ type: 'Text', text: 'Merge in progress' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Conflicts · 1' })).toBeDefined()
  // 還有衝突時不能 continue。
  expect(await ui.find({ key: 'op:continue' })).toBeUndefined()
  await ui.press({ key: 'conflict:src/a.ts' })

  // 三欄在兩種畫面上都畫得出來。
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'soap-mods', surface, component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
    expect(await pane.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
    expect(await pane.find({ key: 'merge:ours:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:theirs:1' })).toBeDefined()
    expect(await pane.find({ key: 'merge:both:1' })).toBeDefined()
    // 只畫用得到的按鈕：還沒選時沒有 Reset，還有衝突時沒有 Apply。
    expect(await pane.find({ key: 'merge:reset:1' })).toBeUndefined()
    expect(await pane.find({ key: 'merge:apply' })).toBeUndefined()
    await pane.unmount()
  }

  const pane = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
  await pane.press({ key: 'merge:ours:1' })
  expect(await pane.find({ type: 'Text', text: '1 of 1 conflicts resolved' })).toBeDefined()
  // 選好之後中間只剩 Reset，Apply 出現。
  expect(await pane.find({ key: 'merge:both:1' })).toBeUndefined()
  expect(await pane.find({ key: 'merge:apply' })).toBeDefined()
  await pane.press({ key: 'merge:reset:1' })
  expect(await pane.find({ type: 'Text', text: '0 of 1 conflicts resolved' })).toBeDefined()
  await pane.press({ key: 'merge:both:1' })
  await pane.press({ key: 'merge:apply' })
  await pane.unmount()

  // 寫回 repo 根目錄底下的檔案，在根目錄 git add。
  // Windows 上引擎會把路徑轉成反斜線。
  expect(writes.map(w => ({ ...w, path: w.path.replace(/\\/g, '/') }))).toEqual([
    { path: 'C:/repo/src/a.ts', text: 'import a\nconst x = 1\nconst x = 2\nend\n' },
  ])
  expect(calls.some(c => c.args.join(' ') === 'add -- src/a.ts' && c.cwd === 'C:/repo')).toBe(true)

  // 衝突都解完了：可以 continue，merge 是直接用預設訊息 commit、不開編輯器。
  expect(await ui.find({ type: 'Text', text: 'All conflicts resolved.' })).toBeDefined()
  await ui.press({ key: 'op:continue' })
  const commit = calls.find(c => c.args.join(' ') === 'commit --no-edit')
  expect(commit?.env).toEqual({ GIT_EDITOR: 'true' })
  await ui.unmount()
})

test('abort asks once more before running, and Ask Claude sends the file to the model', async ($, on) => {
  const { calls, prompts } = conflictRepo(on)
  await openPanel($)

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'terminal', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args[1] === '--abort')).toBe(false)
  expect(await ui.find({ key: 'op:abort-cancel' })).toBeDefined()
  await ui.press({ key: 'op:abort-cancel' })
  expect(await ui.find({ key: 'op:abort-cancel' })).toBeUndefined()

  await ui.press({ key: 'conflict:src/a.ts' })
  const pane = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
  await pane.press({ key: 'merge:claude' })
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('`src/a.ts`')
  await pane.unmount()

  await ui.press({ key: 'op:abort' })
  await ui.press({ key: 'op:abort' })
  expect(calls.some(c => c.args.join(' ') === 'merge --abort' && c.cwd === 'C:/repo')).toBe(true)
  await ui.unmount()
})

test('a pane brought to the front, or one whose pressed button was swapped out, gets the keyboard back', async ($, on) => {
  const clock = mock.clock(on)
  const pane = (id: string, isShown: boolean, isFocused: boolean) => ({ id, title: id, isShown, isFocused, isPlaced: true })
  let panes = [pane('soap-panel', true, false)]
  const focused: string[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => {
    if (e.focus === true) focused.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.list', () => ({ value: [{ name: 'MERGE_HEAD', kind: 'file', size: 0, mtimeMs: 0, isLink: false }] }))
  on('fs.read', () => ({ value: CONFLICTED }))
  on('process.run', (_$, e) => {
    const args = e.argv.slice(3)
    if (args[0] === 'status') return ok('## main\0UU src/a.ts\0')
    if (args[0] === 'rev-parse') return ok('C:/repo\nC:/repo/.git\n')
    if (args[0] === 'show') return showStage(args)

    return ok('')
  })
  await $.session.start({ cwd: 'C:/repo', surface: 'desktop', isInteractive: true })

  // 剛啟動時 Soap Panel 在前面但沒焦點：不搶（人可能正在輸入框打字）。
  await clock.advance(200)
  expect(focused).toEqual([])

  const ui = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-panel', props: PANE_PROPS })
  await ui.press({ key: 'sub:conflict' })
  await ui.press({ key: 'conflict:src/a.ts' })
  await ui.unmount()
  focused.length = 0

  // 合併面板被切到前面、沒拿到焦點：補給它。
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, false)]
  await clock.advance(200)
  expect(focused).toEqual(['soap-merge'])
  focused.length = 0

  // 按了 Accept，被按的按鈕被換掉而丟了焦點：剛按完的一小段時間內補回來。
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, true)]
  const merge = await $.ui.mount({ plugin: 'soap-mods', surface: 'desktop', component: 'Pane', requestId: 'soap-merge', props: PANE_PROPS })
  await merge.press({ key: 'merge:ours:1' })
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, false)]
  await clock.advance(200)
  expect(focused).toEqual(['soap-merge'])
  focused.length = 0

  // 過了那段時間才丟焦點（人自己點去輸入框）：不搶回來。
  await clock.advance(1000)
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, true)]
  await clock.advance(200)
  panes = [pane('soap-panel', false, false), pane('soap-merge', true, false)]
  await clock.advance(200)
  expect(focused).toEqual([])
  await merge.unmount()
})
