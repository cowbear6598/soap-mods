import { expect, test } from 'claude-code/testing'

import type { MergeChunk } from '../../types'
import { CONFLICTED } from '../test-fixtures'
import {
  buildResult,
  choose,
  chooseAll,
  isResolved,
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

test('nextConflict skips the conflicts already chosen, and walks all of them once every one is chosen', () => {
  const same: MergeChunk = { kind: 'same', lines: ['a'] }
  const open: MergeChunk = { kind: 'conflict', ours: ['x1'], base: null, theirs: ['x2'], choice: 'none' }
  const chunks = choose([same, open, same, open, same, open, same], 3, 'ours')
  expect(nextConflict(chunks, 1, 1)).toBe(5)
  expect(nextConflict(chunks, 5, -1)).toBe(1)
  expect(nextConflict(chunks, 5, 1)).toBeNull()
  expect(nextConflict(chooseAll(chunks, 'theirs'), 1, 1)).toBe(3)
})
