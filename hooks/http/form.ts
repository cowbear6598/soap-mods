import type { HttpResponse } from 'claude-code'

import type { HttpForm, HttpHeader, HttpPart, HttpRequest } from '../../types'
import { baseName } from '../services/scan'
import { CAPTURE_TAG, COMMENT, NAME_TAG, addHeader, looksJson, parseHttpFile, parseJson, substitute } from './parse'

/** The methods Method offers; formEditor adds one the file has that is not here (TRACE). */
export const FORM_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

const JSON_TYPE = 'application/json'
const FORM_TYPE = 'application/x-www-form-urlencoded'
const BOUNDARY = '----SoapBoundary'

/** The Folder picker's value for a new folder (a folder name cannot have a colon). */
export const NEW_FOLDER = ':new'

export const BLANK_FORM: HttpForm = { name: '', method: 'GET', url: '', headers: [], bodyKind: 'none', json: '', form: [], parts: [], captures: [] }

const isContentType = (h: { name: string }) => h.name.trim().toLowerCase() === 'content-type'

export const contentTypeOf = (headers: readonly HttpHeader[]) => headers.find(isContentType)?.value.trim() ?? ''

/** X of `multipart/form-data; boundary=X`; undefined when it is not multipart. */
export function multipartBoundary(contentType: string): string | undefined {
  return /^multipart\/form-data\s*;.*\bboundary=("?)([^";\s]+)\1/i.exec(contentType)?.[2]
}

/** A multipart body's fields: text, or a file `< path`. undefined when it is not readable (another boundary, a field with no name). */
function parseParts(body: string, boundary: string): HttpPart[] | undefined {
  const lines = body.split(/\r?\n/)
  if (lines[0]?.trim() !== `--${boundary}`) return undefined
  const parts: HttpPart[] = []
  let at = 1
  while (at < lines.length) {
    let disposition = ''
    for (; at < lines.length && (lines[at] ?? '').trim() !== ''; at++) {
      if (/^content-disposition\s*:/i.test(lines[at] ?? '')) disposition = lines[at] ?? ''
    }
    at += 1
    const content: string[] = []
    for (; at < lines.length && !(lines[at] ?? '').trim().startsWith(`--${boundary}`); at++) content.push(lines[at] ?? '')
    const end = lines[at]?.trim()
    const name = /;\s*name="([^"]*)"/i.exec(disposition)?.[1]
    if (end === undefined || name === undefined) return undefined
    const file = content.length === 1 ? /^<\s+(.+)$/.exec((content[0] ?? '').trim()) : null
    parts.push(file === null ? { name, value: content.join('\n'), isFile: false } : { name, value: (file[1] ?? '').trim(), isFile: true })
    at += 1
    if (end === `--${boundary}--`) return lines.slice(at).every(l => l.trim() === '') ? parts : undefined
  }

  return undefined
}

/** A request's multipart fields, by the boundary its Content-Type names; undefined when it is not multipart or not readable. */
export function partsOf(r: { headers: readonly HttpHeader[]; body: string }): HttpPart[] | undefined {
  const boundary = multipartBoundary(contentTypeOf(r.headers))

  return boundary === undefined ? undefined : parseParts(r.body, boundary)
}

function partsText(parts: readonly HttpPart[]) {
  const lines = parts.flatMap(p => {
    const file = p.isFile ? `; filename="${baseName(p.value)}"` : ''

    return [`--${BOUNDARY}`, `Content-Disposition: form-data; name="${p.name}"${file}`, '', p.isFile ? `< ${p.value}` : p.value]
  })

  return [...lines, `--${BOUNDARY}--`].join('\n')
}

// x-www-form-urlencoded：分隔用的字元（% & = 換行）編碼，{{變數}} 原樣留著（送出時才代換）。
const encodeForm = (text: string) =>
  text
    .split(/(\{\{[^{}]*\}\})/)
    .map((s, i) => (i % 2 === 1 ? s : s.replace(/[%&=\n]/g, c => encodeURIComponent(c))))
    .join('')

function formPairs(body: string): { name: string; value: string }[] | undefined {
  try {
    return body
      .split('\n')
      .map(l => l.trim())
      .join('')
      .split('&')
      .filter(p => p !== '')
      .map(p => {
        const at = p.indexOf('=')
        const [name, value] = at < 0 ? [p, ''] : [p.slice(0, at), p.slice(at + 1)]

        return { name: decodeURIComponent(name), value: decodeURIComponent(value) }
      })
  } catch {
    return undefined
  }
}

