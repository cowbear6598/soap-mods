import type { HttpInit, HttpResponse, Timer } from 'claude-code'

import type { HttpDraft, HttpForm, HttpFormList, HttpPage, HttpPart, HttpRequest, HttpResult, HttpView } from '../../types'
import { HTTP_DIR, HTTP_ENV_FILE, HTTP_TIMEOUT_MS } from '../config'
import { errorText, failure, isMissingCommand } from '../errors'
import { absPath, childPath } from '../files/list'
import { splitPath } from '../git/parse'
import { isObject } from '../json'
import type { Io } from '../io'
import { latestOnly } from '../latest'
import { busyFlag, disarm, isConfirmed, removePath } from '../shell'
import type { HttpBusy } from '../ui/actions'
import { BLANK_FORM, type CurlRequest, NEW_FOLDER, contentTypeOf, curlConfig, curlResponse, formError, formOf, formText, partsOf } from './form'
import {
  addHeader,
  blockText,
  capturePath,
  envNames,
  envVars,
  fileTitle,
  folderOf,
  formatBody,
  httpBlocks,
  parseEnvFile,
  parseHttpFile,
  parseJson,
  substitute,
  utf8Size,
  variableNames,
  variableSource,
} from './parse'
import { deleteHttpSecret, readHttpSecret, saveEnv, saveHttpSecret, savedEnv, savedSecrets } from './secrets'

export type HttpIo = Io & {
  getHttp: () => Promise<HttpView>
  setHttp: (change: Partial<HttpView>) => Promise<void>
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
}

const NO_REQUEST = {
  open: '',
  result: null,
  sendError: '',
  editing: '',
  secretError: '',
  showHeaders: false,
  draft: null,
  draftError: '',
} satisfies Partial<HttpView>

// 換了環境、回環境清單：變數的框、新環境的框、錯誤都不算數了。
const NO_ENV_FORM = { varDraft: null, isAddingEnv: false, newEnvName: '', envFormError: '' } satisfies Partial<HttpView>

// 模組變數不放 atom（同 DB 的 dbBusy），熱重載後不會一直停在「Sending…」。
const busy = busyFlag<HttpBusy>('')
export const httpBusyNow = busy.get

// @capture 取到的值：每個環境一份，只放記憶體，不寫進檔案、$.store 或 atom；外掛重載後模組變數從頭來，跟著消失。
const captured = new Map<string, Record<string, string>>()

export const capturedFor = (env: string): Readonly<Record<string, string>> => captured.get(env) ?? {}

const loads = latestOnly()

const readOrEmpty = async (io: HttpIo, path: string) => ((await io.exists(path).catch(() => false)) ? io.readFile(path) : '')
const eolOf = (text: string) => (text.includes('\r\n') ? '\r\n' : '\n')
// 新的內容照舊檔的換行寫（舊檔沒有就是 \n）。
const withEolOf = (old: string, text: string) => text.replace(/\n/g, eolOf(old))

// 環境檔：沒有是沒有環境（不是錯誤）；壞掉的話寫哪裡不對，請求照樣列。
async function readEnvs(io: HttpIo, dir: string) {
  const path = `${dir}/${HTTP_ENV_FILE}`
  if (!(await io.exists(path).catch(() => false))) return { envs: {}, envError: '' }
  try {
    return { envs: parseEnvFile(await io.readFile(path)), envError: '' }
  } catch (err) {
    return { envs: {}, envError: `${HTTP_DIR}/${HTTP_ENV_FILE} is not readable: ${errorText(err)}` }
  }
}

