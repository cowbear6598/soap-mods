// Services 分頁：找出 session 資料夾底下正在跑的服務，以及停掉、重跑它們。
// 服務 = 有程序在 LISTEN port，而且它的工作目錄或執行檔在 session 資料夾底下；不看是什麼語言。
// 這裡只放純邏輯和 PowerShell 腳本；畫面在 register.tsx。

import type { ScanProc, ScanResult, Service } from '../types'

// 掃描：列出所有程序（含工作目錄）、在 LISTEN 的 port，以及掃描程序自己往上的祖先（就是引擎本身，絕不能列出或停掉）。
// Windows 拿別的程序的工作目錄要讀它的 PEB，所以編一小段 C#，編好的 dll 留在 %TEMP% 下次直接載入。
export const SCAN_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
$src = @'
using System; using System.Runtime.InteropServices;
public static class SoapProcCwd {
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI i, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool b, int p);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out IntPtr r);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr a; public IntPtr Peb; public IntPtr b; public IntPtr c; public IntPtr d; public IntPtr e; }
  static IntPtr Ptr(IntPtr h, long at) { var b = new byte[8]; IntPtr n; if (!ReadProcessMemory(h, new IntPtr(at), b, 8, out n)) return IntPtr.Zero; return new IntPtr(BitConverter.ToInt64(b, 0)); }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x1010, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var i = new PBI(); int r;
      if (NtQueryInformationProcess(h, 0, ref i, Marshal.SizeOf(i), out r) != 0) return null;
      IntPtr pp = Ptr(h, i.Peb.ToInt64() + 0x20); if (pp == IntPtr.Zero) return null;
      var lb = new byte[2]; IntPtr n;
      if (!ReadProcessMemory(h, new IntPtr(pp.ToInt64() + 0x38), lb, 2, out n)) return null;
      int len = BitConverter.ToUInt16(lb, 0);
      IntPtr buf = Ptr(h, pp.ToInt64() + 0x40); if (buf == IntPtr.Zero || len == 0) return null;
      var s = new byte[len]; if (!ReadProcessMemory(h, buf, s, len, out n)) return null;
      return System.Text.Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
'@
$dll = Join-Path $env:TEMP 'soap-mods\proc-cwd-1.dll'
if (-not (Test-Path $dll)) {
  New-Item -ItemType Directory -Force (Split-Path $dll) | Out-Null
  Add-Type -TypeDefinition $src -OutputAssembly $dll
}
Add-Type -Path $dll
$all = @(Get-CimInstance Win32_Process)
$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
$ports = @(Get-NetTCPConnection -State Listen | ForEach-Object { [pscustomobject]@{ port = [int]$_.LocalPort; pid = [int]$_.OwningProcess } })
# 只回報用得到的程序：開著 port 的、它們往上的祖先（往上併要看），以及掃描程序自己往上的祖先。
# 其餘幾百個程序不讀工作目錄、不輸出。
$want = @{}
function Add-Chain([int]$id) {
  $chain = @(); $cur = $byId[$id]
  while ($cur -and -not $want.ContainsKey([int]$cur.ProcessId) -and $chain -notcontains [int]$cur.ProcessId) {
    $want[[int]$cur.ProcessId] = $true; $chain += [int]$cur.ProcessId; $cur = $byId[[int]$cur.ParentProcessId]
  }
  $chain
}
$self = @(Add-Chain $PID)
foreach ($l in $ports) { Add-Chain $l.pid | Out-Null }
$procs = foreach ($id in $want.Keys) {
  $p = $byId[$id]
  [pscustomobject]@{
    pid = $id; ppid = [int]$p.ParentProcessId; name = $p.Name
    cmd = $p.CommandLine; exe = $p.ExecutablePath
    cwd = $(if ($id -gt 4) { [SoapProcCwd]::Get($id) } else { $null })
    started = $(if ($p.CreationDate) { ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() } else { 0 })
  }
}
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[pscustomobject]@{ self = @($self); procs = @($procs); ports = $ports; pids = @($byId.Keys) } | ConvertTo-Json -Compress -Depth 3
`

// 重跑：用 WMI 開，新程序跟引擎、跟這個 PowerShell 完全脫鉤（不繼承任何 handle），隱藏視窗。
// 不存 log：輸出留在那個看不見的主控台裡。參數從環境變數進來，不用處理引號。回傳新程序的 PID。
export const LAUNCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SOAP_CMD; CurrentDirectory = $env:SOAP_DIR; ProcessStartupInformation = $startup }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
$r.ProcessId
`

