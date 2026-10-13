import { expect, test } from 'claude-code/testing'

import { childPath, fileSteps, formatSize, sortEntries, viewText } from './list'

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

test('fileSteps lists the files of the folder as paths, folders left out', () => {
  const files = { dir: 'src', isLoaded: true, total: 3, error: '', entries: [{ name: 'ui', kind: 'dir', size: 0 }, { name: 'a.ts', kind: 'file', size: 1 }, { name: 'b.ts', kind: 'file', size: 1 }] } as const
  expect(fileSteps({ ...files, entries: [...files.entries] })).toEqual(['src/a.ts', 'src/b.ts'])
})

test('viewText turns CRLF into LF, drops control characters, refuses binary and cuts long text at a line end', () => {
  expect(viewText('a\r\nb\x1b[0m\tc\n')).toEqual({ text: 'a\nb[0m\tc\n', isTruncated: false })
  expect(viewText('PNG\0\0data')).toBeNull()
  expect(viewText('bad \uFFFD byte')).toBeNull()
  const long = viewText(`${'x'.repeat(40_000)}\n${'y'.repeat(40_000)}\n`)
  expect(long).toEqual({ text: 'x'.repeat(40_000), isTruncated: true })
})
