import { expect, test } from 'claude-code/testing'

import { childPath, formatSize, sortEntries } from './list'

const entry = (name: string, kind: 'file' | 'dir' | 'other', size = 0) => ({ name, kind, size, mtimeMs: 0, isLink: kind === 'other' })

test('sortEntries puts folders first, then the rest, by name ignoring case and numbering', () => {
  const sorted = sortEntries([entry('b.ts', 'file', 5), entry('src', 'dir'), entry('A.md', 'file'), entry('file10', 'file'), entry('file2', 'file'), entry('.git', 'dir'), entry('link', 'other')])
  expect(sorted.map(e => e.name)).toEqual(['.git', 'src', 'A.md', 'b.ts', 'file2', 'file10', 'link'])
  expect(sorted.find(e => e.name === 'b.ts')).toEqual({ name: 'b.ts', kind: 'file', size: 5 })
})

test('childPath adds a name to a relative folder', () => {
  expect(childPath('', 'src')).toBe('src')
  expect(childPath('src', 'ui')).toBe('src/ui')
})

test('formatSize writes bytes with one decimal below 10', () => {
  expect(formatSize(0)).toBe('0 B')
  expect(formatSize(812)).toBe('812 B')
  expect(formatSize(4300)).toBe('4.2 KB')
  expect(formatSize(13 * 1024 * 1024)).toBe('13 MB')
})