// 還沒有資料夾不是錯誤，就是還沒有請求。.soap/http 底下的 .http，加上它底下一層資料夾裡的（. 開頭的資料夾不算）。
async function readRequests(io: HttpIo, dir: string): Promise<{ requests: HttpRequest[]; error: string }> {
  if (!(await io.exists(dir).catch(() => false))) return { requests: [], error: '' }
  try {
    const isHttp = (e: { kind: string; name: string }) => e.kind === 'file' && /\.http$/i.test(e.name)
    const top = await io.list(dir)
    const folders = top.filter(e => e.kind === 'dir' && !e.name.startsWith('.')).map(e => e.name)
    const inside = await Promise.all(folders.map(async f => (await io.list(`${dir}/${f}`)).filter(isHttp).map(e => `${f}/${e.name}`)))
    const files = [...top.filter(isHttp).map(e => e.name), ...inside.flat()].sort()
    const texts = await Promise.all(files.map(f => io.readFile(`${dir}/${f}`)))

    return { requests: files.flatMap((f, i) => parseHttpFile(f, texts[i] ?? '')), error: '' }
  } catch (err) {
    return { requests: [], error: `Couldn't read ./${HTTP_DIR}: ${errorText(err)}` }
  }
}

/** Reads the requests, the environments and the secrets saved; the request opened stays open while it is still in the files. */
export async function reloadHttp(io: HttpIo) {
  const isStale = loads.start()
  const root = await io.root()
  const dir = `${root}/${HTTP_DIR}`
  const [listed, { envs, envError }, picked, prev] = await Promise.all([readRequests(io, dir), readEnvs(io, dir), savedEnv(io, root), io.getHttp()])
  const names = envNames(envs)
  // 記著的環境不在檔案裡了（改名、刪掉）就用第一個。
  const env = names.includes(picked) ? picked : (names[0] ?? '')
  const secrets = Object.keys(await savedSecrets(io, root, env))
  if (isStale()) return
  const isGone = prev.open !== '' && !listed.requests.some(r => r.id === prev.open)
  await io.setHttp({
    isLoaded: true,
    ...listed,
    envs: names,
    env,
    vars: envVars(envs, env),
    ownVars: envs[env] ?? {},
    // 沒有環境了（全刪了、檔案不見）就回環境清單。
    ...(env === '' ? { isEnvOpen: false, varDraft: null } : {}),
    envError,
    secrets,
    ...(isGone ? NO_REQUEST : {}),
  })
}

export async function openHttpRequest(io: HttpIo, id: string) {
  await io.setHttp({ ...NO_REQUEST, open: id })
  await editHttpRequest(io)
  await io.scrollTop()
}

export async function runHttpRequest(io: HttpIo, id: string) {
  if (busy.get() !== '') return
  if ((await io.getHttp()).open !== id) await io.setHttp({ ...NO_REQUEST, open: id })
  await io.scrollTop()
  await sendHttp(io)
}

// 點開的請求留著（回 API 還在），待確認的刪除和換值的框收起。
export async function selectHttpPage(io: HttpIo, page: HttpPage) {
  disarm(io)
  await io.setHttp({ page, editing: '', secretError: '' })
  await io.scrollTop()
}

export async function closeHttpRequest(io: HttpIo) {
  await io.setHttp(NO_REQUEST)
}

// 空白的表單；一個請求一個檔，名稱就是檔名，存的時候建立。
export async function newHttpRequest(io: HttpIo) {
  const draft: HttpDraft = { kind: 'new', file: '', folder: '', text: '', form: BLANK_FORM, isRaw: false, unfolded: [] }
  await io.setHttp({ ...NO_REQUEST, draft })
  await io.scrollTop()
}

// 它那段（### 那行到下一個 ### 前）讀成表單；表單留不住的（多的註解、腳本、XML 之類的 body）改原文。
export async function editHttpRequest(io: HttpIo) {
  const v = await io.getHttp()
  const r = v.requests.find(x => x.id === v.open)
  if (r === undefined) return
  const form = formOf(r.raw)
  const { name, dir } = splitPath(r.file)
  const draft: HttpDraft = {
    kind: 'request',
    id: r.id,
    file: name,
    folder: dir,
    text: r.raw,
    form: form ?? BLANK_FORM,
    isRaw: form === undefined,
    unfolded: [],
  }
  await io.setHttp({ draft, draftError: '' })
}

