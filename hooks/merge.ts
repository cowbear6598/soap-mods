import type { GitFile, MergeChoice, MergeChunk, MergeOp, MergeText } from '../types'

const OURS_MARK = '<<<<<<<'
const BASE_MARK = '|||||||'
const SPLIT_MARK = '======='
const THEIRS_MARK = '>>>>>>>'

const isMark = (line: string, mark: string) => line === mark || line.startsWith(`${mark} `)
const markLabel = (line: string) => line.slice(OURS_MARK.length).trim()
const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((line, i) => line === b[i])

/** A file's text → its lines, without the line ends and without the empty one after a final newline. */
export function splitLines(text: string): string[] {
  const lines = text.split(/\r?\n/)
  if (text.endsWith('\n')) lines.pop()

  return lines
}

/**
 * A conflicted file's text → the lines both sides agree on and the conflicts
 * between them, every conflict unresolved. Null when the text holds no whole
 * conflict (no markers, or a `<<<<<<<` that never closes).
 */
export function parseConflicts(text: string): MergeText | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const hasFinalEol = text.endsWith('\n')
  const lines = splitLines(text)

  const chunks: MergeChunk[] = []
  let same: string[] = []
  let oursLabel = ''
  let theirsLabel = ''
  const flushSame = () => {
    if (same.length > 0) chunks.push({ kind: 'same', lines: same })
    same = []
  }

  let i = 0
  while (i < lines.length) {
    const start = lines[i] ?? ''
    if (!isMark(start, OURS_MARK)) {
      same.push(start)
      i += 1
      continue
    }

    const ours: string[] = []
    let base: string[] | null = null
    const theirs: string[] = []
    let part: 'ours' | 'base' | 'theirs' = 'ours'
    let end = -1
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j] ?? ''
      if (part === 'ours' && isMark(line, BASE_MARK)) {
        part = 'base'
        base = []
      } else if (part !== 'theirs' && line === SPLIT_MARK) {
        part = 'theirs'
      } else if (part === 'theirs' && isMark(line, THEIRS_MARK)) {
        end = j
        break
      } else {
        ;(part === 'ours' ? ours : part === 'base' ? (base ?? []) : theirs).push(line)
      }
    }
    if (end === -1) return null

    if (oursLabel === '') oursLabel = markLabel(start)
    if (theirsLabel === '') theirsLabel = markLabel(lines[end] ?? '')
    flushSame()
    chunks.push({ kind: 'conflict', ours, base, theirs, choice: 'none' })
    i = end + 1
  }
  flushSame()

  if (!chunks.some(c => c.kind === 'conflict')) return null

  return { chunks, eol, hasFinalEol, oursLabel, theirsLabel }
}

/** One place where `a` and `b` differ: `a[aStart, aEnd)` became `b[bStart, bEnd)`. */
export type DiffHunk = { aStart: number; aEnd: number; bStart: number; bEnd: number }

// The diff keeps a row per step, so its memory grows with the square of the
// differences; past this many it stops and calls the whole middle one change.
const MAX_DIFF_EDITS = 2000

/**
 * The places where two lists of lines differ, in order (Myers' diff, the
 * shortest edit; the common head and tail are trimmed first). Past
 * MAX_DIFF_EDITS differences, the whole trimmed middle is one change.
 */
export function diffLines(a: string[], b: string[]): DiffHunk[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let endA = a.length
  let endB = b.length
  while (endA > head && endB > head && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }
  const n = endA - head
  const m = endB - head
  if (n === 0 && m === 0) return []
  if (n === 0 || m === 0) return [{ aStart: head, aEnd: endA, bStart: head, bEnd: endB }]

  const same = (x: number, y: number) => a[head + x] === b[head + y]
  const max = n + m
  const off = max + 1
  // v[off + k]: how far along `a` the furthest path on diagonal k (x - y) reached.
  const v = new Int32Array(2 * max + 3)
  // trace[d]: v after round d, for k in [-d - 1, d + 1] (index k + d + 1).
  const trace: Int32Array[] = []
  for (let d = 0; d <= max; d += 1) {
    if (d > MAX_DIFF_EDITS) return [{ aStart: head, aEnd: endA, bStart: head, bEnd: endB }]
    let isDone = false
    for (let k = -d; k <= d; k += 2) {
      const isDown = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0))
      let x = isDown ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1
      let y = x - k
      while (x < n && y < m && same(x, y)) {
        x += 1
        y += 1
      }
      v[off + k] = x
      if (x >= n && y >= m) {
        isDone = true
        break
      }
    }
    trace.push(v.slice(off - d - 1, off + d + 2))
    if (isDone) break
  }

  // Walk back from the end, keeping the lines both share (latest first).
  const shared: [number, number][] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const prev = trace[d - 1] ?? new Int32Array(0)
    const at = (k: number) => prev[k + d] ?? 0
    const k = x - y
    const isDown = k === -d || (k !== d && at(k - 1) < at(k + 1))
    const prevK = isDown ? k + 1 : k - 1
    const prevX = at(prevK)
    const startX = isDown ? prevX : prevX + 1
    while (x > startX) {
      x -= 1
      y -= 1
      shared.push([x, y])
    }
    x = prevX
    y = prevX - prevK
  }
  while (x > 0 && y > 0) {
    x -= 1
    y -= 1
    shared.push([x, y])
  }
  shared.reverse()

  const hunks: DiffHunk[] = []
  let pa = 0
  let pb = 0
  for (const [sa, sb] of [...shared, [n, m] as [number, number]]) {
    if (sa > pa || sb > pb) hunks.push({ aStart: head + pa, aEnd: head + sa, bStart: head + pb, bEnd: head + sb })
    pa = sa + 1
    pb = sb + 1
  }

  return hunks
}

