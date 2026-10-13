import { expect, test } from 'claude-code/testing'

import type { MergeChunk } from '../../types'
import { CONFLICTED } from '../test-fixtures'
import type { DiffHunk } from '../../hooks/merge/algo'
import {
  buildResult,
  choose,
  chooseAll,
  conflictLabel,
  detectOp,
  diffLines,
  isResolved,
  keepChoices,
  merge3,
  nextConflict,
  parseConflicts,
  toggleApplied,
} from '../../hooks/merge/algo'

test('parseConflicts splits agreed lines from conflicts, with labels, base, CRLF and the final newline', () => {
  const parsed = parseConflicts(CONFLICTED)
  expect(parsed).toEqual({
    chunks: [
      { kind: 'same', lines: ['import a'] },
      { kind: 'conflict', ours: ['const x = 1'], base: null, theirs: ['const x = 2'], choice: 'none' },
      { kind: 'same', lines: ['end'] },
    ],
    eol: '\n',
    hasFinalEol: true,
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
  })

  // diff3：||||||| 後面是共同祖先；CRLF 和沒有結尾換行都照原樣寫回去。
  const diff3 = ['<<<<<<< HEAD', 'a', '||||||| base', 'o', '=======', 'b', '>>>>>>> dev'].join('\r\n')
  const d = parseConflicts(diff3)
  if (d === null) throw new Error('parse failed')
  expect(d.chunks).toEqual([{ kind: 'conflict', ours: ['a'], base: ['o'], theirs: ['b'], choice: 'none' }])
  expect(d.eol).toBe('\r\n')
  expect(d.hasFinalEol).toBe(false)
  expect(buildResult({ ...d, chunks: choose(d.chunks, 0, 'theirs-ours') })).toBe('b\r\na')

  // 沒有標記、或 <<<<<<< 沒有收尾，都不能一段一段選。
  expect(parseConflicts('plain\ntext\n')).toBeNull()
  expect(parseConflicts('<<<<<<< HEAD\na\n=======\nb\n')).toBeNull()
})

test('buildResult keeps the markers of a conflict still unresolved, and keepChoices carries unchanged conflicts', () => {
  const parsed = parseConflicts(CONFLICTED)
  if (parsed === null) throw new Error('parse failed')
  expect(isResolved(parsed.chunks)).toBe(false)
  expect(buildResult(parsed)).toBe(CONFLICTED)

  const ours = choose(parsed.chunks, 1, 'ours')
  expect(isResolved(ours)).toBe(true)
  expect(buildResult({ ...parsed, chunks: ours })).toBe('import a\nconst x = 1\nend\n')
  expect(buildResult({ ...parsed, chunks: choose(parsed.chunks, 1, 'ours-theirs') })).toBe('import a\nconst x = 1\nconst x = 2\nend\n')

  // 重讀後同一段衝突沒變：保留選擇；內容變了：重新選。
  expect(keepChoices(ours, parsed.chunks)).toEqual(ours)
  const changed = parseConflicts(CONFLICTED.replace('const x = 2', 'const x = 3'))
  if (changed === null) throw new Error('parse failed')
  expect(keepChoices(ours, changed.chunks)).toEqual(changed.chunks)
})

// 照 diffLines 的結果把 a 改一遍，應該剛好變成 b。
function applyHunks(a: string[], b: string[], hunks: DiffHunk[]) {
  const out: string[] = []
  let at = 0
  for (const h of hunks) {
    out.push(...a.slice(at, h.aStart), ...b.slice(h.bStart, h.bEnd))
    at = h.aEnd
  }

  return [...out, ...a.slice(at)]
}

test('diffLines finds the changed places, and applying them turns one list into the other', () => {
  expect(diffLines([], [])).toEqual([])
  expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }])
  expect(diffLines(['a', 'b'], ['a', 'b', 'c'])).toEqual([{ aStart: 2, aEnd: 2, bStart: 2, bEnd: 3 }])
  // 中間夾著沒變的行：是兩個分開的改動。
  expect(diffLines(['a', 'b', 'c', 'd', 'e'], ['a', 'B', 'c', 'd', 'E'])).toEqual([
    { aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 },
    { aStart: 4, aEnd: 5, bStart: 4, bEnd: 5 },
  ])

  // 亂數產生的清單：改完一定變成另一份，而且一行沒變的話一定沒有改動。
  let seed = 7
  const rand = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
  }
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)] ?? 'a')
    const b = Array.from({ length: rand(12) }, () => 'abcd'[rand(4)] ?? 'a')
    expect(applyHunks(a, b, diffLines(a, b))).toEqual(b)
    expect(diffLines(a, a)).toEqual([])
  }
})

