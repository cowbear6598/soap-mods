import { expect, test } from 'claude-code/testing'

import { ringAnchor } from '../../hooks/ui/keys'

test('ringAnchor takes the swapped-in button, then an open Back, then the tab icon', () => {
  expect(ringAnchor(new Set(['diff:back', 'sub:diff']), 'git', 'diff')).toBe('diff:back')
  expect(ringAnchor(new Set(['files:dir:src', 'files:back', 'tab:files']), 'files', 'diff')).toBe('files:back')
  expect(ringAnchor(new Set(['tab:services', 'sub:diff']), 'services', 'diff')).toBe('tab:services')
  // 按的按鈕換成指定的那顆：先移到它，不移到遠處的 Back。
  expect(ringAnchor(new Set(['merge:back', 'merge:reset:1']), 'git', 'conflict', 'merge:reset:1')).toBe('merge:reset:1')
})
