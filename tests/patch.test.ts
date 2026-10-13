import { expect, test } from 'claude-code/testing'

import { patch } from '../hooks/patch'

test('patch keeps the same object when nothing changes, so nothing redraws', () => {
  const v = { a: 1, list: [{ x: 1 }], armed: null as { name: string } | null }
  expect(patch(v, { a: 1, list: [{ x: 1 }], armed: null })).toBe(v)
  expect(patch(v, {})).toBe(v)
  const next = patch(v, { armed: { name: 'dev' } })
  expect(next).not.toBe(v)
  expect(next).toEqual({ a: 1, list: [{ x: 1 }], armed: { name: 'dev' } })
})
