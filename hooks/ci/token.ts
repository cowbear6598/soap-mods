// CI 子分頁的 GitLab token，每台 GitLab 主機一組：macOS 存在 Keychain（-T ""：誰來讀都要人按允許，Claude 的 Bash 也一樣），
// Windows 用 DPAPI 加密（只有同一個 Windows 帳號解得開）。token 不經過命令列、不寫進檔案，也不進對話。
// $.store 的 CI_STORE_KEY 只記哪些主機存了（macOS 是記號、Windows 是密文）和登入的帳號：畫面要知道有沒有 token，不用去讀 Keychain。

import { CI_KEYCHAIN_SERVICE, CI_KEYCHAIN_TIMEOUT_MS, CI_STORE_KEY } from '../config'
import { MAC_SAVE_ARGV, WIN_PROTECT_ARGV, WIN_UNPROTECT_ARGV, fromHex, keychainCheckArgv, keychainReadArgv, keychainSaveInput, toHex } from '../db/secret'
import type { Io } from '../io'
import { isWindows, runOk } from '../shell'

const KEYCHAIN = 'keychain'

export type SavedToken = { secret: string; user: string }

// $.store 裡的值不信任：每筆都檢查過才用。
async function readSaved(io: Io): Promise<Record<string, SavedToken>> {
  const raw = await io.storeGet(CI_STORE_KEY)
  if (typeof raw !== 'object' || raw === null) return {}
  const saved: Record<string, SavedToken> = {}
  for (const [host, v] of Object.entries(raw)) {
    if (typeof v === 'object' && v !== null && typeof v.secret === 'string' && v.secret !== '') saved[host] = { secret: v.secret, user: typeof v.user === 'string' ? v.user : '' }
  }

  return saved
}

export async function savedToken(io: Io, host: string): Promise<SavedToken | undefined> {
  return (await readSaved(io))[host]
}

// 讀過的 token 留在記憶體（每台主機一份），一個 session 只問 Keychain 一次；熱重載後模組變數從頭來，會再問一次。
// 存的是讀取中的 promise：同時好幾個讀取只跳一個視窗。讀失敗（按了拒絕）就丟掉，下次再問。
const tokens = new Map<string, Promise<string>>()

export function readToken(io: Io, host: string): Promise<string> {
  const cached = tokens.get(host)
  if (cached !== undefined) return cached
  const load = (async () => {
    const saved = await savedToken(io, host)
    if (saved === undefined) throw new Error(`No GitLab token is saved for ${host}.`)
    if (saved.secret !== KEYCHAIN) return fromHex((await runOk(io, WIN_UNPROTECT_ARGV, 'DPAPI', { env: { SOAP_BLOB: saved.secret } })).stdout)
    // 這裡 macOS 會跳出視窗問人：等久一點。
    const r = await io.run(keychainReadArgv(CI_KEYCHAIN_SERVICE, host), { timeoutMs: CI_KEYCHAIN_TIMEOUT_MS })
    if (r.exitCode !== 0) throw new Error("Couldn't read the GitLab token from the Keychain (access denied?). Press ↻ to ask again.")

    return fromHex(r.stdout)
  })()
  tokens.set(host, load)
  load.catch(() => {
    if (tokens.get(host) === load) tokens.delete(host)
  })

  return load
}

// 存（或換掉）一台主機的 token。存完留在記憶體，接下來不用再問 Keychain。
export async function saveToken(io: Io, host: string, token: string, user: string) {
  let secret = KEYCHAIN
  if (await isWindows(io)) {
    secret = (await runOk(io, WIN_PROTECT_ARGV, 'DPAPI', { env: { SOAP_SECRET: toHex(token) } })).stdout.trim()
  } else {
    await runOk(io, MAC_SAVE_ARGV, 'security', { stdin: keychainSaveInput(CI_KEYCHAIN_SERVICE, host, token, true), timeoutMs: CI_KEYCHAIN_TIMEOUT_MS })
    // security -i 裡的指令失敗也是結束碼 0：確認真的存進去了（只看項目在不在，不讀 token，不會跳視窗）。
    await runOk(io, keychainCheckArgv(CI_KEYCHAIN_SERVICE, host), 'security')
  }
  await io.storeSet(CI_STORE_KEY, { ...(await readSaved(io)), [host]: { secret, user } })
  tokens.set(host, Promise.resolve(token))
}
