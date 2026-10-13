// DB 連線的密碼：macOS 存在 Keychain（security 指令），Windows 用 DPAPI 加密（只有同一個 Windows 帳號解得開），
// 密文跟連線一起存在 $.store。兩邊都不用另外裝東西，密碼也不會出現在任何程序的命令列上。
// 存進去的一律是密碼 UTF-8 的十六進位：security -w 碰到非 ASCII 會自己改印十六進位，分不出來；
// 統一存十六進位，讀回來再解，兩個平台也一樣。

import { DB_KEYCHAIN_SERVICE } from '../config'
import { powershellArgv } from '../services/scan'

/** `text` as UTF-8, in lowercase hex. */
export function toHex(text: string): string {
  return encodeURIComponent(text)
    .replace(/%([0-9A-F]{2})|([\s\S])/g, (_m, esc: string | undefined, ch: string | undefined) =>
      esc !== undefined ? esc.toLowerCase() : (ch ?? '').charCodeAt(0).toString(16).padStart(2, '0'),
    )
}

/** UTF-8 hex → text; throws on anything else. */
export function fromHex(hex: string): string {
  const clean = hex.trim()
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(clean)) throw new Error('The saved password is not readable.')

  return decodeURIComponent(clean.replace(/../g, '%$&'))
}

// ───── macOS：Keychain ─────

// 存：security -i 從 stdin 讀指令，所以密碼（的十六進位）不在命令列上；-U 是已經有就蓋掉。
// security -i 裡的指令失敗也是結束碼 0，存完要用 macCheckArgv 確認。
export const MAC_SAVE_ARGV = ['security', '-i']
export const macSaveInput = (id: string, password: string) =>
  `add-generic-password -U -s ${DB_KEYCHAIN_SERVICE} -a ${id} -w ${toHex(password)}\n`

// 不加 -w：只確認有這個項目，不印密碼。
export const macCheckArgv = (id: string) => ['security', 'find-generic-password', '-s', DB_KEYCHAIN_SERVICE, '-a', id]
export const macReadArgv = (id: string) => [...macCheckArgv(id), '-w']
export const macDeleteArgv = (id: string) => ['security', 'delete-generic-password', '-s', DB_KEYCHAIN_SERVICE, '-a', id]

// ───── Windows：DPAPI ─────

// 加密：密碼（的十六進位）從環境變數 SOAP_SECRET 進來，印出 DPAPI 的密文。
export const WIN_PROTECT_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; ConvertTo-SecureString $env:SOAP_SECRET -AsPlainText -Force | ConvertFrom-SecureString",
)

// 解密：密文從環境變數 SOAP_BLOB 進來，印出十六進位。
export const WIN_UNPROTECT_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; $s = ConvertTo-SecureString $env:SOAP_BLOB; [Console]::Out.Write((New-Object System.Management.Automation.PSCredential 'x', $s).GetNetworkCredential().Password)",
)