// 清單裡加上（isOn）或拿掉一個 key。
const toggled = (keys: readonly string[], key: string, isOn: boolean) => [...keys.filter(k => k !== key), ...(isOn ? [key] : [])]

async function changeDraft(io: HttpIo, change: (d: HttpDraft) => Partial<Pick<HttpDraft, 'text' | 'file' | 'folder' | 'form' | 'unfolded'>>) {
  const d = (await io.getHttp()).draft
  if (d !== null) await io.setHttp({ draft: { ...d, ...change(d) } })
}

// 草稿跟著存（熱重載後還在），Save 按鈕拿這份。
export async function typeHttpDraft(io: HttpIo, change: { text?: string; file?: string; folder?: string }) {
  await changeDraft(io, () => change)
}

/** The Folder picker's choice: a folder ('' none), or NEW_FOLDER, which opens a field for a new folder's name. */
export async function pickHttpFolder(io: HttpIo, folder: string) {
  const isNew = folder === NEW_FOLDER
  await changeDraft(io, d => ({ folder: isNew ? '' : folder, unfolded: toggled(d.unfolded, 'new-folder', isNew) }))
}

export async function foldHttpFolder(io: HttpIo, folder: string, isFolded: boolean) {
  const v = await io.getHttp()
  await io.setHttp({ foldedFolders: toggled(v.foldedFolders, folder, isFolded) })
}

export async function typeHttpForm(io: HttpIo, change: Partial<Pick<HttpForm, 'name' | 'method' | 'url' | 'bodyKind' | 'json'>>) {
  await changeDraft(io, d => ({ form: { ...d.form, ...change } }))
}

// 一列（header、form 欄位、multipart 欄位、capture）：改、加一列（並展開它那區）、拿掉。isFile 只有 multipart 的列讀。
const withRows = (f: HttpForm, list: HttpFormList, edit: (rows: HttpPart[]) => HttpPart[]): HttpForm => ({ ...f, [list]: edit(f[list] as HttpPart[]) })

export async function changeHttpRow(io: HttpIo, list: HttpFormList, index: number, change: Partial<HttpPart>) {
  await changeDraft(io, d => ({ form: withRows(d.form, list, rows => rows.map((r, i) => (i === index ? { ...r, ...change } : r))) }))
}

export async function addHttpRow(io: HttpIo, list: HttpFormList) {
  await changeDraft(io, d => ({
    form: withRows(d.form, list, rows => [...rows, { name: '', value: '', isFile: false }]),
    unfolded: toggled(d.unfolded, list, true),
  }))
}

export async function deleteHttpRow(io: HttpIo, list: HttpFormList, index: number) {
  await changeDraft(io, d => ({ form: withRows(d.form, list, rows => rows.filter((_, i) => i !== index)) }))
}

export async function foldHttpDraft(io: HttpIo, key: string, isOpen: boolean) {
  await changeDraft(io, d => ({ unfolded: toggled(d.unfolded, key, isOpen) }))
}

// 新請求第一段前沒有別的，一定寫成 ### 開頭；改的那段照它在檔案的位置（第一個 ### 前那段沒有 ###）。
const hasTitle = (v: HttpView, d: HttpDraft) => d.kind === 'new' || (v.requests.find(r => r.id === d.id)?.block ?? 1) > 0

// 表單 → 原文：照表單寫；原文 → 表單：讀得回表單才換，不然顯示錯誤、留在原文。
export async function rawHttpDraft(io: HttpIo, isRaw: boolean) {
  const v = await io.getHttp()
  const d = v.draft
  if (d === null || d.isRaw === isRaw) return
  if (isRaw) return io.setHttp({ draft: { ...d, isRaw, text: formText(d.form, hasTitle(v, d)) }, draftError: '' })
  const form = formOf(d.text.replace(/\r\n/g, '\n'))
  if (form === undefined) {
    return io.setHttp({ draftError: "The form can't keep everything here (other comments, scripts, a body that is not JSON, form or multipart); edit it as text." })
  }
  await io.setHttp({ draft: { ...d, isRaw, form }, draftError: '' })
}

