// unified diff 的 hunk → 一行一列，改掉的那一行裡再標出哪幾個字詞變了（給差異畫面反白用）。

import { diffLines } from '../merge/algo'

/** A piece of a diff line: `isChanged` when it differs from the line it is paired with. */
export type DiffSeg = { text: string; isChanged: boolean }

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'same' | 'add' | 'remove'; line: number; segs: DiffSeg[] }

// 一行切太多字詞就不比了（Myers 的記憶體隨差異數平方長；長行標字詞也沒什麼用），整行照一般改動畫。
const MAX_LINE_TOKENS = 200
// 兩行變掉的字元超過這個比例，就算整行重寫，不標字詞（不然整行都反白，反而難讀）。
const MAX_CHANGED_RATIO = 0.6

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

// 字詞、一段空白、或單一個符號各算一個 token。
const tokenize = (line: string) => line.match(/[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu) ?? []

const whole = (text: string): DiffSeg[] => (text === '' ? [] : [{ text, isChanged: false }])

/** Joins neighbouring tokens with the same mark into one piece. */
function toSegs(tokens: string[], isChanged: boolean[]): DiffSeg[] {
  const segs: DiffSeg[] = []
  tokens.forEach((text, i) => {
    const mark = isChanged[i] ?? false
    const last = segs[segs.length - 1]
    if (last !== undefined && last.isChanged === mark) last.text += text
    else segs.push({ text, isChanged: mark })
  })

  return segs
}

/** A removed line and the added line that replaced it → each one's pieces, the words that changed marked. */
export function wordDiff(before: string, after: string): { before: DiffSeg[]; after: DiffSeg[] } {
  const a = tokenize(before)
  const b = tokenize(after)
  if (a.length > MAX_LINE_TOKENS || b.length > MAX_LINE_TOKENS) return { before: whole(before), after: whole(after) }

  const aChanged = a.map(() => false)
  const bChanged = b.map(() => false)
  for (const h of diffLines(a, b)) {
    for (let i = h.aStart; i < h.aEnd; i += 1) aChanged[i] = true
    for (let i = h.bStart; i < h.bEnd; i += 1) bChanged[i] = true
  }
  // 只算非空白的字：改了縮排不算整行重寫。
  let changed = 0
  let total = 0
  const count = (tokens: string[], marks: boolean[]) =>
    tokens.forEach((t, i) => {
      if (/^\s/.test(t)) return
      total += t.length
      if (marks[i] === true) changed += t.length
    })
  count(a, aChanged)
  count(b, bChanged)
  if (total > 0 && changed / total > MAX_CHANGED_RATIO) {
    return { before: whole(before), after: whole(after) }
  }

  return { before: toSegs(a, aChanged), after: toSegs(b, bChanged) }
}

/**
 * Unified-diff hunks (what toHunks keeps) → one row per line, numbered: a
 * removed line by its old number, any other by its new one, tabs turned into
 * spaces (Text takes no control characters). A run of removed lines followed
 * by added lines is paired line by line, and each pair's changed words are marked.
 */
export function parseDiffRows(source: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let removed: string[] = []
  let added: string[] = []

  const flush = () => {
    const pairs = Math.min(removed.length, added.length)
    const marked = removed.slice(0, pairs).map((r, i) => wordDiff(r, added[i] ?? ''))
    removed.forEach((text, i) => {
      rows.push({ kind: 'remove', line: oldLine, segs: marked[i]?.before ?? whole(text) })
      oldLine += 1
    })
    added.forEach((text, i) => {
      rows.push({ kind: 'add', line: newLine, segs: marked[i]?.after ?? whole(text) })
      newLine += 1
    })
    removed = []
    added = []
  }

  for (const raw of source.split('\n')) {
    const header = HUNK_HEADER.exec(raw)
    if (header !== null) {
      flush()
      oldLine = Number(header[1])
      newLine = Number(header[2])
      rows.push({ kind: 'hunk', text: raw })
      continue
    }
    const mark = raw[0]
    const text = raw.slice(1).replace(/\t/g, '    ')
    if (mark === '-') {
      // 加的行後面又出現減的行：前一組先收掉，這是新的一組。
      if (added.length > 0) flush()
      removed.push(text)
    } else if (mark === '+') {
      added.push(text)
    } else if (mark === ' ') {
      flush()
      rows.push({ kind: 'same', line: newLine, segs: whole(text) })
      oldLine += 1
      newLine += 1
    }
    // `\ No newline at end of file` 和空行略過。
  }
  flush()

  return rows
}
