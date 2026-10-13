import { expect, test } from 'claude-code/testing'

import { buttonKeys, ringAnchor } from '../../hooks/ui/keys'

test('buttonKeys finds every Button key in a drawn tree, nested or in arrays', async ($, on) => {
  // 跟 register.tsx 一樣，在畫的 hook 裡拿剛建好的樹來找。
  let found: string[] = []
  on('ui.render', ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const tree = (
      <Box flexDirection="column">
        <Text>title</Text>
        <Button key="a" label="A" onPress={() => undefined} />
        <Box>
          {[<Button key="b" label="B" onPress={() => undefined} />, null, <Text key="t">x</Text>]}
          <Box>
            <Button key="c" label="C" onPress={() => undefined} />
          </Box>
        </Box>
      </Box>
    )
    found = [...buttonKeys(tree)].sort()

    return tree
  })
  await $.ui.render({ component: 'Pane', requestId: 'keys', surface: 'terminal', props: {} as never })
  expect(found).toEqual(['a', 'b', 'c'])
})

test('ringAnchor takes the swapped-in button, then an open Back, then the tab icon', () => {
  expect(ringAnchor(new Set(['diff:back', 'sub:diff']), 'git', 'diff')).toBe('diff:back')
  expect(ringAnchor(new Set(['merge:prev', 'sub:log', 'tab:git']), 'git', 'log')).toBe('sub:log')
  expect(ringAnchor(new Set(['log:back', 'sub:log']), 'git', 'log')).toBe('log:back')
  expect(ringAnchor(new Set(['files:dir:src', 'files:back', 'tab:files']), 'files', 'diff')).toBe('files:back')
  expect(ringAnchor(new Set(['tab:services']), 'services', 'diff')).toBe('tab:services')
  expect(ringAnchor(new Set(['tab:services', 'sub:diff']), 'services', 'diff')).toBe('tab:services')
  // 按的按鈕換成指定的那顆：先移到它，不移到遠處的 Back。
  expect(ringAnchor(new Set(['merge:back', 'merge:reset:1']), 'git', 'conflict', 'merge:reset:1')).toBe('merge:reset:1')
  expect(ringAnchor(new Set(['x']), 'git', 'diff')).toBeUndefined()
})
