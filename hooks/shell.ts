// 各分頁共用的動作：跑指令、刪檔案、要按兩次的按鈕。

import type { ProcessRunInit, Timer } from 'claude-code'

import { DELETE_ARM_MS } from './config'
import { failure } from './errors'
import type { Io } from './io'
import { powershellArgv } from './services/scan'

// 跑指令，結束碼不是 0 就丟出錯誤；what 是錯誤訊息裡的名稱。
export async function runOk(io: Io, argv: string[], what: string, init?: ProcessRunInit) {
  const r = await io.run(argv, init)
  if (r.exitCode !== 0) throw failure(r, what)

  return r
}

// Windows 用 PowerShell，其他（macOS）用 ps、lsof、kill。平台不會變，問一次就記著。
let windows: boolean | undefined

export async function isWindows(io: Io) {
  windows ??= (await io.osEnv()) === 'Windows_NT'

  return windows
}

// 刪檔案或整個資料夾（diff、Files、Spec、Wiki 都走這裡）：macOS 用 rm -rf，Windows 用 PowerShell 的 Remove-Item；
// 路徑從環境變數給，不拼進指令。連結（junction、symlink）只刪連結本身：Windows PowerShell 的 Remove-Item -Recurse 會進到目標裡刪。
const REMOVE_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; $i = Get-Item -LiteralPath $env:SOAP_PATH -Force; if ($i.Attributes -band [IO.FileAttributes]::ReparsePoint) { $i.Delete() } else { Remove-Item -LiteralPath $env:SOAP_PATH -Recurse -Force }",
)

// 只刪 session 資料夾底下的東西：不在它底下、或路徑裡有 . 和 .. 的不刪。
// 比的時候不分大小寫、斜線方向：repo 的根目錄是 git 給的（C:/…），session 資料夾是引擎給的。
export async function removePath(io: Io, abs: string) {
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase()
  const root = `${norm(await io.root()).replace(/\/$/, '')}/`
  const rel = norm(abs)
  if (!rel.startsWith(root) || rel.slice(root.length).split('/').some(p => p === '' || p === '.' || p === '..')) {
    throw new Error('outside the session folder')
  }
  if (await isWindows(io)) await runOk(io, REMOVE_ARGV, 'Remove-Item', { env: { SOAP_PATH: abs } })
  else await runOk(io, ['rm', '-rf', '--', abs], 'rm')
}

// 待確認的按鈕（打勾、紅字）DELETE_ARM_MS 後收回（disarm）。一種一個 slot：再計時、或做了、按了別的就先停掉舊的。
export type ArmSlot = { timer?: Timer }

export function disarmLater(io: Io, slot: ArmSlot, disarm: () => unknown) {
  slot.timer?.cancel()
  slot.timer = io.after(DELETE_ARM_MS, () => void disarm())
}

// 要按兩次的按鈕：還沒待確認就 arm、回 false（DELETE_ARM_MS 後 disarm）；已經待確認就停掉計時、回 true（該做了）。
export async function isConfirmed(io: Io, slot: ArmSlot, isArmed: boolean, arm: () => Promise<unknown>, disarm: () => unknown) {
  slot.timer?.cancel()
  if (isArmed) return true
  disarmLater(io, slot, disarm)
  await arm()

  return false
}
