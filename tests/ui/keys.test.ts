import { expect, test } from 'claude-code/testing'

import { ringAnchor, unboundHotkeys } from '../../hooks/ui/keys'

test('ringAnchor takes the swapped-in button, then an open Back, then the tab icon', () => {
  expect(ringAnchor(new Set(['diff:back', 'sub:diff']), 'git', 'diff')).toBe('diff:back')
  expect(ringAnchor(new Set(['files:dir:src', 'files:back', 'tab:files']), 'files', 'diff')).toBe('files:back')
  expect(ringAnchor(new Set(['tab:services', 'sub:diff']), 'services', 'diff')).toBe('tab:services')
  // 按的按鈕換成指定的那顆：先移到它，不移到遠處的 Back。
  expect(ringAnchor(new Set(['merge:back', 'merge:reset:1']), 'git', 'conflict', 'merge:reset:1')).toBe('merge:reset:1')
})

test('unboundHotkeys lists the letters and digits no drawn Button binds', () => {
  const tree = [
    { type: 'Box', props: {}, children: [{ type: 'Button', props: { key: 'x:back', hotkey: 'b' } }] },
    { type: 'Button', props: { key: 'x:next', hotkey: 'm' } },
    { type: 'Button', props: { key: 'plain' } },
  ]
  const left = unboundHotkeys(tree)
  expect(left).toHaveLength(34)
  expect(left).not.toContain('b')
  expect(left).not.toContain('m')
  expect(left).toContain('a')
  expect(left).toContain('0')
})
