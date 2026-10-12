// Services 分頁的 macOS 版：用 ps 和 lsof 掃，用 kill 停，用 sh 在背景重開。
// 掃出來的格式跟 Windows 一樣是 ScanResult，後面找服務（findServices）兩邊共用。

import type { ScanProc, ScanResult } from '../../types'

// ps 的 lstart 要英文月份，lsof、ps 的輸出也不要被翻譯。
export const MAC_ENV = { LC_ALL: 'C' }

// 掃描第一步：自己的 PID（往上的祖先就是引擎）、現在的時間、所有程序、在 LISTEN 的 port。
// comm（執行檔）和 args（指令）都可能有空白，分兩次 ps 才切得開。
const SCAN_SCRIPT = `
echo "$$"
date '+%Y %m %d %H %M %S %s'
echo '#comm'
ps -axww -o pid=,ppid=,lstart=,comm=
echo '#args'
ps -axww -o pid=,args=
echo '#ports'
lsof -nP -iTCP -sTCP:LISTEN -Fpn
exit 0
`

export const MAC_SCAN_ARGV = ['/bin/sh', '-c', SCAN_SCRIPT]

// 掃描第二步：只讀用得到的程序的工作目錄和執行檔（lsof 第一個 txt 就是執行檔）。
export function macFilesArgv(pids: number[]) {
  return ['lsof', '-a', '-nP', '-d', 'cwd,txt', '-p', pids.join(','), '-Fpfn']
}

// 停止前列出所有程序的父子關係，找出整棵樹。
export const MAC_PPIDS_ARGV = ['ps', '-axo', 'pid=,ppid=']

// 重跑：nohup 在背景開，輸入輸出都接到 /dev/null，這個 sh 一結束新程序就跟引擎脫鉤。
// 參數從環境變數進來，不用處理引號。回傳新程序的 PID。
export const MAC_LAUNCH_ARGV = [
  '/bin/sh',
  '-c',
  'cd "$SOAP_DIR" || exit 1\nnohup /bin/sh -c "$SOAP_CMD" </dev/null >/dev/null 2>&1 &\necho "$!"',
]

const LSTART = /^\s*(\d+)\s+(\d+)\s+\w{3}\s+(\w{3})\s+(\d+)\s+(\d+):(\d+):(\d+)\s+(\d+)\s+(.*)$/
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function baseName(p: string) {
  return p.split('/').pop() ?? p
}

// 掃描第一步的輸出 → 所有程序（工作目錄、執行檔先空著）、port、自己往上的祖先。
export function parseMacScan(out: string): ScanResult {
  const lines = out.split('\n')
  const selfPid = Number(lines[0])
  // lstart 是本地時間：拿同一刻的本地時間和 epoch 算出時差，跟執行環境的時區無關。
  const [y, mo, d, h, mi, s, epoch] = (lines[1] ?? '').trim().split(/\s+/).map(Number)
  const offset = (epoch ?? 0) * 1000 - Date.UTC(y ?? 0, (mo ?? 1) - 1, d, h, mi, s)

  const byPid = new Map<number, ScanProc>()
  const cmds = new Map<number, string>()
  const ports: ScanResult['ports'] = []
  let section = ''
  let portPid = 0
  for (const line of lines.slice(2)) {
    if (line.startsWith('#')) {
      section = line
      continue
    }
    if (section === '#comm') {
      const m = LSTART.exec(line)
      if (m === null) continue
      const [, pid, ppid, mon, day, hh, mm, ss, year, comm = ''] = m
      const started = Date.UTC(Number(year), MONTHS.indexOf(mon ?? ''), Number(day), Number(hh), Number(mm), Number(ss)) + offset
      // 登入 shell 的名字前面有 -（-zsh）。
      const name = baseName(comm.trim()).replace(/^-/, '')
      byPid.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), name, cmd: null, exe: null, cwd: null, started })
    } else if (section === '#args') {
      const m = /^\s*(\d+)\s(.*)$/.exec(line)
      if (m !== null) cmds.set(Number(m[1]), (m[2] ?? '').trim())
    } else if (section === '#ports') {
      if (line.startsWith('p')) portPid = Number(line.slice(1))
      // n*:5173、n127.0.0.1:5173、n[::1]:5173：port 是最後一個冒號後面。
      if (line.startsWith('n')) {
        const port = Number(line.slice(line.lastIndexOf(':') + 1))
        if (port > 0 && !ports.some(p => p.pid === portPid && p.port === port)) ports.push({ port, pid: portPid })
      }
    }
  }
  for (const [pid, cmd] of cmds) {
    const p = byPid.get(pid)
    if (p !== undefined) p.cmd = cmd
  }

  const chain = (pid: number) => {
    const out: number[] = []
    for (let p = byPid.get(pid); p !== undefined && !out.includes(p.pid); p = byPid.get(p.ppid)) out.push(p.pid)

    return out
  }

  return { self: chain(selfPid), procs: [...byPid.values()], ports, pids: [...byPid.keys()] }
}

// 只留用得到的程序：開著 port 的、它們往上的祖先（往上併要看），以及掃描程序自己往上的祖先。
export function wantedPids(scan: ScanResult) {
  const byPid = new Map(scan.procs.map(p => [p.pid, p]))
  const want = new Set(scan.self)
  for (const { pid } of scan.ports) {
    for (let p = byPid.get(pid); p !== undefined && !want.has(p.pid); p = byPid.get(p.ppid)) want.add(p.pid)
  }

  return [...want].filter(pid => pid > 1).sort((a, b) => a - b)
}

// 掃描第二步的輸出 → 每個程序的工作目錄和執行檔。別人的程序（root 跑的）讀不到，就不會出現。
export function parseMacFiles(out: string) {
  const files = new Map<number, { cwd: string | null; exe: string | null }>()
  let cur: { cwd: string | null; exe: string | null } | undefined
  let fd = ''
  for (const line of out.split('\n')) {
    const value = line.slice(1)
    if (line.startsWith('p')) {
      cur = { cwd: null, exe: null }
      files.set(Number(value), cur)
    } else if (line.startsWith('f')) {
      fd = value
    } else if (line.startsWith('n') && cur !== undefined) {
      if (fd === 'cwd') cur.cwd = value
      else if (fd === 'txt' && cur.exe === null) cur.exe = value
    }
  }

  return files
}

// 把工作目錄和執行檔填回去，只留用得到的程序。
export function withFiles(scan: ScanResult, want: number[], files: Map<number, { cwd: string | null; exe: string | null }>): ScanResult {
  const keep = new Set(want)
  const procs = scan.procs.filter(p => keep.has(p.pid)).map(p => ({ ...p, ...files.get(p.pid) }))

  return { ...scan, procs }
}

// pid 和它底下所有的子孫（停止要砍整棵樹）。
export function descendants(psOut: string, pid: number) {
  const children = new Map<number, number[]>()
  for (const line of psOut.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child === undefined || parent === undefined || Number.isNaN(child) || Number.isNaN(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const out: number[] = []
  const walk = (p: number) => {
    if (out.includes(p)) return
    out.push(p)
    for (const c of children.get(p) ?? []) walk(c)
  }
  walk(pid)

  return out
}