// 一段請求要從 ### 開始（不然會接到上一段）；使用者刪了 ### 那行就補一行沒有名字的。
const titled = (text: string) => (text.startsWith('###') ? text : `###\n${text}`)

// 檔名、資料夾名：哪種語言的字、數字都可以（登入、ログイン），加上空白、- _ .；斜線、冒號那些路徑和 Windows 不收的字不行。
const NAME_CHARS = /^[\p{L}\p{M}\p{N}_. -]+$/u

// 只能是 .soap/http 底下的一個檔，沒寫 .http 就補上。
function httpFileName(name: string) {
  if (name.trim() === '') throw new Error('Write a name, like login.')
  const file = /\.http$/i.test(name.trim()) ? name.trim() : `${name.trim()}.http`
  if (!NAME_CHARS.test(file)) throw new Error('A name has only letters, digits, spaces, -, _ and . (like login or 登入).')

  return file
}

// 資料夾一層，'' 是不放資料夾；. 開頭的不行（列表不讀 . 開頭的資料夾）。
function httpFolderName(name: string) {
  const folder = name.trim()
  if (folder !== '' && (!NAME_CHARS.test(folder) || folder.startsWith('.'))) {
    throw new Error('A folder name has only letters, digits, spaces, -, _ and . (like 會員), and does not start with a dot.')
  }

  return folder
}

const draftFile = (d: { file: string; folder: string }) => childPath(httpFolderName(d.folder), httpFileName(d.file))

// 名稱就是檔名：已經有這個檔就不寫（不接到別的請求後面、不蓋掉）。
async function mustBeNewFile(io: HttpIo, file: string) {
  const path = `${await io.root()}/${HTTP_DIR}/${file}`
  if (await io.exists(path).catch(() => false)) throw new Error(`There is already ${fileTitle(file)}; pick another name.`)

  return path
}

function mustHaveRequest(file: string, text: string) {
  if (parseHttpFile(file, text).length === 0) throw new Error('Write a request: a method and a URL, like GET https://example.com.')
}

// 讀出點開那段在檔案裡的樣子；檔案在編輯期間被改了（Claude、別的編輯器）就不寫，免得蓋掉。
async function readBlocks(io: HttpIo, r: HttpRequest) {
  const path = `${await io.root()}/${HTTP_DIR}/${r.file}`
  const text = await io.readFile(path)
  const blocks = httpBlocks(text)
  const lines = blocks[r.block]
  if (lines === undefined || blockText(lines) !== r.raw) throw new Error(`${r.file} changed since it was read; Cancel and open the request again.`)

  return { path, eol: eolOf(text), blocks, lines }
}

async function saveNewRequest(io: HttpIo, d: { file: string; folder: string }, text: string) {
  const file = draftFile(d)
  const block = titled(text)
  mustHaveRequest(file, block)
  await io.writeFile(await mustBeNewFile(io, file), `${block}\n`)

  return file
}

// 改過的那段寫回原處（那段結尾隔開下一段的空行照留）。
// 檔案只有這個請求時，名稱、資料夾改了就是搬檔：寫到新檔、刪掉舊的。
async function saveEditedRequest(io: HttpIo, v: HttpView, d: { id: string; file: string; folder: string }, text: string) {
  const r = v.requests.find(x => x.id === d.id)
  if (r === undefined) throw new Error('The request is no longer in its file.')
  const file = r.isOwnFile ? draftFile(d) : r.file
  const block = r.block > 0 ? titled(text) : text
  mustHaveRequest(file, block)
  const { path, eol, blocks, lines } = await readBlocks(io, r)
  // 那段結尾的空行（隔開下一段）照原樣留著。
  let end = lines.length
  while (end > 0 && (lines[end - 1] ?? '').trim() === '') end -= 1
  blocks[r.block] = [...block.split('\n'), ...lines.slice(end)]
  const isRenamed = file.toLowerCase() !== r.file.toLowerCase()
  await io.writeFile(isRenamed ? await mustBeNewFile(io, file) : path, blocks.flat().join(eol))
  if (isRenamed) await removePath(io, path)

  return file
}

