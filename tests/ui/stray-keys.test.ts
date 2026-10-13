import { expect, test } from 'claude-code/testing'

import { HOTKEYS } from '../../hooks/ui/keys'
import { gitRepo, mountPane, openPanel, stubPanel } from '../test-fixtures'

test('on desktop, every letter and digit the view does not bind is held by a hidden button that does nothing, so it never reaches the prompt box', async ($, on) => {
  stubPanel(on)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  gitRepo(on, { status: '## main\0 M src/a.ts\0 M src/b.ts\0' })
  await openPanel($)

  const ui = await mountPane($, 'desktop')
  const stray = async () =>
    (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(k => k.startsWith('stray:')).map(k => k.slice('stray:'.length))
  // 分頁上沒有快捷鍵：全部接住，藏在不佔位置的框裡。
  await ui.press({ key: 'sub:log' })
  expect(await stray()).toEqual(HOTKEYS)
  expect((await ui.find({ key: 'stray' }))?.props.display).toBe('none')
  // 按了不做事，畫面不變。
  await ui.press({ key: 'stray:m' })
  expect(await ui.find({ key: 'sub:log' })).toBeDefined()

  // 差異：b、n、m 是 Back／Previous／Next 的，不接；其他照樣接住。
  await ui.press({ key: 'sub:diff' })
  await ui.press({ key: 'file:unstaged:src/a.ts' })
  expect(await stray()).toEqual(HOTKEYS.filter(k => !['b', 'n', 'm'].includes(k)))
  await ui.unmount()
})

test('the terminal draws no hidden buttons: its prompt box does not take keys pressed in the pane', async ($, on) => {
  stubPanel(on)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  gitRepo(on, { status: '## main\0' })
  await openPanel($)

  const ui = await mountPane($, 'terminal')
  await ui.press({ key: 'sub:log' })
  expect(await ui.find({ key: 'stray' })).toBeUndefined()
  await ui.unmount()
})
