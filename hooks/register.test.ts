import { expect, test } from 'claude-code/testing'

test('the panel draws its title and every line on each surface', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'soap-mods',
      surface,
      component: 'Pane',
      requestId: 'soap-panel',
      props: {},
    })
    expect(await ui.find({ type: 'Text', text: /Soap Panel/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /回合數/ })).toBeDefined()
    await ui.unmount()
  }
})