// powershell -EncodedCommand 吃 UTF-16LE 的 base64。
function encodePowerShell(script: string) {
  let bin = ''
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bin += String.fromCharCode(c & 0xff, c >> 8)
  }

  return btoa(bin)
}

export function powershellArgv(script: string) {
  return ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodePowerShell(script)]
}

// 掃描每 5 秒跑一次，編碼好的指令先備好。
export const SCAN_ARGV = powershellArgv(SCAN_SCRIPT)
export const LAUNCH_ARGV = powershellArgv(LAUNCH_SCRIPT)

function trimSlash(p: string) {
  return p.replace(/[\\/]+$/, '')
}

// 比對路徑用：小寫、反斜線、去掉結尾的斜線。
function normPath(p: string) {
  return trimSlash(p.replace(/\//g, '\\')).toLowerCase()
}

function isUnder(path: string | null, root: string) {
  if (path === null || path === '') return false
  const p = normPath(path)

  return p === root || p.startsWith(`${root}\\`)
}

const SHELLS = ['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'zsh.exe', 'nu.exe']
// 往上併的時候絕不併進去的程式：shell（你開的終端機）、編輯器、IDE、終端機視窗、桌面版 Claude。
// 它們的工作目錄常常也在專案裡，併進去的話「停止」會把它們一起砍掉。
const HOSTS = [
  'explorer.exe',
  'windowsterminal.exe',
  'openconsole.exe',
  'code.exe',
  'code - insiders.exe',
  'cursor.exe',
  'windsurf.exe',
  'devenv.exe',
  'rider64.exe',
  'idea64.exe',
  'webstorm64.exe',
  'goland64.exe',
  'pycharm64.exe',
  'claude.exe',
]

// 不能當成服務的一部分：互動式 shell（cmd /c 這種一次性的包裝除外）和上面那些程式。
function isHost(p: ScanProc) {
  const name = p.name.toLowerCase()

  return HOSTS.includes(name) || (SHELLS.includes(name) && !isCmdWrapper(p))
}

// cmd /c 包一層（npm、npx 跑指令時會這樣）。
function isCmdWrapper(p: ScanProc) {
  return p.name.toLowerCase() === 'cmd.exe' && /\s\/c\s/i.test(p.cmd ?? '')
}

// 照 Windows 的規則粗切 command line：空白分隔，雙引號裡的空白不算。
export function splitArgs(cmd: string) {
  const out: string[] = []
  let cur = ''
  let isQuoted = false
  let hasToken = false
  for (const ch of cmd) {
    if (ch === '"') {
      isQuoted = !isQuoted
      hasToken = true
    } else if (!isQuoted && /\s/.test(ch)) {
      if (hasToken) out.push(cur)
      cur = ''
      hasToken = false
    } else {
      cur += ch
      hasToken = true
    }
  }
  if (hasToken) out.push(cur)

  return out
}

function baseName(p: string) {
  return p.split(/[\\/]/).pop() ?? p
}

// node 跑這些腳本時，顯示成套件管理器的名字（node npm-cli.js run dev → npm run dev）。
const NODE_CLIS: Record<string, string> = {
  'npm-cli.js': 'npm',
  'npx-cli.js': 'npx',
  'pnpm.cjs': 'pnpm',
  'pnpm.js': 'pnpm',
  'yarn.js': 'yarn',
  'yarn.cjs': 'yarn',
}

// 指令拆成工具名稱（去掉路徑和 .exe；node npm-cli.js 算 npm）和後面的參數。
function commandParts(cmd: string) {
  const args = splitArgs(cmd)
  let head = baseName(args[0] ?? '').replace(/\.exe$/i, '')
  let rest = args.slice(1)
  const cli = NODE_CLIS[baseName(rest[0] ?? '').toLowerCase()]
  if (head.toLowerCase() === 'node' && cli !== undefined) {
    head = cli
    rest = rest.slice(1)
  }

  return { head, rest }
}

// 參數裡某個旗標後面那一個值（--project X、-C X）。
function flagValue(rest: string[], ...names: string[]) {
  const i = rest.findIndex(a => names.includes(a))

  return i >= 0 ? rest[i + 1] : undefined
}

// 指名專案本身的檔案：名字就是專案名（InventoryApi.csproj → InventoryApi）。
const PROJECT_FILE = /\.(csproj|fsproj|vbproj|dll|jar)$/i
// 腳本：專案名是它所在的資料夾（node/notify-svc/server.js → notify-svc）。
const SCRIPT_FILE = /\.(m?[jt]sx?|cjs|cts|py|rb|php|go|exs?)$/i

// 面板上一個服務顯示成「工具 · 專案名」：專案名先看指令指到哪（--project、-C、腳本路徑），
// 都沒有就用它跑在哪個資料夾。
export function serviceIdentity(cmd: string, dir: string) {
  const { head, rest } = commandParts(cmd)
  const flag = (...names: string[]) => flagValue(rest, ...names)
  const fromPath = (path: string) => {
    const parts = path.split(/[\\/]/).filter(s => s !== '' && s !== '.')
    const last = parts.at(-1)
    if (last === undefined) return undefined
    if (PROJECT_FILE.test(last)) return last.replace(PROJECT_FILE, '')
    if (SCRIPT_FILE.test(last)) return parts.at(-2)

    return last
  }

  const pkg = head.toLowerCase() === 'cargo' ? flag('-p', '--package') : undefined
  const entry = flag('--project') ?? flag('-C') ?? rest.find(a => PROJECT_FILE.test(a) || SCRIPT_FILE.test(a))
  const name = pkg ?? (entry === undefined ? undefined : fromPath(entry)) ?? baseName(trimSlash(dir))

  return { tool: head, name: name === '' ? head : name }
}

// 從執行檔或腳本路徑猜專案資料夾：切在 node_modules、bin、obj 前面。
function guessDir(path: string) {
  const m = /^(.*?)\\(node_modules|bin|obj)\\/i.exec(path.replace(/\//g, '\\'))

  return m?.[1]
}

// 指令當初是在哪個資料夾下的。go -C <dir> 會自己 cd 進去，讀到的工作目錄多了那一層，重跑前要退回來。
function startDir(top: ScanProc, dir: string) {
  const sub = flagValue(splitArgs(top.cmd ?? ''), '-C')
  const trimmed = trimSlash(dir)
  if (top.name.toLowerCase() !== 'go.exe' || sub === undefined) return trimmed
  const suffix = `\\${normPath(sub)}`

  return normPath(trimmed).endsWith(suffix) ? trimmed.slice(0, trimmed.length - suffix.length) : trimmed
}

// 整理掃描結果：屬於 session 資料夾的程序，往上併到同一個服務（npm → cmd /c → node vite 算一筆），附上 port。
export function findServices(scan: ScanResult, sessionCwd: string): Service[] {
  const root = normPath(sessionCwd)
  const self = new Set(scan.self)
  const byPid = new Map(scan.procs.map(p => [p.pid, p]))
  const children = new Map<number, ScanProc[]>()
  // 父程序比子程序晚開，代表原本的父程序早就結束、PID 被別人拿去用了，不算父子。
  const parentOf = (p: ScanProc) => {
    const parent = byPid.get(p.ppid)
    if (parent === undefined || parent.pid === p.pid || parent.started > p.started) return undefined

    return parent
  }
  for (const p of scan.procs) {
    const parent = parentOf(p)
    if (parent === undefined) continue
    const kids = children.get(parent.pid)
    if (kids === undefined) children.set(parent.pid, [p])
    else kids.push(p)
  }

  // 在專案裡：工作目錄或執行檔在 session 資料夾底下；引擎和那些不能砍的程式除外。
  const inProject = (p: ScanProc) => !self.has(p.pid) && !isHost(p) && (isUnder(p.cwd, root) || isUnder(p.exe, root))

  // 往上爬：父程序也在專案裡就併進去（npm → cmd /c → node vite、go run → go-server.exe 都併成一筆）。
  const topOf = (p: ScanProc) => {
    let cur = p
    for (let parent = parentOf(cur); parent !== undefined && inProject(parent); parent = parentOf(cur)) cur = parent

    return cur
  }

  // 引擎：掃描程序往上第一個不是 shell 的祖先。再往上（例如桌面版 Claude.exe）不算引擎：
  // 桌面版用 .claude/launch.json 開的 dev server 就直接掛在它底下，那些要列出來。
  const engine = scan.self
    .slice(1)
    .map(pid => byPid.get(pid))
    .find(p => p !== undefined && !SHELLS.includes(p.name.toLowerCase()))?.pid
  // 引擎自己直接開的（MCP server 之類，含 npx 外面包的 cmd /c）不是服務。
  const isEngineChild = (top: ScanProc) => {
    let parent = parentOf(top)
    while (parent !== undefined && isCmdWrapper(parent)) parent = parentOf(parent)

    return parent !== undefined && parent.pid === engine
  }

  // 從開著 port 的程序出發，沒開 port 的（language server、背景 script）不算服務。
  // 每個服務記下最上層，和一個開著 port 的程序（顯示名稱要從它往上找）。
  const listening = new Set(scan.ports.map(l => l.pid))
  const tops = new Map<number, { top: ScanProc; listener: ScanProc }>()
  for (const p of scan.procs) {
    if (!listening.has(p.pid) || !inProject(p)) continue
    const top = topOf(p)
    if (!tops.has(top.pid) && !isEngineChild(top)) tops.set(top.pid, { top, listener: p })
  }

  const services = [...tops.values()].map(({ top, listener }): Service => {
    const tree: ScanProc[] = []
    const seen = new Set<number>()
    const walk = (p: ScanProc) => {
      if (seen.has(p.pid)) return
      seen.add(p.pid)
      tree.push(p)
      for (const c of children.get(p.pid) ?? []) walk(c)
    }
    walk(top)
    const pids = new Set(tree.map(p => p.pid))
    const ports = [...new Set(scan.ports.filter(l => pids.has(l.pid)).map(l => l.port))].sort((a, b) => a - b)
    // 重跑就照最上層的指令原樣再跑一次（cmd /c "a && b" 這種包裝也保留）；
    // 顯示的名字則從最上層往開著 port 的那個程序走，取第一個不是 cmd /c 包裝的，名字才不會是 cmd。
    const chain: ScanProc[] = []
    for (let p: ScanProc | undefined = listener; p !== undefined && p !== top; p = parentOf(p)) chain.unshift(p)
    const main = [top, ...chain].find(p => !isCmdWrapper(p)) ?? top
    const foundDir =
      (isUnder(top.cwd, root) ? top.cwd : null) ??
      tree.find(p => isUnder(p.cwd, root))?.cwd ??
      tree.map(p => (p.exe !== null && isUnder(p.exe, root) ? guessDir(p.exe) : undefined)).find(d => d !== undefined) ??
      top.cwd ??
      sessionCwd
    const dir = startDir(top, foundDir)

    return {
      pid: top.pid,
      startedAt: top.started,
      ...serviceIdentity(main.cmd ?? main.exe ?? main.name, dir),
      command: top.cmd ?? '',
      dir,
      ports,
    }
  })

  return services.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name) || a.pid - b.pid)
}
