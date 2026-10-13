// Files 分頁的純邏輯：排序資料夾內容、算路徑、寫檔案大小。

import type { FsEntry } from 'claude-code'

import type { FolderEntry } from '../../types'

// node_modules 這種上千個的也要排；共用一個 Collator 比每次 localeCompare 快很多。不分大小寫，file2 排在 file10 前面。
const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare

/** Folders first, then the rest, each by name. */
export function sortEntries(list: readonly FsEntry[]): FolderEntry[] {
  return list
    .map(e => ({ name: e.name, kind: e.kind, size: e.size }))
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || byName(a.name, b.name))
}

/** `dir` (relative, '' is the top) with `name` added. */
export const childPath = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`)

/** `812 B`, `4.2 KB`, `13 MB`: one decimal below 10. */
export function formatSize(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }

  return `${i === 0 || n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}
