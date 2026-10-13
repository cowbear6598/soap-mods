// 給 Code 畫的文字（差異、檔案內容）共用的處理。

import { CODE_MAX_CHARS } from './config'

/** `text` whole when it fits CODE_MAX_CHARS, else cut at the last line end within it so the last line is whole. */
export function cutAtLineEnd(text: string): { text: string; isTruncated: boolean } {
  if (text.length <= CODE_MAX_CHARS) return { text, isTruncated: false }
  const cut = text.lastIndexOf('\n', CODE_MAX_CHARS)

  return { text: text.slice(0, cut === -1 ? CODE_MAX_CHARS : cut), isTruncated: true }
}
