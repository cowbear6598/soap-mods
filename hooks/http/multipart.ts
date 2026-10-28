import type { HttpResponse } from 'claude-code'

import type { HttpHeader, HttpPart } from '../../types'
import { addHeader } from './parse'

const isContentType = (h: { name: string }) => h.name.trim().toLowerCase() === 'content-type'

export const contentTypeOf = (headers: readonly HttpHeader[]) => headers.find(isContentType)?.value.trim() ?? ''

/** X of `multipart/form-data; boundary=X`; undefined when it is not multipart. */
function multipartBoundary(contentType: string): string | undefined {
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
