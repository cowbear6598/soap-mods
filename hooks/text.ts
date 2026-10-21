// 文字共用的處理：給 Code 畫的文字（差異、檔案內容）、拼進正規表示式的字。

import { CODE_MAX_CHARS } from './config'

/** `s` with every regular expression special character escaped, to match it literally. */
export const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` cut to `width` characters, its last one an ellipsis, when it is longer. */
export const truncate = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)

/** A name (a job, a branch) that looks like production: its confirm button says Confirm PROD. */
export const isProd = (...names: string[]) => names.some(n => /prod/i.test(n))

/** `page` (from 0), or the last page of `total` items `size` a page when it is past it: the list got shorter. */
export const clampPage = (page: number, total: number, size: number) => Math.min(page, Math.max(0, Math.ceil(total / size) - 1))

/** `text` whole when it fits CODE_MAX_CHARS, else cut at the last line end within it so the last line is whole. */
export function cutAtLineEnd(text: string): { text: string; isTruncated: boolean } {
  if (text.length <= CODE_MAX_CHARS) return { text, isTruncated: false }
  const cut = text.lastIndexOf('\n', CODE_MAX_CHARS)

  return { text: text.slice(0, cut === -1 ? CODE_MAX_CHARS : cut), isTruncated: true }
}
