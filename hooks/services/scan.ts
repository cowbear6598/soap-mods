// Services 分頁：找出 session 資料夾底下正在跑的服務，以及停掉、重跑它們。
// 服務 = 有程序在 LISTEN port，而且它的工作目錄或執行檔在 session 資料夾底下；不看是什麼語言。
// 這裡只放純邏輯和 PowerShell 腳本；動作在 register.tsx，畫面在 ui/tabs/services.tsx。

import type { ScanProc, ScanResult, Service } from '../../types'

// 掃描：列出所有程序（含工作目錄）、在 LISTEN 的 port，以及掃描程序自己往上的祖先（就是引擎本身，絕不能列出或停掉）。
// Windows 拿別的程序的工作目錄要讀它的 PEB，所以編一小段 C#，編好的 dll 留在 %TEMP% 下次直接載入。
const SCAN_SCRIPT = String.raw`
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
# 檔名帶原始碼的 hash：原始碼改了就重新編譯，不會一直載入舊的 dll。
$hash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($src))).Replace('-', '').Substring(0, 16)
$dll = Join-Path $env:TEMP "soap-mods\proc-cwd-$hash.dll"
if (-not (Test-Path $dll)) {
  New-Item -ItemType Directory -Force (Split-Path $dll) | Out-Null
  Add-Type -TypeDefinition $src -OutputAssembly $dll
}
Add-Type -Path $dll
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CommandLine, ExecutablePath, CreationDate)
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
const LAUNCH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SOAP_CMD; CurrentDirectory = $env:SOAP_DIR; ProcessStartupInformation = $startup }
if ($r.ReturnValue -ne 0) { throw "Win32_Process.Create returned $($r.ReturnValue)" }
$r.ProcessId
`

// 停止：砍掉 SOAP_PID 和它底下的整棵程序樹。不用 taskkill /T：它只看父程序 ID，
// 父程序早就結束、PID 被重用時會砍到無關的程序。這裡跟 findServices 一樣，子程序比父程序早開就不算父子。
// 砍完那個 PID 還在就算失敗。
const KILL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = [int]$env:SOAP_PID
$all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate)
$byId = @{}; $kids = @{}
foreach ($p in $all) {
  $byId[[int]$p.ProcessId] = $p
  $pp = [int]$p.ParentProcessId
  if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.ArrayList }
  [void]$kids[$pp].Add($p)
}
if (-not $byId.ContainsKey($root)) { exit 0 }
$tree = New-Object System.Collections.Generic.List[int]
$queue = New-Object System.Collections.Queue
$queue.Enqueue($byId[$root])
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue(); $id = [int]$p.ProcessId
  if ($tree.Contains($id)) { continue }
  $tree.Add($id)
  if (-not $kids.ContainsKey($id)) { continue }
  foreach ($c in $kids[$id]) {
    if ([int]$c.ProcessId -ne $id -and $c.CreationDate -and $p.CreationDate -and $c.CreationDate -ge $p.CreationDate) { $queue.Enqueue($c) }
  }
}
foreach ($id in $tree) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
if (Get-Process -Id $root -ErrorAction SilentlyContinue) { throw "Could not stop process $root." }
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

// 掃描定時跑，編碼好的指令先備好。
export const SCAN_ARGV = powershellArgv(SCAN_SCRIPT)
export const LAUNCH_ARGV = powershellArgv(LAUNCH_SCRIPT)
export const KILL_ARGV = powershellArgv(KILL_SCRIPT)

function trimSlash(p: string) {
  return p.replace(/[\\/]+$/, '')
}