/** Writes the draft (the form, or the text when isRaw) to `.soap/http`: a request's block in place (keeping the file's line ends), or a new request at the end of its file. */
export async function saveHttpDraft(io: HttpIo, typed?: string) {
  const v = await io.getHttp()
  const d = v.draft
  if (d === null || busy.get() !== '') return
  const error = d.isRaw ? '' : formError(d.form)
  if (error !== '') return io.setHttp({ draftError: error })
  const text = (d.isRaw ? (typed ?? d.text) : formText(d.form, hasTitle(v, d))).replace(/\r\n/g, '\n').replace(/\s+$/, '')
  busy.set(io, 'draft')
  try {
    // 重讀完才回清單（重讀還要問 Keychain 存了哪些機密，要一點時間）：先回的話，這時點開的是還沒重讀的舊內容。
    const file = d.kind === 'new' ? await saveNewRequest(io, d, text) : await saveEditedRequest(io, v, d, text)
    await reloadHttp(io)
    await closeHttpRequest(io)
    io.toast(`Saved ${fileTitle(file)}`)
  } catch (err) {
    await io.setHttp({ draftError: errorText(err) })
  } finally {
    busy.set(io, '')
  }
}

// 按第一次只是待確認，再按才從檔案拿掉那段，回清單。
export async function deleteHttpRequest(io: HttpIo) {
  const v = await io.getHttp()
  const r = v.requests.find(x => x.id === v.open)
  if (r === undefined || !isConfirmed(io, `http:request:${r.id}`)) return
  try {
    const { path, eol, blocks } = await readBlocks(io, r)
    if (r.block === 0) blocks[0] = []
    else blocks.splice(r.block, 1)
    await io.writeFile(path, blocks.flat().join(eol))
    // 同 Save：重讀完才回清單，刪掉的那列不會還點得到。
    await reloadHttp(io)
    await closeHttpRequest(io)
  } catch (err) {
    await io.setHttp({ sendError: `Couldn't delete it: ${errorText(err)}` })
  }
}

// 記在 $.store（依 session 資料夾），重讀環境的變數和這個環境存了哪些機密。上一個環境的回應不算數了。
async function selectHttpEnv(io: HttpIo, env: string) {
  await saveEnv(io, await io.root(), env)
  await io.setHttp({ result: null, sendError: '', editing: '', secretError: '', ...NO_ENV_FORM })
  await reloadHttp(io)
}

// 每個變數照 variableSource 找值，機密這時才讀（Keychain 一個 session 每項只問一次）。還沒有值的列在 missing。
async function resolve(io: HttpIo, v: HttpView, r: HttpRequest) {
  const root = await io.root()
  const values: Record<string, string> = {}
  const missing: string[] = []
  const got = capturedFor(v.env)
  for (const name of variableNames(r)) {
    const source = variableSource(v, got, name)
    if (source === 'captured') values[name] = got[name] ?? ''
    else if (source === 'env') values[name] = v.vars[name] ?? ''
    else if (source === 'secret') values[name] = await readHttpSecret(io, root, v.env, name)
    else missing.push(name)
  }
  const fill = (text: string) => substitute(text, name => values[name])

  return {
    missing,
    url: fill(r.url),
    headers: r.headers.map(h => ({ name: fill(h.name), value: fill(h.value) })),
    body: fill(r.body),
  }
}

async function fetchWithin(io: HttpIo, url: string, init: HttpInit) {
  let timer: Timer | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = io.after(HTTP_TIMEOUT_MS, () => reject(new Error(`No answer after ${HTTP_TIMEOUT_MS / 1000}s.`)))
  })
  try {
    return await Promise.race([io.fetch(url, init), timeout])
  } finally {
    timer?.cancel()
  }
}

