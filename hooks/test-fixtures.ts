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