type SideChange = { side: 'ours' | 'theirs'; baseStart: number; baseEnd: number; lines: string[] }

/**
 * The three versions git keeps of a conflicted file → its pieces, as a
 * three-way merge reads them: what neither side touched, what one side
 * changed (or both changed alike), which merges by itself, and the places
 * both sides changed differently, or right next to each other, which
 * conflict. With no base (both sides added the file) the two are compared
 * with each other: what they share is kept, every difference a conflict.
 */
export function merge3(base: string[] | null, ours: string[], theirs: string[]): MergeChunk[] {
  const chunks: MergeChunk[] = []
  const pushSame = (lines: string[]) => {
    if (lines.length > 0) chunks.push({ kind: 'same', lines })
  }

  if (base === null) {
    let at = 0
    for (const h of diffLines(ours, theirs)) {
      pushSame(ours.slice(at, h.aStart))
      chunks.push({
        kind: 'conflict',
        ours: ours.slice(h.aStart, h.aEnd),
        base: null,
        theirs: theirs.slice(h.bStart, h.bEnd),
        choice: 'none',
      })
      at = h.aEnd
    }
    pushSame(ours.slice(at))

    return chunks
  }

  const changes: SideChange[] = [
    ...diffLines(base, ours).map(h => ({ side: 'ours' as const, baseStart: h.aStart, baseEnd: h.aEnd, lines: ours.slice(h.bStart, h.bEnd) })),
    ...diffLines(base, theirs).map(h => ({ side: 'theirs' as const, baseStart: h.aStart, baseEnd: h.aEnd, lines: theirs.slice(h.bStart, h.bEnd) })),
  ].sort((p, q) => p.baseStart - q.baseStart || p.baseEnd - q.baseEnd)

  // One side's version of base[lo, hi): its changes there, the base between them.
  const region = (group: SideChange[], side: 'ours' | 'theirs', lo: number, hi: number) => {
    const lines: string[] = []
    let at = lo
    for (const c of group) {
      if (c.side !== side) continue
      lines.push(...base.slice(at, c.baseStart), ...c.lines)
      at = c.baseEnd
    }
    lines.push(...base.slice(at, hi))

    return lines
  }

  let at = 0
  let i = 0
  while (i < changes.length) {
    const first = changes[i]
    if (first === undefined) break
    // Changes that overlap or touch (one ends where the next starts) are one place.
    const group = [first]
    let lo = first.baseStart
    let hi = first.baseEnd
    i += 1
    for (let next = changes[i]; next !== undefined && next.baseStart <= hi; next = changes[i]) {
      group.push(next)
      lo = Math.min(lo, next.baseStart)
      hi = Math.max(hi, next.baseEnd)
      i += 1
    }

    pushSame(base.slice(at, lo))
    at = hi
    const oursLines = region(group, 'ours', lo, hi)
    const theirsLines = region(group, 'theirs', lo, hi)
    const baseLines = base.slice(lo, hi)
    const hasOurs = group.some(c => c.side === 'ours')
    const hasTheirs = group.some(c => c.side === 'theirs')
    const isAlike = sameLines(oursLines, theirsLines)
    if (hasOurs && hasTheirs && !isAlike) {
      chunks.push({ kind: 'conflict', ours: oursLines, base: baseLines, theirs: theirsLines, choice: 'none' })
    } else {
      const from = hasOurs && hasTheirs ? 'both' : hasOurs ? 'ours' : 'theirs'
      chunks.push({ kind: 'auto', from, base: baseLines, ours: oursLines, theirs: theirsLines, isApplied: true })
    }
  }
  pushSame(base.slice(at))

  return chunks
}

