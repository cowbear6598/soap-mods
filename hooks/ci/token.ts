// CI 子分頁的 GitLab token，每台 GitLab 主機一組，存法見 secret.ts。token 不經過命令列、不寫進檔案，也不進對話。
// $.store 的 CI_STORE_KEY 只記哪些主機存了（macOS 是記號、Windows 是密文）和登入的帳號：畫面要知道有沒有 token，不用去讀 Keychain。

import { CI_KEYCHAIN_SERVICE, CI_STORE_KEY } from '../config'
import { errorText } from '../errors'
import type { Io } from '../io'
import { readSecret, saveSecret } from '../secret'

export type SavedToken = { secret: string; user: string }

const ref = (host: string) => ({ service: CI_KEYCHAIN_SERVICE, account: host })

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

export async function readToken(io: Io, host: string): Promise<string> {
  const saved = await savedToken(io, host)
  if (saved === undefined) throw new Error(`No GitLab token is saved for ${host}.`)

  return readSecret(io, ref(host), saved.secret).catch((err: unknown) => {
    throw new Error(`Couldn't read the GitLab token: ${errorText(err)} Press ↻ to ask again.`)
  })
}

// 存（或換掉）一台主機的 token。存完留在記憶體，接下來不用再問 Keychain。
export async function saveToken(io: Io, host: string, token: string, user: string) {
  const secret = await saveSecret(io, ref(host), token)
  await io.storeSet(CI_STORE_KEY, { ...(await readSaved(io)), [host]: { secret, user } })
}
