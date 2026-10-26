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

/**
 * A flag for work in flight (a sync, a query) that the panel draws: a module
 * variable, not an atom, so a hot reload in the middle resets it instead of
 * leaving a "Running…" for good. `set` redraws when it changes.
 */
export function busyFlag<T>(init: T) {
  let value = init

  return {
    get: () => value,
    set: (io: Io, next: T) => {
      if (Object.is(value, next)) return
      value = next
      io.invalidate()
    },
  }
}

// 要按兩次的按鈕（打勾、Confirm）：整個面板一次只有一個待確認的 key（'' 是沒有），key 要指到那一個東西
// （svc:stop:<pid>、db:delete:<id>），換了東西才不會一按就做。DELETE_ARM_MS 後收回；按了別的要按兩次的按鈕就換過去。
// 放模組變數不放 atom：atom 熱重載後還在、收回的計時器卻沒了，會一直停在 Confirm；模組變數跟著重載歸零。
const armed = busyFlag('')
let armTimer: Timer | undefined

export const armedNow = armed.get

export function arm(io: Io, key: string) {
  armTimer?.cancel()
  armTimer = io.after(DELETE_ARM_MS, () => disarm(io))
  armed.set(io, key)
}

export function disarm(io: Io) {
  armTimer?.cancel()
  armTimer = undefined
  armed.set(io, '')
}

// 已經待確認就收回、回 true（該做了）；還沒就 arm、回 false。
export function isConfirmed(io: Io, key: string) {
  if (armed.get() === key) {
    disarm(io)

    return true
  }
  arm(io, key)

  return false
}
