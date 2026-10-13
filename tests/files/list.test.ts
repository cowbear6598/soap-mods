import { expect, test } from 'claude-code/testing'

import { fsEntry } from '../test-fixtures'
import { sortEntries } from '../../hooks/files/list'

test('sortEntries puts folders first, then the rest, by name ignoring case and numbering', () => {
  const sorted = sortEntries([fsEntry('b.ts', 'file', 5), fsEntry('src', 'dir'), fsEntry('A.md'), fsEntry('file10'), fsEntry('file2'), fsEntry('.git', 'dir'), fsEntry('link', 'other')])
  expect(sorted.map(e => e.name)).toEqual(['.git', 'src', 'A.md', 'b.ts', 'file2', 'file10', 'link'])
})
