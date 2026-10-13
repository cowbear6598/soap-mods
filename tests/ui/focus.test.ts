import { expect, mock, test } from 'claude-code/testing'

import { gitRepo, mountPane, waitFor } from '../test-fixtures'

test('a letter no button binds, pressed while Soap Panel holds the keyboard, is kept out of the prompt box and the keyboard goes back', async ($, on) => {
  const clock = mock.clock(on)
  const pane = (isFocused: boolean) => [{ id: 'soap-panel', title: 'Soap Panel', isShown: true, isFocused, isPlaced: true }]
  let panes = pane(true)
  const opened: string[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_$, e) => {
    if (e.focus === true) opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.focus', () => ({}))
  on('ui.scroll', () => ({}))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  // 輸入框本身：照引擎的做法把打的字放進去。
  on('prompt.edit', (_$, e) => ({ text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end), cursor: e.start + e.inputText.length }))
  gitRepo(on, { status: '## main\0' })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  const typed = (key: string, extra: { ctrl?: true; meta?: true } = {}, text = '') =>
    $.prompt.edit({ origin: { kind: 'composer' }, key: { key, ...extra }, text, cursor: text.length, start: text.length, end: text.length, inputText: key })

  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'sub:log' })
  await clock.advance(1000)
  opened.length = 0

  // log 分頁沒有 m：輸入框不收，鍵盤還給 Soap Panel（還焦點是在背景做的，等它做完）。
  expect(await typed('m')).toEqual({ text: '', cursor: 0 })
  expect(await waitFor(async () => (opened.length > 0 ? opened : undefined))).toEqual(['soap-panel'])

  // 按著 ctrl、cmd 的、貼上的（沒有 key）不是快捷鍵，照常進輸入框。
  await clock.advance(1000)
  expect((await typed('k', { ctrl: true })).text).toBe('k')
  await clock.advance(1000)
  expect((await typed('k', { meta: true })).text).toBe('k')
  await clock.advance(1000)
  expect((await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'pasted' })).text).toBe('pasted')

  // 人自己點去輸入框打字：Soap Panel 早就沒拿著鍵盤了，一個字都不吞。
  panes = pane(false)
  await clock.advance(1000)
  opened.length = 0
  expect((await typed('h')).text).toBe('h')
  expect((await typed('i', {}, 'h')).text).toBe('hi')
  expect(opened).toEqual([])

  // 正在打字（剛收到別的字）時，就算 Soap Panel 看起來還拿著鍵盤也不吞。
  panes = pane(true)
  await clock.advance(200)
  expect((await typed('o', {}, 'hi')).text).toBe('hio')
  await ui.unmount()
})