/** Whether a conflict's choice puts that side's lines in the result. */
export function takesSide(choice: MergeChoice, side: 'ours' | 'theirs'): boolean {
  return choice === side || choice === 'ours-theirs' || choice === 'theirs-ours'
}

/** The lines a conflict's choice puts in the result; null while unresolved. */
function resolvedLines(chunk: Extract<MergeChunk, { kind: 'conflict' }>): string[] | null {
  switch (chunk.choice) {
    case 'ours':
      return chunk.ours
    case 'theirs':
      return chunk.theirs
    case 'ours-theirs':
      return [...chunk.ours, ...chunk.theirs]
    case 'theirs-ours':
      return [...chunk.theirs, ...chunk.ours]
    default:
      return null
  }
}

/** The lines a piece puts in the result; null for a conflict still unresolved. */
export function chunkResult(chunk: MergeChunk): string[] | null {
  if (chunk.kind === 'same') return chunk.lines
  if (chunk.kind === 'conflict') return resolvedLines(chunk)
  if (!chunk.isApplied) return chunk.base

  return chunk.from === 'theirs' ? chunk.theirs : chunk.ours
}

/** Every conflict's choice set. */
export function isResolved(chunks: MergeChunk[]): boolean {
  return chunks.every(c => c.kind !== 'conflict' || c.choice !== 'none')
}

/**
 * The file's new text: each piece as it stands in the result. A conflict
 * still unresolved keeps its markers, so nothing is lost.
 */
export function buildResult(merge: MergeText): string {
  const lines: string[] = []
  for (const c of merge.chunks) {
    const result = chunkResult(c)
    if (result !== null) {
      lines.push(...result)
      continue
    }
    if (c.kind !== 'conflict') continue
    lines.push(`${OURS_MARK} ${merge.oursLabel}`.trimEnd(), ...c.ours)
    if (c.base !== null) lines.push(BASE_MARK, ...c.base)
    lines.push(SPLIT_MARK, ...c.theirs, `${THEIRS_MARK} ${merge.theirsLabel}`.trimEnd())
  }
  if (lines.length === 0) return ''

  return lines.join(merge.eol) + (merge.hasFinalEol ? merge.eol : '')
}

/** Sets one conflict's choice; the others are kept. */
export function choose(chunks: MergeChunk[], index: number, choice: MergeChoice): MergeChunk[] {
  return chunks.map((c, i) => (i === index && c.kind === 'conflict' ? { ...c, choice } : c))
}

/** Sets every conflict's choice: the "all ours" / "all theirs" buttons. */
export function chooseAll(chunks: MergeChunk[], choice: MergeChoice): MergeChunk[] {
  return chunks.map(c => (c.kind === 'conflict' ? { ...c, choice } : c))
}

/** Undoes an automatically merged change, or puts it back. */
export function toggleApplied(chunks: MergeChunk[], index: number): MergeChunk[] {
  return chunks.map((c, i) => (i === index && c.kind === 'auto' ? { ...c, isApplied: !c.isApplied } : c))
}

/**
 * After the file was read again: what the person chose on the pieces that are
 * still the same (same place, same kind, same two sides) carries over: a
 * conflict's choice, an undone change. The rest start over.
 */
export function keepChoices(previous: MergeChunk[], next: MergeChunk[]): MergeChunk[] {
  const before = previous.filter(c => c.kind !== 'same')
  let n = 0

  return next.map(c => {
    if (c.kind === 'same') return c
    const old = before[n]
    n += 1
    if (old === undefined || old.kind !== c.kind) return c
    const isSame = sameLines(old.ours, c.ours) && sameLines(old.theirs, c.theirs)
    if (!isSame) return c
    if (old.kind === 'conflict' && c.kind === 'conflict') return { ...c, choice: old.choice }
    if (old.kind === 'auto' && c.kind === 'auto') return { ...c, isApplied: old.isApplied }

    return c
  })
}

/** What the two sides did to a conflicted file, from its status letters. */
export function conflictLabel(file: GitFile): string {
  switch (`${file.x}${file.y}`) {
    case 'UU':
      return 'both modified'
    case 'AA':
      return 'both added'
    case 'DD':
      return 'both deleted'
    case 'AU':
      return 'added by us'
    case 'UA':
      return 'added by them'
    case 'DU':
      return 'deleted by us'
    case 'UD':
      return 'deleted by them'
    default:
      return 'conflict'
  }
}

/** Which operation stopped for conflicts, from the names in the git dir. */
export function detectOp(names: string[]): MergeOp {
  const has = (n: string) => names.includes(n)
  if (has('rebase-merge') || has('rebase-apply')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'

  return ''
}
