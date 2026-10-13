import { expect, test } from 'claude-code/testing'

import { gitRepo, mountPane, openPanel, stubPanel } from '../test-fixtures'

test('every letter and digit the view does not bind is held by a hidden button that does nothing, so it never reaches the prompt box', async ($, on) => {
  stubPanel(on)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  gitRepo(on, { status: '## main\0 M src/a.ts\0 M src/b.ts\0' })
  await openPanel($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    const stray = async () =>
      (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(k => k.startsWith('stray:')).map(k => k.slice('stray:'.length))
    // 分頁上沒有快捷鍵：a–z、0–9 全部接住，藏在不佔位置的框裡。
    await ui.press({ key: 'sub:log' })
    expect(await stray()).toHaveLength(36)
    expect((await ui.find({ key: 'stray' }))?.props.display).toBe('none')
    // 按了不做事，畫面不變。
    await ui.press({ key: 'stray:m' })
    expect(await ui.find({ key: 'sub:log' })).toBeDefined()

    // 差異：b、n、m 是 Back／Previous／Next 的，不接；其他照樣接住。
    await ui.press({ key: 'sub:diff' })
    await ui.press({ key: 'file:unstaged:src/a.ts' })
    const left = await stray()
    for (const k of ['b', 'n', 'm']) expect(left).not.toContain(k)
    expect(left).toContain('x')
    expect(left).toHaveLength(33)
    await ui.press({ key: 'diff:back' })
    await ui.unmount()
  }
})