test('merge3 tells changes one side made from conflicts, as git merges them', () => {
  const base = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  // 兩邊改不同的地方：各自自動合入。
  const chunks = merge3(base, ['a', 'B', 'c', 'd', 'e', 'f', 'g'], ['a', 'b', 'c', 'd', 'e', 'F', 'g'])
  expect(chunks).toEqual([
    { kind: 'same', lines: ['a'] },
    { kind: 'auto', from: 'ours', base: ['b'], ours: ['B'], theirs: ['b'], isApplied: true },
    { kind: 'same', lines: ['c', 'd', 'e'] },
    { kind: 'auto', from: 'theirs', base: ['f'], ours: ['f'], theirs: ['F'], isApplied: true },
    { kind: 'same', lines: ['g'] },
  ])
  const merged = { chunks, eol: '\n' as const, hasFinalEol: true, oursLabel: '', theirsLabel: '' }
  expect(isResolved(chunks)).toBe(true)
  expect(buildResult(merged)).toBe('a\nB\nc\nd\ne\nF\ng\n')
  // Undo 一個自動合入的改動：結果留原本的樣子。
  expect(buildResult({ ...merged, chunks: toggleApplied(chunks, 1) })).toBe('a\nb\nc\nd\ne\nF\ng\n')

  // 兩邊改得一樣：不算衝突。
  expect(merge3(['a', 'b'], ['a', 'X'], ['a', 'X'])[1]).toEqual({
    kind: 'auto',
    from: 'both',
    base: ['b'],
    ours: ['X'],
    theirs: ['X'],
    isApplied: true,
  })

  // 改到同一行，或緊貼著（一邊改 c、一邊改 d）：衝突，跟 git 一樣。
  expect(merge3(['a', 'b'], ['a', 'X'], ['a', 'Y'])[1]).toEqual({ kind: 'conflict', ours: ['X'], base: ['b'], theirs: ['Y'], choice: 'none' })
  expect(merge3(['a', 'c', 'd', 'z'], ['a', 'C', 'd', 'z'], ['a', 'c', 'D', 'z'])).toEqual([
    { kind: 'same', lines: ['a'] },
    { kind: 'conflict', ours: ['C', 'd'], base: ['c', 'd'], theirs: ['c', 'D'], choice: 'none' },
    { kind: 'same', lines: ['z'] },
  ])

  // 沒有共同祖先（兩邊都新增了這個檔案）：一樣的部分保留，不一樣的每一段都是衝突。
  expect(merge3(null, ['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([
    { kind: 'same', lines: ['a'] },
    { kind: 'conflict', ours: ['b'], base: null, theirs: ['x'], choice: 'none' },
    { kind: 'same', lines: ['c'] },
  ])
})

test('detectOp and conflictLabel', () => {
  expect(detectOp(['HEAD', 'MERGE_HEAD', 'index'])).toBe('merge')
  expect(detectOp(['rebase-merge', 'ORIG_HEAD'])).toBe('rebase')
  expect(detectOp(['CHERRY_PICK_HEAD'])).toBe('cherry-pick')
  expect(detectOp(['REVERT_HEAD'])).toBe('revert')
  expect(detectOp(['HEAD'])).toBe('')
  expect(conflictLabel({ path: 'a', x: 'U', y: 'U' })).toBe('both modified')
  expect(conflictLabel({ path: 'a', x: 'D', y: 'U' })).toBe('deleted by us')
  expect(conflictLabel({ path: 'a', x: 'U', y: 'D' })).toBe('deleted by them')
})

test('nextConflict walks the conflicts still open, stopping at the ends, then all of them once each is chosen', () => {
  const same: MergeChunk = { kind: 'same', lines: ['a'] }
  const open: MergeChunk = { kind: 'conflict', ours: ['x1'], base: null, theirs: ['x2'], choice: 'none' }
  const chunks = [same, open, same, open, same, open, same]
  expect(nextConflict(chunks, -1, 1)).toBe(1)
  expect(nextConflict(chunks, 1, 1)).toBe(3)
  expect(nextConflict(chunks, 5, 1)).toBeNull()
  expect(nextConflict(chunks, -1, -1)).toBe(5)
  expect(nextConflict(chunks, 3, -1)).toBe(1)
  expect(nextConflict(chunks, 1, -1)).toBeNull()
  // 第 3 段選好了：跳過它。
  const picked = choose(chunks, 3, 'ours')
  expect(nextConflict(picked, 1, 1)).toBe(5)
  expect(nextConflict(picked, 5, -1)).toBe(1)
  // 全部選好：在全部衝突之間跳。
  expect(nextConflict(chooseAll(chunks, 'theirs'), 1, 1)).toBe(3)
  expect(nextConflict([same], -1, 1)).toBeNull()
})
