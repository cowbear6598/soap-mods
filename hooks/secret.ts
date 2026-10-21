// 這個 mod 存的機密（DB 連線的密碼、CI 的 GitLab token）：macOS 存在 Keychain（security 指令），Windows 用 DPAPI 加密
// （只有同一個 Windows 帳號解得開），密文存在 $.store。兩邊都不用另外裝東西，機密也不會出現在任何程序的命令列上。
// Keychain 的項目加 -T ""：不信任任何程式，誰來讀（連 security 自己、Claude 的 Bash）macOS 都跳視窗要人輸入密碼。
// 存進去的一律是 UTF-8 的十六進位：security -w 碰到非 ASCII 會自己改印十六進位，分不出來；統一存十六進位，讀回來再解，兩個平台也一樣。

import { KEYCHAIN_TIMEOUT_MS } from './config'
import type { Io } from './io'
import { powershellArgv } from './services/scan'
import { isWindows, runOk } from './shell'

export type SecretRef = { service: string; account: string }

// 存進 $.store 的記號：機密在 Keychain，加了 -T ""。其他非空字串是 Windows 的 DPAPI 密文。
export const KEYCHAIN = 'keychain-guarded'
// 舊版存的記號：DB 的密碼存的時候沒加 -T ""，誰都能不問就讀（DB 讀到後換成 KEYCHAIN，見 db/actions.ts 的 readPassword）；
// CI 的 token 一開始就加了，照樣讀。
export const OLD_KEYCHAIN = 'keychain'

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
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(clean)) throw new Error('The saved secret is not readable.')

  return decodeURIComponent(clean.replace(/../g, '%$&'))
}

// ───── macOS：Keychain ─────

// 存：security -i 從 stdin 讀指令，所以機密（的十六進位）不在命令列上；-U 是已經有就蓋掉。
// security -i 裡的指令失敗也是結束碼 0，存完要用 keychainCheckArgv 確認。
const MAC_SAVE_ARGV = ['security', '-i']
const keychainSaveInput = (r: SecretRef, secret: string) => `add-generic-password -U -s ${r.service} -a ${r.account} -T "" -w ${toHex(secret)}\n`

// 不加 -w：只確認有這個項目，不印機密（不用讀，也就不會跳視窗）。
const keychainCheckArgv = (r: SecretRef) => ['security', 'find-generic-password', '-s', r.service, '-a', r.account]
const keychainReadArgv = (r: SecretRef) => [...keychainCheckArgv(r), '-w']
const keychainDeleteArgv = (r: SecretRef) => ['security', 'delete-generic-password', '-s', r.service, '-a', r.account]

// ───── Windows：DPAPI ─────

// 加密：機密（的十六進位）從環境變數 SOAP_SECRET 進來，印出 DPAPI 的密文。
const WIN_PROTECT_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; ConvertTo-SecureString $env:SOAP_SECRET -AsPlainText -Force | ConvertFrom-SecureString",
)

// 解密：密文從環境變數 SOAP_BLOB 進來，印出十六進位。
const WIN_UNPROTECT_ARGV = powershellArgv(
  "$ErrorActionPreference = 'Stop'; $s = ConvertTo-SecureString $env:SOAP_BLOB; [Console]::Out.Write((New-Object System.Management.Automation.PSCredential 'x', $s).GetNetworkCredential().Password)",
)

// ───── 存、讀、刪 ─────

const isKeychain = (saved: string) => saved === KEYCHAIN || saved === OLD_KEYCHAIN

// 讀過的留在記憶體：同時好幾個讀取只跳一個視窗；讀失敗（按了拒絕）就丟掉，下次再問。熱重載後模組變數從頭來，會再問一次。
const cache = new Map<string, Promise<string>>()
const cacheKey = (r: SecretRef) => `${r.service}\n${r.account}`

/** Saves `secret` (or replaces the one there), and returns what $.store keeps for it: KEYCHAIN, or the DPAPI ciphertext. */
export async function saveSecret(io: Io, r: SecretRef, secret: string): Promise<string> {
  let saved = KEYCHAIN
  if (await isWindows(io)) {
    saved = (await runOk(io, WIN_PROTECT_ARGV, 'DPAPI', { env: { SOAP_SECRET: toHex(secret) } })).stdout.trim()
  } else {
    await runOk(io, MAC_SAVE_ARGV, 'security', { stdin: keychainSaveInput(r, secret), timeoutMs: KEYCHAIN_TIMEOUT_MS })
    await runOk(io, keychainCheckArgv(r), 'security')
  }
  cache.set(cacheKey(r), Promise.resolve(secret))

  return saved
}

/** The secret `saved` (from $.store) points at; macOS asks for the login password the first time in a session. */
export function readSecret(io: Io, r: SecretRef, saved: string): Promise<string> {
  const key = cacheKey(r)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const load = (async () => {
    if (!isKeychain(saved)) return fromHex((await runOk(io, WIN_UNPROTECT_ARGV, 'DPAPI', { env: { SOAP_BLOB: saved } })).stdout)
    const res = await io.run(keychainReadArgv(r), { timeoutMs: KEYCHAIN_TIMEOUT_MS })
    if (res.exitCode !== 0) throw new Error("Couldn't read it from the Keychain (access denied?).")

    return fromHex(res.stdout)
  })()
  cache.set(key, load)
  load.catch(() => {
    if (cache.get(key) === load) cache.delete(key)
  })

  return load
}

/** Forgets the secret; a Keychain item is deleted too (a DPAPI ciphertext goes with its $.store entry). */
export async function deleteSecret(io: Io, r: SecretRef, saved: string) {
  cache.delete(cacheKey(r))
  if (isKeychain(saved)) await io.run(keychainDeleteArgv(r)).catch(() => undefined)
}
