import { expect, test } from 'claude-code/testing'

import { neighbourKey } from '../../hooks/ui/keys'

test('after a row is deleted the focus ring goes to the same button on the next row, else the row before', () => {
  const before = ['sub:branch', 'delete:l:a:spacer', 'delete:l:a', 'delete:l:b:spacer', 'delete:l:b', 'delete:l:c', 'delete:r:origin/x']
  const without = (gone: string[]) => new Set(before.filter(k => !gone.includes(k)))

  expect(neighbourKey(before, 'delete:l:b', without(['delete:l:b', 'delete:l:b:spacer']))).toBe('delete:l:c')
  // 最後一列：往上找；同一種（本地）都沒了就不落在遠端的垃圾桶。
  expect(neighbourKey(before, 'delete:l:c', without(['delete:l:c']))).toBe('delete:l:b')
  expect(neighbourKey(before, 'delete:l:a', without(['delete:l:a', 'delete:l:b', 'delete:l:c']))).toBeUndefined()
})
