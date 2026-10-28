import type { HttpCapture, HttpHeader, HttpPrompt, HttpRequest } from '../../types'
import { byName } from '../files/list'
import { splitPath } from '../git/parse'
import { isObject } from '../json'
import { cutAtLineEnd } from '../text'

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'])
const COMMENT = /^\s*(?:#|\/\/)/
const NAME_TAG = /^\s*(?:#|\/\/)\s*@name\s+(.+?)\s*$/
const CAPTURE_TAG = /^\s*(?:#|\/\/)\s*@capture\s+([\w.-]+)\s*=\s*(\S+)\s*$/
const PROMPT_TAG = /^\s*(?:#|\/\/)\s*@prompt\s+([\w.-]+)(?:\s+(.*?))?\s*$/
const HEADER = /^([^:\s][^:]*?)\s*:\s?(.*)$/
// 變數：{{name}}，前後可以有空白；$ 開頭的是 REST Client 的系統變數（{{$guid}}），不管它。
const VARIABLE = /\{\{\s*([^{}\s]+)\s*\}\}/g

// 請求那行：「方法 URL」，後面可以接 HTTP/1.1；沒寫方法是 GET。
function requestLine(line: string) {
  const text = line.trim().replace(/\s+HTTP\/[\d.]+$/i, '')
  const [first = '', ...rest] = text.split(/\s+/)
  if (METHODS.has(first.toUpperCase()) && rest.length > 0) return { method: first.toUpperCase(), url: rest.join(' ') }

  return { method: 'GET', url: text }
}

// 不是 body 的行：JetBrains 的回應處理（> {% … %}、> 檔案）和存回應（>> 檔案）。這裡不執行，也不送出去。
function stripHandlers(lines: string[]) {
  const kept: string[] = []
  let isScript = false
  for (const line of lines) {
    if (isScript) {
      if (line.includes('%}')) isScript = false
      continue
    }
    if (/^>\s*\{%/.test(line)) {
      isScript = !line.includes('%}')
      continue
    }
    if (/^(?:>>!?|>)\s/.test(line)) continue
    kept.push(line)
  }

  return kept
}

// ### 之間的一段：前面的註解（@name、@capture、@prompt）、請求那行、headers、空行後的 body。沒有請求那行的（只有註解）回 undefined。
function parseBlock(file: string, index: number, block: number, raw: string, title: string, lines: string[]): Omit<HttpRequest, 'isOwnFile'> | undefined {
  let name = title
  const captures: HttpCapture[] = []
  const prompts: HttpPrompt[] = []
  const headers: HttpHeader[] = []
  let at = 0
  // 註解裡的 @name、@capture、@prompt；其他註解跳過。是不是註解要先看：# 開頭的不是請求。
  const note = (line: string) => {
    const tag = NAME_TAG.exec(line)
    if (tag !== null && name === '') name = tag[1] ?? ''
    const capture = CAPTURE_TAG.exec(line)
    if (capture !== null) captures.push({ name: capture[1] ?? '', path: capture[2] ?? '' })
    const prompt = PROMPT_TAG.exec(line)
    if (prompt !== null && !prompts.some(p => p.name === prompt[1])) prompts.push({ name: prompt[1] ?? '', description: prompt[2] ?? '' })
  }

  // 請求那行之前：空行、註解、REST Client 的檔案變數（@name = value，這裡不支援，跳過）。
  while (at < lines.length) {
    const line = lines[at] ?? ''
    if (line.trim() === '' || line.trim().startsWith('@')) at += 1
    else if (COMMENT.test(line)) {
      note(line)
      at += 1
    } else break
  }
  if (at >= lines.length) return undefined
  const start = requestLine(lines[at] ?? '')
  const method = start.method
  let url = start.url
  at += 1
  // 很長的 query 可以拆成好幾行，接著的行以 ? 或 & 開頭。
  while (at < lines.length && /^\s+[?&]/.test(lines[at] ?? '')) {
    url += (lines[at] ?? '').trim()
    at += 1
  }
  for (; at < lines.length; at++) {
    const line = lines[at] ?? ''
    if (line.trim() === '') {
      at += 1
      break
    }
    if (COMMENT.test(line)) note(line)
    else {
      const h = HEADER.exec(line)
      if (h !== null) headers.push({ name: h[1] ?? '', value: h[2] ?? '' })
    }
  }
  const body = stripHandlers(lines.slice(at)).join('\n').replace(/\s+$/, '')

  return { id: `${file}#${index}`, file, index, block, raw, name, method, url, headers, body, captures, prompts }
}

/** A `.http` file's lines cut at each `###` line, the `###` line starting its block; block 0 is what comes before the first. Joined again they are the file. */
export function httpBlocks(text: string): string[][] {
  const blocks: string[][] = [[]]
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('###')) blocks.push([line])
    else blocks.at(-1)?.push(line)
  }

  return blocks
}

/** A block's text as the editor shows it: without the blank lines that end it. */
export const blockText = (lines: readonly string[]) => lines.join('\n').replace(/\s+$/, '')

/** The requests of one `.http` file, separated by `###` lines (the text after `###` names the request its block starts). */
export function parseHttpFile(file: string, text: string): HttpRequest[] {
  const requests: Omit<HttpRequest, 'isOwnFile'>[] = []
  httpBlocks(text).forEach((lines, i) => {
    const hasTitle = i > 0
    const title = hasTitle ? (lines[0] ?? '').slice(3).trim() : ''
    const r = parseBlock(file, requests.length, i, blockText(lines), title, hasTitle ? lines.slice(1) : lines)
    if (r !== undefined) requests.push(r)
  })

  return requests.map(r => ({ ...r, isOwnFile: requests.length === 1 }))
}

/** `http-client.env.json`: each environment's variables (values that are not text become text; nested objects are dropped). Throws when it is not such an object. */
export function parseEnvFile(text: string): Record<string, Record<string, string>> {
  const data: unknown = JSON.parse(text)
  if (!isObject(data)) throw new Error('it is not a JSON object of environments ({ "dev": { "host": "…" } }).')
  const envs: Record<string, Record<string, string>> = {}
  for (const [env, vars] of Object.entries(data)) {
    if (!isObject(vars)) continue
    envs[env] = {}
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') envs[env][k] = String(v)
    }
  }

  return envs
}

/** The environments to pick from: all but `$shared`, which lies beneath every one of them. */
export const envNames = (envs: Record<string, Record<string, string>>) => Object.keys(envs).filter(e => !e.startsWith('$'))

export const envVars = (envs: Record<string, Record<string, string>>, env: string) => ({ ...envs.$shared, ...(env === '' ? {} : envs[env]) })

/** The variables `{{name}}` the request names (URL, headers, body), each once, in order; system ones (`{{$guid}}`) left out. */
export function variableNames(r: HttpRequest): string[] {
  const text = [r.url, ...r.headers.flatMap(h => [h.name, h.value]), r.body].join('\n')
  const names = [...text.matchAll(VARIABLE)].map(m => m[1] ?? '').filter(n => n !== '' && !n.startsWith('$'))

  return [...new Set(names)]
}

export const promptNames = (requests: readonly HttpRequest[]) => new Set(requests.flatMap(r => r.prompts.map(p => p.name)))

type VariableValues = { vars: Readonly<Record<string, string>>; secrets: readonly string[]; prompted: Readonly<Record<string, string>> }

/**
 * Where `{{name}}` takes its value from: a prompt (one of `prompts`, the `@prompt` names that apply; `unfilled` until it is filled in on
 * the request's page), a capture of this environment, the env file, a saved secret, or nowhere yet (`missing`, pasted under Environment).
 */
export function variableSource(
  v: VariableValues,
  captured: Readonly<Record<string, string>>,
  name: string,
  prompts: ReadonlySet<string>,
): 'prompt' | 'unfilled' | 'captured' | 'env' | 'secret' | 'missing' {
  if (prompts.has(name)) return Object.hasOwn(v.prompted, name) ? 'prompt' : 'unfilled'
  if (Object.hasOwn(captured, name)) return 'captured'
  if (Object.hasOwn(v.vars, name)) return 'env'

  return v.secrets.includes(name) ? 'secret' : 'missing'
}

/** The value of a variable from a prompt, a capture or the env file; undefined for a secret (read only to send) or none. */
export function variableValue(v: VariableValues, captured: Readonly<Record<string, string>>, name: string, source: ReturnType<typeof variableSource>) {
  if (source === 'prompt') return v.prompted[name]
  if (source === 'captured') return captured[name]

  return source === 'env' ? v.vars[name] : undefined
}

export const braced = (names: readonly string[]) => names.map(n => `{{${n}}}`).join(', ')

/** `text` with each `{{name}}` that `lookup` knows replaced; the rest stay as written. */
export const substitute = (text: string, lookup: (name: string) => string | undefined) =>
  text.replace(VARIABLE, (whole, name: string) => lookup(name) ?? whole)

/**
 * The value at `path` (`body`, `body.data.token`, `body.items[0].id`, `body.items.0.id`) of a JSON response, as text:
 * a string as it is, another value as JSON. undefined when the response has nothing there. Only a field path; nothing runs.
 */
export function capturePath(data: unknown, path: string): string | undefined {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.')
  if (parts[0] !== 'body') return undefined
  let at: unknown = data
  for (const part of parts.slice(1)) {
    if (Array.isArray(at) && /^\d+$/.test(part)) at = at[Number(part)]
    else if (isObject(at) && Object.hasOwn(at, part)) at = at[part]
    else return undefined
  }
  if (at === undefined) return undefined

  return typeof at === 'string' ? at : JSON.stringify(at)
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

const looksJson = (text: string) => /^\s*[[{]/.test(text)

/**
 * A JSON body with its comments (line and block) and the commas left before `}` or `]` taken out, as a server's JSON reader
 * (System.Text.Json) refuses them; what is inside strings stays. Sent when Content-Type names JSON, or there is none and the body looks like JSON.
 */
export function plainJson(text: string, contentType: string): string {
  if (!(contentType === '' ? looksJson(text) : /json/i.test(contentType))) return text
  let out = ''
  let at = 0
  while (at < text.length) {
    const c = text[at] ?? ''
    if (c === '"') {
      let end = at + 1
      while (end < text.length && text[end] !== '"' && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1
      out += text.slice(at, end + 1)
      at = end + 1
    } else if (text.startsWith('//', at)) {
      while (at < text.length && text[at] !== '\n') at += 1
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2)
      at = end < 0 ? text.length : end + 2
    } else {
      out += c
      at += 1
    }
  }

  // 註解拿掉後才看得到的：最後一項被註解掉，留下的逗號。
  return out.replace(/("(?:[^"\\\n]|\\.)*")|,(\s*[}\]])/g, (whole, str: string | undefined, close: string | undefined) => str ?? close ?? whole)
}

/** Adds a header to a record, a repeated one joined with `, ` as HTTP folds them. */
export function addHeader(headers: Record<string, string>, name: string, value: string) {
  headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`
}

/** The body as drawn: JSON laid out (by its content type, or when it parses as an object or list), cut to fit. */
export function formatBody(text: string, contentType: string) {
  const data = /json/i.test(contentType) || looksJson(text) ? parseJson(text) : undefined
  const isJson = data !== undefined && (/json/i.test(contentType) || typeof data === 'object')
  const cut = cutAtLineEnd(isJson ? JSON.stringify(data, null, 2) : text)

  return { body: cut.text, isTruncated: cut.isTruncated, isJson }
}

export function utf8Size(text: string): number {
  let size = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) size += 1
    else if (c < 0x800) size += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      size += 4
      i += 1
    } else size += 3
  }

  return size
}

/** A file's name as the panel shows it: without its folder and `.http`. */
export const fileTitle = (file: string) => splitPath(file).name.replace(/\.http$/i, '')

/** The folder under `.soap/http` a request file is in (one level), '' for none. */
export const folderOf = (file: string) => splitPath(file).dir

export const httpFolders = (requests: readonly HttpRequest[]) => [...new Set(requests.map(r => folderOf(r.file)))].filter(f => f !== '').sort(byName)

/** The request's name on the panel: its file's for a file's only request, else the text after `###`, else the method and URL. */
export const requestTitle = (r: HttpRequest) => (r.isOwnFile ? fileTitle(r.file) : r.name !== '' ? r.name : `${r.method} ${r.url}`)
