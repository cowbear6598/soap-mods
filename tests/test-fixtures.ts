// 測試共用的資料：純邏輯的測試和面板的測試都用。

import type { ScanProc, ScanResult } from '../types'

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
export const MAC_EPOCH = Date.UTC(2026, 9, 12, 2, 0, 0) / 1000
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
#args
    1 /sbin/launchd
   80 /Applications/Claude.app/Contents/MacOS/Claude
  100 claude
  900 /bin/sh -c echo
   10 -zsh
   11 npm run dev
   12 sh -c vite
   13 node /Users/me/proj/web/node_modules/.bin/vite
   30 node mcp-server.js
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