const isAbsolute = (path: string) => path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(path)

// multipart 用 curl 送（$.http.fetch 的 body 只能是文字）。File 的相對路徑從 .http 檔所在的資料夾算（同 REST Client），先確定每個檔案都在。
async function curlFiles(io: HttpIo, file: string, parts: HttpPart[]): Promise<HttpPart[]> {
  const dir = absPath(`${await io.root()}/${HTTP_DIR}`, folderOf(file))
  const files = parts.map(p => (p.isFile && !isAbsolute(p.value) ? { ...p, value: `${dir}/${p.value.replace(/^\.[\\/]/, '')}` } : p))
  for (const p of files) {
    if (p.isFile && !(await io.exists(p.value).catch(() => false))) throw new Error(`There is no file ${p.value}.`)
  }

  return files
}

// 設定從 stdin 給，機密不會出現在程序清單上。不用 runOk：只有跑不起來（rejected）才算沒裝 curl。
async function curlSend(io: HttpIo, req: CurlRequest) {
  const out = await io.run(['curl', '--config', '-'], { stdin: curlConfig(req, HTTP_TIMEOUT_MS), timeoutMs: HTTP_TIMEOUT_MS + 5000 }).catch((err: unknown) => {
    throw isMissingCommand(err) ? new Error('curl is not installed; a multipart request needs it.') : err
  })
  if (out.exitCode !== 0) throw failure(out, 'curl')
  const res = curlResponse(out.stdout)
  if (res === undefined) throw new Error('curl printed no HTTP answer.')

  return res
}

async function fetchRequest(io: HttpIo, method: string, req: { url: string; headers: { name: string; value: string }[]; body: string }) {
  const headers: Record<string, string> = {}
  for (const h of req.headers) addHeader(headers, h.name, h.value)

  return fetchWithin(io, req.url, req.body === '' ? { method, headers } : { method, headers, body: req.body })
}

// 回應成功（2xx）才取；取到的存成目前環境的變數（只放記憶體），取不到的回報。
function runCaptures(r: HttpRequest, env: string, res: HttpResponse) {
  if (!res.ok || r.captures.length === 0) return { captured: [], missed: [] }
  const data = parseJson(res.text)
  const got: Record<string, string> = {}
  const missed: string[] = []
  for (const c of r.captures) {
    const value = data === undefined ? undefined : capturePath(data, c.path)
    if (value === undefined) missed.push(c.name)
    else got[c.name] = value
  }
  captured.set(env, { ...capturedFor(env), ...got })

  return { captured: Object.keys(got), missed }
}

/** Sends the opened request with the variables of the environment picked; any environment sends on one press. A multipart one goes through curl, for its files. */
export async function sendHttp(io: HttpIo) {
  if (busy.get() !== '') return
  const v = await io.getHttp()
  const r = v.requests.find(x => x.id === v.open)
  if (r === undefined) return
  busy.set(io, 'send')
  try {
    const req = await resolve(io, v, r).catch((err: unknown) => {
      throw new Error(`Couldn't read a saved value: ${errorText(err)}`)
    })
    if (req.missing.length > 0) {
      await io.setHttp({ sendError: `Paste a value for ${req.missing.map(n => `{{${n}}}`).join(', ')} first.` })

      return
    }
    if (!/^https?:\/\//i.test(req.url)) {
      await io.setHttp({ sendError: `The URL must start with http:// or https://: ${r.url}` })

      return
    }
    const parts = partsOf(req)
    const files = parts === undefined ? undefined : await curlFiles(io, r.file, parts)
    const started = await io.now()
    const sent = files === undefined ? fetchRequest(io, r.method, req) : curlSend(io, { method: r.method, url: req.url, headers: req.headers, parts: files })
    const res = await sent.catch((err: unknown) => {
      throw new Error(`Couldn't reach ${req.url}: ${errorText(err)}`)
    })
    const ms = Math.max(0, (await io.now()) - started)
    const headers = Object.entries(res.headers).map(([name, value]) => ({ name, value }))
    const result: HttpResult = {
      id: r.id,
      status: res.status,
      ms,
      size: utf8Size(res.text),
      headers,
      ...formatBody(res.text, contentTypeOf(headers)),
      ...runCaptures(r, v.env, res),
    }
    // 送出期間換了請求或環境：回應不是畫面上那個的，不寫。
    const now = await io.getHttp()
    if (now.open !== r.id || now.env !== v.env) return
    await io.setHttp({ result, sendError: '' })
  } catch (err) {
    await io.setHttp({ result: null, sendError: errorText(err) })
  } finally {
    busy.set(io, '')
  }
}

