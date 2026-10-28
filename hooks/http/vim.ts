// Edit in vim：Claude Code 的終端機畫面歸它管，mod 拿不到 TTY，vim 只能開在新視窗。
// macOS 是 Terminal.app 的新視窗；Windows 是新的主控台視窗跑 vim（PATH 上的，或 Git for Windows 附的），沒有就開 Notepad 等它關掉。
// 編輯器結束時建立 done 那個檔，面板看到它就知道改完了。路徑從參數、環境變數給，不拼進指令。

import type { Io } from '../io'
import { powershellArgv } from '../services/scan'
import { isWindows, runOk } from '../shell'

// 回傳新視窗的 id，改完用它關掉（Terminal 的設定可能是 shell 結束了也不關視窗）。
const MAC_OPEN = [
  'on run argv',
  'tell application "Terminal"',
  'activate',
  'do script "vim -- " & quoted form of (item 1 of argv) & "; touch " & quoted form of (item 2 of argv) & "; exit"',
  'return id of front window',
  'end tell',
  'end run',
]

const MAC_CLOSE = ['on run argv', 'tell application "Terminal" to close (every window whose id is (item 1 of argv as integer))', 'end run']

const osascript = (lines: string[], args: string[]) => ['osascript', ...lines.flatMap(l => ['-e', l]), ...args]

// cmd /c 跑完就關掉視窗；一整串給 -ArgumentList（給陣列的話 PowerShell 7 可能自己加引號）。以 call 開頭，cmd 不會拿掉頭尾的引號。
const WIN_OPEN = powershellArgv(
  [
    "$ErrorActionPreference = 'Stop'",
    '$vim = (Get-Command vim.exe -ErrorAction SilentlyContinue).Source',
    '$git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source',
    "if (-not $vim -and $git) { $p = Join-Path (Split-Path (Split-Path $git)) 'usr\\bin\\vim.exe'; if (Test-Path $p) { $vim = $p } }",
    "if ($vim) { $env:SOAP_VIM = $vim; Start-Process cmd.exe -ArgumentList '/c call \"%SOAP_VIM%\" \"%SOAP_PATH%\" & type nul > \"%SOAP_DONE%\"' } " +
      "else { Start-Process cmd.exe -WindowStyle Hidden -ArgumentList '/c start \"\" /wait notepad \"%SOAP_PATH%\" & type nul > \"%SOAP_DONE%\"' }",
  ].join('\n'),
)

/** Opens path in vim in a window of its own, which creates done when it ends; resolves the window closeVim closes (macOS). */
export async function openVim(io: Io, path: string, done: string): Promise<string | undefined> {
  if (await isWindows(io)) {
    const win = (p: string) => p.replace(/\//g, '\\')
    await runOk(io, WIN_OPEN, 'Start-Process', { env: { SOAP_PATH: win(path), SOAP_DONE: win(done) } })

    return undefined
  }
  const out = await runOk(io, osascript(MAC_OPEN, [path, done]), 'osascript')

  return out.stdout.trim()
}

export async function closeVim(io: Io, window: string | undefined) {
  if (window !== undefined) await runOk(io, osascript(MAC_CLOSE, [window]), 'osascript')
}
