// HTTP 子分頁的機密：請求用到、環境檔沒有的變數，貼在面板上，依 session 資料夾和環境各存一份，存法見 secret.ts（一個 session 每項只問一次 Keychain）。
// 值不經過命令列、不寫進檔案，也不進對話。$.store 的 HTTP_STORE_KEY 只記存了哪些（macOS 是記號、Windows 是密文）：
// { [session 資料夾]: { [環境]: { [變數]: 記號或密文 } } }。選的環境放在 HTTP_ENV_KEY：{ [session 資料夾]: 環境 }。
// @prompt 填的值不是機密，明文放在 HTTP_PROMPT_KEY：{ [session 資料夾]: { [變數]: 值 } }。

import { HTTP_ENV_KEY, HTTP_KEYCHAIN_SERVICE, HTTP_PROMPT_KEY, HTTP_STORE_KEY } from '../config'
import type { Io } from '../io'
import { isObject, obj, texts } from '../json'
import { deleteSecret, readSecret, saveSecret, toHex } from '../secret'

type Saved = Record<string, Record<string, Record<string, string>>>

// Keychain 的 account：session 資料夾、環境、變數名稱的十六進位（路徑裡的空白放不進 security -i 的那行指令）。
const ref = (root: string, env: string, name: string) => ({ service: HTTP_KEYCHAIN_SERVICE, account: toHex(`${root}\n${env}\n${name}`) })

// $.store 裡的值不信任：每層都檢查過才用。
async function readSaved(io: Io): Promise<Saved> {
  const raw = await io.storeGet(HTTP_STORE_KEY)
  const saved: Saved = {}
  if (!isObject(raw)) return saved
  for (const [root, envs] of Object.entries(raw)) {
    if (!isObject(envs)) continue
    saved[root] = {}
    for (const [env, names] of Object.entries(envs)) {
      if (!isObject(names)) continue
      saved[root][env] = Object.fromEntries(Object.entries(texts(names)).filter(e => e[1] !== ''))
    }
  }

  return saved
}

/** The variables with a secret saved for this session folder and environment, by name. */
export async function savedSecrets(io: Io, root: string, env: string): Promise<Record<string, string>> {
  return (await readSaved(io))[root]?.[env] ?? {}
}

export async function saveHttpSecret(io: Io, root: string, env: string, name: string, value: string) {
  const secret = await saveSecret(io, ref(root, env, name), value)
  const saved = await readSaved(io)
  await io.storeSet(HTTP_STORE_KEY, { ...saved, [root]: { ...saved[root], [env]: { ...saved[root]?.[env], [name]: secret } } })
}

/** The secret's value; macOS asks for the login password the first time in a session. */
export async function readHttpSecret(io: Io, root: string, env: string, name: string): Promise<string> {
  const secret = (await savedSecrets(io, root, env))[name]
  if (secret === undefined) throw new Error(`No value is saved for {{${name}}}.`)

  return readSecret(io, ref(root, env, name), secret)
}

export async function deleteHttpSecret(io: Io, root: string, env: string, name: string) {
  const saved = await readSaved(io)
  const secret = saved[root]?.[env]?.[name]
  if (secret === undefined) return
  await deleteSecret(io, ref(root, env, name), secret)
  const { [name]: _gone, ...rest } = saved[root]?.[env] ?? {}
  await io.storeSet(HTTP_STORE_KEY, { ...saved, [root]: { ...saved[root], [env]: rest } })
}

/** The environment picked for this session folder, '' when none was. */
export async function savedEnv(io: Io, root: string): Promise<string> {
  const raw = await io.storeGet(HTTP_ENV_KEY)
  const env = isObject(raw) ? raw[root] : undefined

  return typeof env === 'string' ? env : ''
}

export async function saveEnv(io: Io, root: string, env: string) {
  const raw = await io.storeGet(HTTP_ENV_KEY)
  await io.storeSet(HTTP_ENV_KEY, { ...(isObject(raw) ? raw : {}), [root]: env })
}

// $.store 裡的值不信任：只留文字。
async function readPrompts(io: Io): Promise<Record<string, Record<string, string>>> {
  return Object.fromEntries(Object.entries(obj(await io.storeGet(HTTP_PROMPT_KEY))).map(([root, names]) => [root, texts(names)]))
}

export async function savedPrompts(io: Io, root: string): Promise<Record<string, string>> {
  return (await readPrompts(io))[root] ?? {}
}

/** Keeps a `@prompt` value for this session folder; '' forgets it. Resolves the values now kept. */
export async function savePrompt(io: Io, root: string, name: string, value: string): Promise<Record<string, string>> {
  const saved = await readPrompts(io)
  const { [name]: _old, ...rest } = saved[root] ?? {}
  const values = value === '' ? rest : { ...rest, [name]: value }
  await io.storeSet(HTTP_PROMPT_KEY, { ...saved, [root]: values })

  return values
}
