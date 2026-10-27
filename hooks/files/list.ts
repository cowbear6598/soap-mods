// Files 分頁的純邏輯：排序資料夾內容、算路徑、走資料夾樹、整理要看的檔案內容、寫檔案大小。

import type { FsEntry } from 'claude-code'

import type { FilesView, FolderEntry } from '../../types'
import { FILES_WALK_BATCH } from '../config'
import { hasWords, searchWords } from '../search'
import { cutAtLineEnd } from '../text'

// node_modules 這種上千個的也要排；共用一個 Collator 比每次 localeCompare 快很多。不分大小寫，file2 排在 file10 前面。
export const byName = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true }).compare

/** Folders first, then the rest, each by name. */
export function sortEntries(list: readonly FsEntry[]): FolderEntry[] {
  return list
    .map(e => ({ name: e.name, kind: e.kind, size: e.size }))
    .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || byName(a.name, b.name))
}

/** `dir` (relative, '' is the top) with `name` added. */
export const childPath = (dir: string, name: string) => (dir === '' ? name : `${dir}/${name}`)

/** `dir` (relative, '' is the top) under the session folder `root`. */
export const absPath = (root: string, dir: string) => (dir === '' ? root : `${root}/${dir}`)

/** The listed files (not folders) of `files`, or the search's, as paths: what a file view's Previous / Next step through. */
export const fileSteps = (files: FilesView) =>
  files.found?.paths ?? files.entries.filter(e => e.kind !== 'dir').map(e => childPath(files.dir, e.name))

/**
 * Takes paths one at a time and keeps the first `limit` holding every word of `query`, ignoring case:
 * those whose file name matches first, each group in the order taken; `total` counts them all.
 */
export function pathMatcher(query: string, limit: number) {
  const words = searchWords(query)
  const byFileName: string[] = []
  const byFolder: string[] = []
  let total = 0

  return {
    add(path: string) {
      const lower = path.toLowerCase()
      if (!hasWords(lower, words)) return
      total += 1
      const group = hasWords(lower.slice(lower.lastIndexOf('/') + 1), words) ? byFileName : byFolder
      if (group.length < limit) group.push(path)
    },
    result: () => ({ paths: [...byFileName, ...byFolder].slice(0, limit), total }),
  }
}

/** pathMatcher over `paths` (already sorted by byName). */
export function matchPaths(paths: readonly string[], query: string, limit: number): { paths: string[]; total: number } {
  const matcher = pathMatcher(query, limit)
  for (const path of paths) matcher.add(path)

  return matcher.result()
}

/**
 * A file's text as `Code` takes it: CRLF to LF, no control characters but tab and newline,
 * cut at a line end (cutAtLineEnd). null for a binary file (a NUL, or bytes that are not text).
 */
export function viewText(raw: string): { text: string; isTruncated: boolean } | null {
  if (raw.includes('\0') || raw.includes('\uFFFD')) return null

  return cutAtLineEnd(raw.replace(/\r\n?|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, m => (m[0] === '\r' ? '\n' : '')))
}

/** `{ num: '4.2', unit: 'KB' }`: one decimal past bytes, at most three digits before it. */
export function sizeParts(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  // 到 1000 就換下一個單位（四捨五入後的也算），數字最多三位整數：最寬是「999.9 KB」。
  while (Number(n.toFixed(1)) >= 1000 && i < units.length - 1) {
    n /= 1024
    i += 1
  }

  return { num: i === 0 ? String(n) : n.toFixed(1), unit: units[i] ?? '' }
}

/** `812 B`, `4.2 KB`, `13.0 MB`. */
export function formatSize(bytes: number) {
  const { num, unit } = sizeParts(bytes)

  return `${num} ${unit}`
}

export type Found = { path: string; size: number }

export type WalkRule = {
  list: (abs: string) => Promise<FsEntry[]>
  skipDir: (name: string) => boolean
  // 收一個檔案（相對 base）；回 false 就整個停下來，那個檔案也不算收到。repoFiles 列出來的沒有 entry。
  take: (path: string, entry?: FsEntry) => boolean
  // 底下有 .git 的資料夾（相對 base）不往下列，改問它有哪些檔案：相對它，結尾是 / 的是沒追蹤的另一個 repo，再往下走；
  // 給 undefined 就照常列資料夾。
  repoFiles?: (dir: string) => Promise<string[] | undefined>
}

type Child = { path: string; isDir: boolean; entry?: FsEntry }

// 由上往下走 base 底下，一次讀 FILES_WALK_BATCH 個資料夾，不排序也不存。每批讀完問一次 onBatch，回 false 就停。
// 全部走完回 true；base 本身列不出來就丟出去，底下的資料夾讀不到就略過。
export async function walkTree(base: string, rule: WalkRule, onBatch: () => Promise<boolean> = async () => true) {
  const { list, skipDir, take, repoFiles } = rule
  const children = async (dir: string): Promise<Child[]> => {
    const entries = dir === '' ? await list(base) : await list(absPath(base, dir)).catch(() => [])
    const tracked = repoFiles !== undefined && entries.some(e => e.name === '.git') ? await repoFiles(dir) : undefined
    if (tracked !== undefined) {
      return tracked.map(p => (p.endsWith('/') ? { path: childPath(dir, p.slice(0, -1)), isDir: true } : { path: childPath(dir, p), isDir: false }))
    }

    return entries.filter(e => e.kind !== 'dir' || !skipDir(e.name)).map(e => ({ path: childPath(dir, e.name), isDir: e.kind === 'dir', entry: e }))
  }

  const queue = ['']
  while (queue.length > 0) {
    const lists = await Promise.all(queue.splice(0, FILES_WALK_BATCH).map(children))
    for (const c of lists.flat()) {
      if (c.isDir) queue.push(c.path)
      else if (!take(c.path, c.entry)) return false
    }
    if (!(await onBatch())) return false
  }

  return true
}

/** A file's stamp: its modified time and size. The same stamp, the same contents; a reread skips reading it. */
export const statStamp = (stat: { mtimeMs: number; size: number }) => `${stat.mtimeMs}:${stat.size}`