// 存進 Keychain／DPAPI（依 session 資料夾和環境），換掉舊的。錯誤訊息裡不放值。
export async function saveHttpSecretValue(io: HttpIo, name: string, text: string) {
  const value = text.trim()
  if (busy.get() !== '' || value === '') return
  busy.set(io, 'secret')
  try {
    const v = await io.getHttp()
    await saveHttpSecret(io, await io.root(), v.env, name, value)
    await io.setHttp({ editing: '', secretError: '' })
    io.toast(`Saved {{${name}}}${v.env === '' ? '' : ` for ${v.env}`}`)
    await reloadHttp(io)
  } catch (err) {
    await io.setHttp({ secretError: `Couldn't save {{${name}}}: ${errorText(err)}` })
  } finally {
    busy.set(io, '')
  }
}

// 按第一次只是待確認，再按才刪（連 Keychain 的項目）。
export async function deleteHttpSecretValue(io: HttpIo, name: string) {
  const v = await io.getHttp()
  if (!isConfirmed(io, `http:secret:${v.env}:${name}`)) return
  try {
    await deleteHttpSecret(io, await io.root(), v.env, name)
    await io.setHttp({ editing: '', secretError: '' })
    await reloadHttp(io)
  } catch (err) {
    await io.setHttp({ secretError: `Couldn't delete {{${name}}}: ${errorText(err)}` })
  }
}

export async function editHttpSecret(io: HttpIo, name: string) {
  await io.setHttp({ editing: name, secretError: '' })
}

// ───── Environment：環境和變數，寫進 http-client.env.json ─────

// {{name}} 裡寫得出來的（字母、數字、_ - .）；環境不能 $ 開頭（$shared 那類是 REST Client 自己的）。
const NAME = /^[\w.-]+$/

// 讀出來（沒有是 {}）、change 改、寫回去（兩格縮排，照檔案原本的換行）。壞掉的檔案不碰。
async function changeEnvFile(io: HttpIo, change: (data: Record<string, unknown>) => void) {
  const path = `${await io.root()}/${HTTP_DIR}/${HTTP_ENV_FILE}`
  const old = await readOrEmpty(io, path)
  const data: unknown = old.trim() === '' ? {} : JSON.parse(old)
  if (!isObject(data)) throw new Error(`${HTTP_ENV_FILE} is not a JSON object of environments.`)
  change(data)
  await io.writeFile(path, withEolOf(old, `${JSON.stringify(data, null, 2)}\n`))
}

// 改環境檔、重讀；錯誤寫在 Environment 上，回 false。
async function envChange(io: HttpIo, change: (data: Record<string, unknown>) => void, after: Partial<HttpView> = {}) {
  try {
    await changeEnvFile(io, change)
    await io.setHttp({ envFormError: '', ...after })
    await reloadHttp(io)

    return true
  } catch (err) {
    await io.setHttp({ envFormError: errorText(err) })

    return false
  }
}

export async function openAddHttpEnv(io: HttpIo, isOpen: boolean) {
  await io.setHttp({ isAddingEnv: isOpen, newEnvName: '', envFormError: '' })
}

export async function typeHttpEnvName(io: HttpIo, name: string) {
  await io.setHttp({ newEnvName: name })
}