// 依 Body 的種類：body 的字和它的 Content-Type（沒有 body 都是 ''）。
function bodyOf(f: HttpForm) {
  const none = { type: '', text: '' }
  if (f.bodyKind === 'json') return f.json.trim() === '' ? none : { type: JSON_TYPE, text: f.json.replace(/\s+$/, '') }
  if (f.bodyKind === 'form') {
    const pairs = f.form.filter(p => p.name.trim() !== '')

    return pairs.length === 0 ? none : { type: FORM_TYPE, text: pairs.map(p => `${encodeForm(p.name.trim())}=${encodeForm(p.value)}`).join('&') }
  }
  if (f.bodyKind === 'multipart') {
    const parts = f.parts.filter(p => p.name.trim() !== '').map(p => ({ ...p, name: p.name.trim(), value: p.isFile ? p.value.trim() : p.value }))

    return parts.length === 0 ? none : { type: `multipart/form-data; boundary=${BOUNDARY}`, text: partsText(parts) }
  }

  return none
}

/**
 * The form as a request's block: `### name` (with hasTitle false, the block before the first ###, the name as `# @name`), `# @capture`, the method and URL, the headers, a blank line, the body.
 * The body's Content-Type is added: JSON and Form keep one written in Headers, multipart always uses BOUNDARY.
 */
export function formText(f: HttpForm, hasTitle: boolean): string {
  const lines: string[] = []
  const name = f.name.trim()
  if (hasTitle) lines.push(name === '' ? '###' : `### ${name}`)
  else if (name !== '') lines.push(`# @name ${name}`)
  for (const c of f.captures) if (c.name.trim() !== '') lines.push(`# @capture ${c.name.trim()} = ${c.value.trim()}`)
  lines.push(`${f.method} ${f.url.trim()}`)
  const body = bodyOf(f)
  const headers = f.headers.filter(h => h.name.trim() !== '' && !(f.bodyKind === 'multipart' && body.type !== '' && isContentType(h)))
  lines.push(...headers.map(h => `${h.name.trim()}: ${h.value}`))
  if (body.type !== '' && !headers.some(isContentType)) lines.push(`Content-Type: ${body.type}`)
  if (body.text !== '') lines.push('', body.text)

  return lines.join('\n')
}

// 表單留不住的行：@name、@capture 以外的註解、檔案變數（@x = 1）、回應的處理（> {% … %}、>> 檔案）。
const isExtraLine = (line: string) =>
  !line.startsWith('###') && ((COMMENT.test(line) && !NAME_TAG.test(line) && !CAPTURE_TAG.test(line)) || /^\s*@/.test(line) || /^>/.test(line))

// 表單寫回去跟原本讀到的一樣：headers 不管順序；原本沒寫 Content-Type 的，補上的不算不一樣；multipart 比欄位（boundary 換成這裡的）。
function isSameRequest(a: HttpRequest, b: HttpRequest | undefined) {
  if (b === undefined) return false
  const type = contentTypeOf(a.headers)
  const keep = (h: HttpHeader) => !isContentType(h) || (type !== '' && multipartBoundary(type) === undefined)
  const body = (r: HttpRequest) => partsOf(r) ?? r.body
  const headers = (r: HttpRequest) => JSON.stringify(r.headers.filter(keep).map(h => `${h.name}: ${h.value}`).sort())
  const fields = (r: HttpRequest) => JSON.stringify([r.name, r.method, r.url, body(r), r.captures])

  return fields(a) === fields(b) && headers(a) === headers(b)
}

// Body 的種類和它的欄位，自動補得回來的 Content-Type 不列在 Headers；表單裝不下的 body（XML、讀不懂的 multipart）是 undefined。
function bodyFields(r: HttpRequest, headers: HttpHeader[]): Partial<HttpForm> | undefined {
  if (r.body === '') return {}
  const type = contentTypeOf(r.headers)
  const without = (t: string) => headers.filter(h => !(isContentType(h) && h.value.trim().toLowerCase() === t))
  const parts = partsOf(r)
  if (parts !== undefined) return { bodyKind: 'multipart', parts, headers: headers.filter(h => !isContentType(h)) }
  if (multipartBoundary(type) !== undefined) return undefined
  if (/^application\/x-www-form-urlencoded\b/i.test(type)) {
    const form = formPairs(r.body)

    return form && { bodyKind: 'form', form, headers: without(FORM_TYPE) }
  }
  if (type === '' ? looksJson(r.body) : /json/i.test(type)) return { bodyKind: 'json', json: r.body, headers: without(JSON_TYPE) }

  return undefined
}