// 比對路徑用：小寫、反斜線、去掉開頭和結尾的斜線（macOS 的 /Users/x 跟拆成段再接回來的 Users\x 才比得起來）。
function normPath(p: string) {
  return trimSlash(p.replace(/\//g, '\\'))
    .replace(/^\\+/, '')
    .toLowerCase()
}

function isUnder(path: string | null, root: string) {
  if (path === null || path === '') return false
  const p = normPath(path)

  return p === root || p.startsWith(`${root}\\`)
}

// path 在 folder 底下（或就是它）；兩邊斜線方向、大小寫不同也算。
export function isInFolder(path: string, folder: string) {
  return isUnder(path, normPath(folder))
}

const SHELLS = [
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'bash.exe',
  'sh.exe',
  'zsh.exe',
  'nu.exe',
  // macOS
  'sh',
  'bash',
  'zsh',
  'fish',
  'nu',
  'dash',
  'login',
  'tmux',
  'screen',
]
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
  // macOS（桌面版和引擎都叫 claude；VS Code、Cursor 這些 Electron 程式的程序叫 Electron 或 xxx Helper）
  'launchd',
  'finder',
  'terminal',
  'iterm2',
  'ghostty',
  'wezterm-gui',
  'alacritty',
  'kitty',
  'warp',
  'electron',
  'code helper',
  'code helper (plugin)',
  'cursor helper',
  'cursor helper (plugin)',
  'idea',
  'webstorm',
  'goland',
  'pycharm',
  'rider',
  'claude',
]

// 不能當成服務的一部分：互動式 shell（cmd /c 這種一次性的包裝除外）和上面那些程式。
function isHost(p: ScanProc) {
  const name = p.name.toLowerCase()

  return HOSTS.includes(name) || (SHELLS.includes(name) && !isCmdWrapper(p))
}

// cmd /c 包一層（npm、npx 跑指令時會這樣）；macOS 上 npm 是用 sh -c 包。
function isCmdWrapper(p: ScanProc) {
  const name = p.name.toLowerCase()

  return (name === 'cmd.exe' && /\s\/c\s/i.test(p.cmd ?? '')) || (name === 'sh' && splitArgs(p.cmd ?? '')[1] === '-c')
}

// 照 Windows 的規則粗切 command line：空白分隔，雙引號裡的空白不算。
function splitArgs(cmd: string) {
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

export function baseName(p: string) {
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
  npm: 'npm',
  npx: 'npx',
  pnpm: 'pnpm',
  yarn: 'yarn',
}

// 工具名稱：指令的第一段，去掉路徑和 .exe；node npm-cli.js 算 npm。
function toolName(cmd: string) {
  const [first = '', second = ''] = splitArgs(cmd)
  const head = baseName(first).replace(/\.exe$/i, '')
  const cli = NODE_CLIS[baseName(second).toLowerCase()]

  return head.toLowerCase() === 'node' && cli !== undefined ? cli : head
}

// 參數裡某個旗標後面那一個值（-C X）。
function flagValue(args: string[], name: string) {
  const i = args.indexOf(name)

  return i >= 0 ? args[i + 1] : undefined
}

// 建置產物、套件、虛擬環境的資料夾：路徑走到這裡就切掉，算它前面那一層（web/node_modules/vite → web、
// api/bin/Debug/Api.exe → api、rs/target/debug → rs）。名稱開頭是 . 的資料夾（.venv、.next）也一樣。
const OUTPUT_DIRS = ['bin', 'obj', 'target', 'build', 'dist', 'out']
const BUILD_DIRS = [...OUTPUT_DIRS, 'node_modules', 'venv', '__pycache__']
// 設定檔：--config conf/dev/app.json 這種不代表專案在哪，不算。
const CONFIG_FILE = /\.(json|ya?ml|env|ini|conf|cfg|properties|xml|txt|log)$/i

// 資料夾路徑拆成一段一段，處理 . 和 ..。
function segments(path: string) {
  const out: string[] = []
  for (const s of path.split(/[\\/]+/)) {
    if (s === '' || s === '.') continue
    if (s === '..') out.pop()
    else out.push(s)
  }

  return out
}

// C:\x，或 macOS 的 /Users/x（至少兩層，cmd 的 /c、/d 開關才不會被當成路徑）。
const isAbsolute = (p: string) => /^[A-Za-z]:[\\/]/.test(p) || /^\/[^\\/\s]+\//.test(p)

// 參數裡看起來像路徑的部分（--flag=值 取值；classpath 用 ; 分開）。網址、glob、Windows 的 /c 開關、
// 沒有斜線的單字（run、dev、app.main:app）都不算。
function pathArgs(args: string[]) {
  return args
    .flatMap(a => (a.includes('=') ? a.slice(a.indexOf('=') + 1) : a).split(';'))
    .filter(a => {
      if (a === '' || /[\s*?<>|"]/.test(a)) return false
      // 冒號只能是磁碟代號（C:\），所以網址、app.main:app 都不算。
      if (a.includes(':')) return isAbsolute(a) && a.indexOf(':', 2) < 0
      if (a === '.' || a === '..' || isAbsolute(a)) return true
      // 相對路徑：要有斜線，而且不是斜線或 - 開頭（/c、/d 是 cmd 的開關）。
      return /[\\/]/.test(a) && !/^[\\/-]/.test(a)
    })
}

// 切在 session 資料夾底下第一個建置產物資料夾前面（skip 是 session 資料夾本身有幾段，那幾段不看）。
function cutBuildDirs(segs: string[], skip: number) {
  const at = segs.findIndex((s, i) => i >= skip && (s.startsWith('.') || BUILD_DIRS.includes(s.toLowerCase())))

  return at < 0 ? segs : segs.slice(0, at)
}

// 面板上的服務名稱：從最上層到開著 port 的那串程序，收集它們碰到的資料夾（工作目錄、執行檔位置、
// 參數裡的路徑），只留 session 資料夾底下的，切掉建置產物那幾層，取最深的那一個的名字。
// 不看是什麼語言：go run ./inventory-service、cargo 的 target/debug/api.exe、IDE 跑 Java 的
// target/classes、dotnet 的 bin/Debug/Api.exe 都會走到專案自己的資料夾。都沒有就是 session 資料夾的名字。
export function serviceName(procs: ScanProc[], sessionCwd: string) {
  const root = normPath(sessionCwd)
  const skip = segments(sessionCwd).length
  // 檔案算它所在的資料夾；最後一段有副檔名就當作檔案（Api.exe、server.js）。
  const fileDir = (segs: string[]) => (/\.[A-Za-z0-9]+$/.test(segs.at(-1) ?? '') ? segs.slice(0, -1) : segs)

  // 越深越好；一樣深時，建置輸出資料夾裡的執行檔（target/debug/api.exe、bin/Debug/Api.exe）優先，
  // 名字用執行檔的名字：cargo workspace 的執行檔都在最外層的 target 裡，只有檔名分得出是哪個服務。
  let best: { depth: number; isProduct: boolean; name: string } | undefined
  const consider = (segs: string[], exeName?: string) => {
    if (!isUnder(segs.join('\\'), root)) return
    const dir = cutBuildDirs(segs, skip)
    // 只算建置輸出（target、bin…）；node_modules、.venv 裡的是工具（esbuild、python），不是服務本身。
    const isProduct = exeName !== undefined && OUTPUT_DIRS.includes(segs[dir.length]?.toLowerCase() ?? '')
    const isBetter =
      best === undefined || dir.length > best.depth || (dir.length === best.depth && isProduct && !best.isProduct)
    if (isBetter) best = { depth: dir.length, isProduct, name: isProduct ? exeName : (dir.at(-1) ?? '') }
  }
  for (const p of procs) {
    if (isCmdWrapper(p)) continue
    if (p.cwd !== null) consider(segments(p.cwd))
    if (p.exe !== null) consider(segments(p.exe).slice(0, -1), baseName(p.exe).replace(/\.[^.]+$/, ''))
    for (const a of pathArgs(splitArgs(p.cmd ?? '').slice(1))) {
      if (CONFIG_FILE.test(a) || (!isAbsolute(a) && p.cwd === null)) continue
      consider(fileDir(segments(isAbsolute(a) ? a : `${p.cwd}\\${a}`)))
    }
  }

  return best?.name || baseName(trimSlash(sessionCwd))
}

// 從執行檔路徑猜專案資料夾：切掉建置產物那幾層；不在建置產物裡就猜不到。
function guessDir(path: string, skip: number) {
  const segs = segments(path)
  const dir = cutBuildDirs(segs, skip)
  if (dir.length >= segs.length) return undefined

  // 重跑要在這裡開，所以接回原本的樣子：macOS 是 /Users/x，Windows 是 C:\x。
  return path.startsWith('/') ? `/${dir.join('/')}` : dir.join('\\')
}

// 指令當初是在哪個資料夾下的。go -C <dir> 會自己 cd 進去，讀到的工作目錄多了那一層，重跑前要退回來。
function startDir(top: ScanProc, dir: string) {
  const sub = flagValue(splitArgs(top.cmd ?? ''), '-C')
  const trimmed = trimSlash(dir)
  if (top.name.toLowerCase().replace(/\.exe$/, '') !== 'go' || sub === undefined) return trimmed
  const suffix = `\\${normPath(sub)}`

  return normPath(trimmed).endsWith(suffix) ? trimmed.slice(0, trimmed.length - suffix.length) : trimmed
}

// 整理掃描結果：屬於 session 資料夾的程序，往上併到同一個服務（npm → cmd /c → node vite 算一筆），附上 port。
export function findServices(scan: ScanResult, sessionCwd: string): Service[] {
  const root = normPath(sessionCwd)
  const skip = segments(sessionCwd).length
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
    // 工具名稱從最上層往開著 port 的那個程序走，取第一個不是 cmd /c 包裝的，名字才不會是 cmd。
    const chain: ScanProc[] = []
    for (let p: ScanProc | undefined = listener; p !== undefined && p !== top; p = parentOf(p)) chain.unshift(p)
    const main = [top, ...chain].find(p => !isCmdWrapper(p)) ?? top
    const tool = toolName(main.cmd ?? main.exe ?? main.name)
    const foundDir =
      (isUnder(top.cwd, root) ? top.cwd : null) ??
      tree.find(p => isUnder(p.cwd, root))?.cwd ??
      tree.map(p => (p.exe !== null && isUnder(p.exe, root) ? guessDir(p.exe, skip) : undefined)).find(d => d !== undefined) ??
      top.cwd ??
      sessionCwd
    const dir = startDir(top, foundDir)

    return {
      pid: top.pid,
      startedAt: top.started,
      tool,
      name: serviceName([top, ...chain], sessionCwd),
      command: top.cmd ?? '',
      dir,
      ports,
    }
  })

  return services.sort((a, b) => a.dir.localeCompare(b.dir) || a.name.localeCompare(b.name) || a.pid - b.pid)
}