// 沒有或不是物件就換一個空的。
function varsOf(data: Record<string, unknown>, env: string) {
  const vars = data[env]
  if (isObject(vars)) return vars
  const fresh: Record<string, unknown> = {}
  data[env] = fresh

  return fresh
}

export async function addHttpEnv(io: HttpIo, text?: string) {
  const v = await io.getHttp()
  const name = (text ?? v.newEnvName).trim()
  if (name === '') return
  if (!NAME.test(name) || name.startsWith('$')) return io.setHttp({ envFormError: 'An environment name has only letters, digits, -, _ and . (like dev).' })
  if (v.envs.includes(name)) return io.setHttp({ envFormError: `There is already an environment ${name}.` })
  if (await envChange(io, data => (data[name] = {}))) await openHttpEnv(io, name)
}

/** Deletes an environment from the file, on a second press; its saved secrets stay in the Keychain. */
export async function deleteHttpEnv(io: HttpIo, env: string) {
  if (!isConfirmed(io, `http:env:${env}`)) return
  await envChange(io, data => {
    delete data[env]
  })
}

/** Opens an environment to its variables (Environment's second level); opening one picks it for Run. */
export async function openHttpEnv(io: HttpIo, env: string) {
  // 已經在用的：不重選（API 那邊的回應留著）。
  if ((await io.getHttp()).env === env) await io.setHttp(NO_ENV_FORM)
  else await selectHttpEnv(io, env)
  await io.setHttp({ page: 'env', isEnvOpen: true })
  await io.scrollTop()
}

export async function closeHttpEnv(io: HttpIo) {
  await io.setHttp({ ...NO_ENV_FORM, isEnvOpen: false })
}

export async function newHttpVar(io: HttpIo) {
  await io.setHttp({ varDraft: { from: '', name: '', value: '' }, envFormError: '' })
}

export async function editHttpVar(io: HttpIo, name: string) {
  const v = await io.getHttp()
  await io.setHttp({ varDraft: { from: name, name, value: v.ownVars[name] ?? '' }, envFormError: '' })
}

// 草稿跟著存，Save 拿這份；Enter 送出的那格以送出的字為準。
export async function typeHttpVar(io: HttpIo, change: { name?: string; value?: string }) {
  const d = (await io.getHttp()).varDraft
  if (d !== null) await io.setHttp({ varDraft: { ...d, ...change } })
}

export async function cancelHttpVar(io: HttpIo) {
  await io.setHttp({ varDraft: null, envFormError: '' })
}

/** Writes the variable being added or changed to the picked environment; a renamed one keeps its place. */
export async function saveHttpVar(io: HttpIo, change: { name?: string; value?: string } = {}) {
  const v = await io.getHttp()
  if (v.env === '' || v.varDraft === null) return
  const { from } = v.varDraft
  const name = (change.name ?? v.varDraft.name).trim()
  const value = change.value ?? v.varDraft.value
  const draft = { from, name, value }
  if (!NAME.test(name)) return io.setHttp({ varDraft: draft, envFormError: 'A variable name has only letters, digits, -, _ and . (like host).' })
  if (name !== from && Object.hasOwn(v.ownVars, name)) return io.setHttp({ varDraft: draft, envFormError: `${v.env} already has {{${name}}}.` })
  await envChange(
    io,
    data => {
      const vars = varsOf(data, v.env)
      const entries = Object.entries(vars).map(([k, x]): [string, unknown] => (k === from ? [name, value] : [k, x]))
      if (from === '') entries.push([name, value])
      for (const k of Object.keys(vars)) delete vars[k]
      Object.assign(vars, Object.fromEntries(entries))
    },
    { varDraft: null },
  )
}

/** Deletes a variable of the picked environment, on a second press. */
export async function deleteHttpVar(io: HttpIo, name: string) {
  const v = await io.getHttp()
  if (!isConfirmed(io, `http:var:${v.env}:${name}`)) return
  await envChange(
    io,
    data => {
      delete varsOf(data, v.env)[name]
    },
    { varDraft: null },
  )
}
