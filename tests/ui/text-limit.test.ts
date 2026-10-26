import { expect, test } from 'claude-code/testing'

import { gitRepo, mountPane, ok, openPanel, stubPanel } from '../test-fixtures'

// 引擎一次最多畫 100000 字：文字、按鈕的 label、Markdown 和 Code 的內容都算。
function drawnChars(node: unknown): number {
  if (typeof node === 'string') return node.length
  if (Array.isArray(node)) return node.reduce((n: number, c) => n + drawnChars(c), 0)
  if (node === null || typeof node !== 'object') return 0
  const { type, props = {}, children } = node as { type?: string; props?: Record<string, unknown>; children?: unknown }
  const own = [props.label, props.text, props.source].filter(v => typeof v === 'string' && type !== 'Svg').join('').length

  return own + drawnChars(children ?? props.children)
}

const SUBJECT = 'x'.repeat(2000)
const LOG = Array.from({ length: 31 }, (_, i) => `${String(i).padStart(40, 'a')}\t${String(i).padStart(7, 'a')}\t\tCptSoap\t0\t${SUBJECT}\n`).join('')
const LONG_LINES = `@@ -0,0 +1,900 @@\n${Array.from({ length: 900 }, () => `+${'y'.repeat(2500)}`).join('\n')}\n`

test('a log of long commit subjects and a diff of long lines stay under the 100000 characters the engine draws', async ($, on) => {
  stubPanel(on)
  gitRepo(on, { status: '## main\0 M a.ts\0', run: cmd => (cmd[0] === 'log' ? ok(LOG) : cmd[0] === 'diff' ? ok(LONG_LINES) : undefined) })
  await openPanel($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountPane($, surface)
    await ui.press({ key: 'sub:diff' })
    await ui.press({ key: 'file:unstaged:a.ts' })
    expect(drawnChars(await ui.drawn())).toBeLessThan(100_000)
    expect((await ui.find({ key: 'diff:1' }))?.text.endsWith('…')).toBe(true)
    await ui.press({ key: 'diffpage:next' })
    expect(drawnChars(await ui.drawn())).toBeLessThan(100_000)
    await ui.press({ key: 'diffpage:prev' })

    await ui.press({ key: 'diff:back' })
    await ui.press({ key: 'sub:log' })
    expect(drawnChars(await ui.drawn())).toBeLessThan(100_000)
    await ui.unmount()
  }
})
