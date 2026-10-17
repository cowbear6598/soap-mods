import { expect, test } from 'claude-code/testing'

import { checkedKey, checkedList, draftPages, isDraftPath, parseDraft } from '../../hooks/wiki/parse'

test('parseDraft reads the three first lines a draft can have and refuses the rest', () => {
  expect(parseDraft('target: db/schema.md\n\n# Schema\n- One table\n')).toEqual({ kind: 'write', target: 'db/schema.md', body: '# Schema\n- One table' })
  expect(parseDraft('move: style.md -> conventions/style.md\n')).toEqual({ kind: 'move', from: 'style.md', target: 'conventions/style.md' })
  expect(parseDraft('delete:  naming.md')).toEqual({ kind: 'delete', target: 'naming.md' })

  // 不是頁面路徑、搬到自己、少了箭頭的另一邊、看不懂的第一行：都不算草稿。
  expect(parseDraft('target: ../escape.md\n\nx')).toBeNull()
  expect(parseDraft('move: a.md -> a.md')).toBeNull()
  expect(parseDraft('move: a.md ->')).toBeNull()
  expect(parseDraft('move: a.md -> b.md -> c.md')).toBeNull()
  expect(parseDraft('delete: .drafts/x.md')).toBeNull()
  expect(parseDraft('rename: a.md -> b.md')).toBeNull()
})

test('isDraftPath matches files right under .soap/wiki/.drafts on either separator', () => {
  expect(isDraftPath('/proj/.soap/wiki/.drafts/1-goals.md')).toBe(true)
  expect(isDraftPath('C:\\proj\\.soap\\wiki\\.drafts\\1-goals.md')).toBe(true)
  expect(isDraftPath('/proj/.soap/wiki/goals.md')).toBe(false)
  expect(isDraftPath('/proj/.soap/wiki/.drafts/old/1.md')).toBe(false)
})

test('checked pages are one store key per session folder; a junk value is none checked', () => {
  expect(checkedKey('/a')).toBe('wiki.checked:/a')
  expect(checkedList(['ok.md', 3, '../no.md', 'db/x.md'])).toEqual(['ok.md', 'db/x.md'])
  expect(checkedList(undefined)).toEqual([])
  expect(checkedList({ '/a': ['x.md'] })).toEqual([])
})

test('draftPages names the page a draft takes away and the one it writes', () => {
  expect(draftPages({ kind: 'write', target: 'a.md', body: '' })).toEqual({ to: 'a.md' })
  expect(draftPages({ kind: 'move', from: 'a.md', target: 'b/a.md' })).toEqual({ from: 'a.md', to: 'b/a.md' })
  expect(draftPages({ kind: 'delete', target: 'a.md' })).toEqual({ from: 'a.md' })
})