/** A block's text as the form; undefined when the form would not write the same request back (other comments, scripts, a body like XML), so it is edited as text. */
export function formOf(raw: string): HttpForm | undefined {
  const requests = parseHttpFile('', raw)
  const r = requests[0]
  if (requests.length !== 1 || r === undefined || raw.split('\n').some(isExtraLine)) return undefined
  const headers = r.headers.map(h => ({ name: h.name, value: h.value }))
  const body = bodyFields(r, headers)
  if (body === undefined) return undefined
  const form: HttpForm = {
    ...BLANK_FORM,
    name: r.name,
    method: r.method,
    url: r.url,
    headers,
    captures: r.captures.map(c => ({ name: c.name, value: c.path })),
    ...body,
  }

  return isSameRequest(r, parseHttpFile('', formText(form, raw.startsWith('###')))[0]) ? form : undefined
}

/** What is wrong with the form before Save, '' when nothing. */
export function formError(f: HttpForm): string {
  if (f.url.trim() === '') return 'Write the URL, like https://example.com/users or {{host}}/users.'
  if (/\s/.test(f.url.trim())) return 'The URL has a space in it.'
  if (f.headers.some(h => h.name.trim() !== '' && !/^[^:\s][^:]*$/.test(h.name.trim()))) return 'A header name has no : in it.'
  if (f.bodyKind === 'json' && f.json.trim() !== '' && parseJson(substitute(f.json, () => '0')) === undefined) {
    return 'The JSON body is not valid JSON ({{variables}} may stand for any value).'
  }
  if (f.bodyKind === 'multipart') {
    if (f.parts.some(p => p.name.includes('"'))) return 'A field name has no " in it.'
    if (f.parts.some(p => p.isFile && p.name.trim() !== '' && p.value.trim() === '')) return 'Write the path of each file field.'
  }
  if (f.captures.some(c => c.name.trim() !== '' && (!/^[\w.-]+$/.test(c.name.trim()) || !/^body(?:[.[]\S*)?$/.test(c.value.trim())))) {
    return 'A capture is a name (letters, digits, -, _ and .) and a path like body.data.token.'
  }

  return ''
}

// curl 設定檔的字串：雙引號裡 \ 和 " 跳脫，換行、tab 寫成 \n、\t。
const quote = (text: string) => `"${text.replace(/[\\"]/g, c => `\\${c}`).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`

/** A multipart request as curl sends it; a file field's value is its absolute path. */
export type CurlRequest = { method: string; url: string; headers: readonly HttpHeader[]; parts: readonly HttpPart[] }

/**
 * curl's config for a multipart request, given on stdin (curl --config -) so no value shows in the process list.
 * Content-Type and Content-Length are left out: curl writes its own, with its own boundary.
 */
export function curlConfig(req: CurlRequest, timeoutMs: number): string {
  const headers = req.headers.filter(h => !isContentType(h) && h.name.trim().toLowerCase() !== 'content-length')
  const fields = req.parts.map(p =>
    p.isFile ? `form = ${quote(`${p.name}=@"${p.value.replace(/[\\"]/g, c => `\\${c}`)}"`)}` : `form-string = ${quote(`${p.name}=${p.value}`)}`,
  )

  return [
    'silent',
    'show-error',
    'include',
    `max-time = ${Math.ceil(timeoutMs / 1000)}`,
    `request = ${quote(req.method)}`,
    `url = ${quote(req.url)}`,
    ...headers.map(h => `header = ${quote(`${h.name}: ${h.value}`)}`),
    ...fields,
    '',
  ].join('\n')
}

/** What curl --include printed: the status, the headers (lower-cased names), the body; a 1xx (100 Continue) is skipped. undefined when it is no HTTP answer. */
export function curlResponse(out: string): HttpResponse | undefined {
  let rest = out
  for (;;) {
    const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(rest)?.[1] ?? NaN)
    if (Number.isNaN(status)) return undefined
    const end = /\r?\n\r?\n/.exec(rest)
    const head = end === null ? rest : rest.slice(0, end.index)
    const text = end === null ? '' : rest.slice(end.index + end[0].length)
    if (status < 200 && /^HTTP\//.test(text)) {
      rest = text
      continue
    }
    const headers: Record<string, string> = {}
    for (const line of head.split(/\r?\n/).slice(1)) {
      const h = /^([^:]+):\s*(.*)$/.exec(line)
      if (h !== null) addHeader(headers, (h[1] ?? '').trim().toLowerCase(), h[2] ?? '')
    }

    return { status, ok: status >= 200 && status < 300, headers, text }
  }
}
