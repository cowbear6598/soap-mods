import { expect, mock, test } from 'claude-code/testing'

import { type TestOn, endTurn, fsEntry, mountPane, ok, posix, stubPanel, stubStore } from '../test-fixtures'

const WIKI = '/proj/.soap/wiki'
const CHECKED = 'wiki.checked:/proj'

// 記在記憶體裡的 session 資料夾：路徑 → 內容。fs 的 list、read、write、exists 和 rm -rf 都照它答。
// now：給 null 時測試自己用 mock.clock（垃圾桶的待確認要計時）。reads：讀過的路徑記在這裡。store：$.store 的內容。
function disk(
  on: TestOn,
  files: Record<string, string>,
  {
    sessionId = () => 's1',
    now = 0,
    reads = [],
    store = {},
  }: { sessionId?: () => string; now?: number | null; reads?: string[]; store?: Record<string, unknown> } = {},
) {
  const under = (dir: string) => Object.keys(files).filter(p => p.startsWith(`${dir}/`))
  stubPanel(on, { root: '/proj', now })
  stubStore(on, store)
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: sessionId() }))
  on('prompt.context', (_$, e) => ({ blocks: e.blocks }))
  on('fs.exists', (_$, e) => {
    const path = posix(e.path) ?? ''

    return { value: path in files || under(path).length > 0 }
  })
  on('fs.list', (_$, e) => {
    const dir = posix(e.path) ?? ''
    const children = under(dir)
    if (children.length === 0) throw new Error('ENOENT')
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of children) {
      const [name = '', ...rest] = p.slice(dir.length + 1).split('/')
      names.set(name, rest.length > 0 ? 'dir' : 'file')
    }

    return { value: [...names].map(([name, kind]) => fsEntry(name, kind, files[`${dir}/${name}`]?.length ?? 0)) }
  })
  on('fs.read', (_$, e) => {
    reads.push(posix(e.path) ?? '')
    const text = files[posix(e.path) ?? '']
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_$, e) => {
    files[posix(e.path) ?? ''] = e.text

    return { value: undefined }
  })
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') {
      const path = posix(e.argv.at(-1)) ?? ''
      for (const p of [path, ...under(path)]) delete files[p]
    }

    return ok('')
  })
}

const drawnRows = async (ui: Awaited<ReturnType<typeof mountPane>>, prefix: string) =>
  (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(k => k.startsWith(prefix))

test('the Spec tab has a book icon and Spec / Wiki sub tabs; Spec is the plan list as before and Wiki lists the pages', async ($, on) => {
  const files: Record<string, string> = { [`${WIKI}/style.md`]: '# Style\n' }
  disk(on, files)

  const ui = await mountPane($, 'desktop')
  const icons = await ui.findAll({ type: 'Svg' })
  expect(icons.find(i => i.props.alt === 'Spec')?.props.source).toContain('M12 7v14')
  await ui.press({ key: 'tab:spec' })
  expect(await ui.find({ key: 'sub:spec' })).toBeDefined()
  expect(await ui.find({ key: 'sub:wiki' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No specs yet. Run /soap-mods:plan to write one.' })).toBeDefined()

  await ui.press({ key: 'sub:wiki' })
  expect(await drawnRows(ui, 'wiki:page:')).toEqual(['wiki:page:style.md'])
  await ui.press({ key: 'sub:spec' })
  expect(await ui.find({ key: 'wiki:page:style.md' })).toBeUndefined()
  await ui.unmount()
})

test('the Wiki tab lists the pages, keeps checks in the store per session folder, opens a page, and deletes one with two presses', async ($, on) => {
  mock.clock(on)
  const files: Record<string, string> = {}
  const store: Record<string, unknown> = {}
  const checked = () => (store[CHECKED] as string[] | undefined) ?? []
  disk(on, files, { now: null, store })
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const p of Object.keys(files)) delete files[p]
    Object.assign(files, {
      [`${WIKI}/style.md`]: '# Style\n\n- Tabs, not spaces\n',
      [`${WIKI}/db/schema.md`]: '# Schema\n',
      [`${WIKI}/notes.txt`]: 'not a page',
      [`${WIKI}/.drafts/0-1.md`]: 'not a page either',
    })
    const ui = await mountPane($, surface)
    await ui.press({ key: 'tab:spec' })
    await ui.press({ key: 'sub:wiki' })
    expect(await drawnRows(ui, 'wiki:page:')).toEqual(['wiki:page:db/schema.md', 'wiki:page:style.md'])

    // 勾選框：存進 store（這個 session 資料夾的），專案裡不寫檔案；再按取消。
    await ui.press({ key: 'wiki:check:style.md' })
    await ui.press({ key: 'wiki:check:db/schema.md' })
    expect(checked()).toEqual(['style.md', 'db/schema.md'])
    expect(Object.keys(files).filter(p => p.endsWith('checked.txt'))).toEqual([])
    if (surface === 'terminal') expect((await ui.find({ key: 'wiki:check:style.md' }))?.props.label).toBe('[x]')
    await ui.press({ key: 'wiki:check:db/schema.md' })
    expect(checked()).toEqual(['style.md'])

    // 點名稱看內容，b 回清單。
    await ui.press({ key: 'wiki:page:style.md' })
    expect(await ui.find({ type: 'Markdown', text: '# Style\n\n- Tabs, not spaces' })).toBeDefined()
    expect((await ui.find({ key: 'wiki:back' }))?.props).toMatchObject({ label: '← Back', hotkey: 'b' })
    await ui.press({ key: 'wiki:back' })

    // 垃圾桶按一次只是待確認，再按才刪，也從勾選拿掉。
    await ui.press({ key: 'wiki:delete:style.md' })
    expect(files[`${WIKI}/style.md`]).toBeDefined()
    await ui.press({ key: 'wiki:delete:style.md' })
    expect(files[`${WIKI}/style.md`]).toBeUndefined()
    expect(checked()).toEqual([])
    expect(await drawnRows(ui, 'wiki:page:')).toEqual(['wiki:page:db/schema.md'])
    await ui.unmount()
  }
})

test('with no .soap/wiki the Wiki tab shows only Summary Conversation: no hint, no error, no Send', async ($, on) => {
  disk(on, {})
  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  await ui.press({ key: 'sub:wiki' })
  expect(await ui.find({ key: 'wiki:distill' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No wiki pages|Couldn't list/ })).toBeUndefined()
  expect(await ui.find({ key: 'wiki:send' })).toBeUndefined()
  await ui.unmount()
})

test('Send adds the checked pages to the conversation at once, marks them sent, and after /clear the marks are gone', async ($, on) => {
  let session = 's1'
  const files: Record<string, string> = {
    [`${WIKI}/style.md`]: '# Style\n- Tabs\n',
    [`${WIKI}/db.md`]: '# DB\n- Read-only\n',
  }
  disk(on, files, { sessionId: () => session, store: { [CHECKED]: ['style.md', 'missing.md'], 'wiki.checked:/other': ['db.md'] } })
  const log = mock.session(on)
  const toasts: string[] = []
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const appended = () => log.appended().map(r => r.message.content.map(c => ('text' in c ? c.text : '')).join(''))

  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  await ui.press({ key: 'sub:wiki' })
  // 勾選不會自己送。
  await ui.press({ key: 'wiki:check:db.md' })
  expect(appended()).toEqual([])
  expect((await ui.find({ key: 'wiki:send' }))?.props).toMatchObject({ label: 'Send to Claude (2)', hotkey: 's' })

  // Send：勾了的、還在的頁面一次加進對話（使用者角色），兩頁都標 sent。
  await ui.press({ key: 'wiki:send' })
  expect(appended()).toHaveLength(1)
  expect(log.appended()[0]?.message.type).toBe('user')
  expect(appended()[0]).toContain('## style.md\n\n# Style\n- Tabs')
  expect(appended()[0]).toContain('## db.md\n\n# DB\n- Read-only')
  expect(appended()[0]).not.toContain('missing.md')
  expect(toasts.at(-1)).toBe('Sent 2 pages to Claude')
  expect(await ui.findAll({ type: 'Text', text: 'sent' })).toHaveLength(2)

  // /clear 之後是另一段對話：標記不見；什麼都沒勾時 Send 只提醒。
  session = 's2'
  await ui.press({ key: 'wiki:check:style.md' })
  await ui.press({ key: 'wiki:check:db.md' })
  expect(await ui.findAll({ type: 'Text', text: 'sent' })).toHaveLength(0)
  await ui.press({ key: 'wiki:send' })
  expect(appended()).toHaveLength(1)
  expect(toasts.at(-1)).toBe('Check the pages to send first.')
  await ui.unmount()
})

test('Distill drafts what is worth keeping into an inbox; Accept writes a draft into the wiki, Discard drops it', async ($, on) => {
  const files: Record<string, string> = { [`${WIKI}/style.md`]: '# Style\n- Tabs\n', [`${WIKI}/notes/big.md`]: 'x'.repeat(100_001) }
  const reads: string[] = []
  disk(on, files, { reads })
  const prompts: string[] = []
  let reply: unknown = {
    isAnswered: true,
    text: '=== new testing.md\n- Run `claude plugin test` before a commit\n\n=== edit .soap/wiki/style.md\n# Style\n- Tabs\n- No semicolons\n=== new ../escape.md\n- dropped\n',
    usage: {},
  }
  on('model.fork', (_$, e) => {
    prompts.push(e.prompt)

    return { value: reply as never }
  })

  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  await ui.press({ key: 'sub:wiki' })
  await ui.press({ key: 'wiki:distill' })
  // 提示裡有現有頁面；放不下的只給路徑、不讀。草稿進收件匣，頁面本身沒動，路徑跑出 wiki 的草稿不收。
  expect(prompts.at(-1)).toContain('--- style.md\n# Style\n- Tabs')
  expect(prompts.at(-1)).toContain('--- notes/big.md (not shown: too long)')
  expect(reads).not.toContain(`${WIKI}/notes/big.md`)
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual(['wiki:draft:0-1.md', 'wiki:draft:0-2.md'])
  expect(await ui.find({ type: 'Text', text: 'Drafts (2)' })).toBeDefined()
  expect(files[`${WIKI}/style.md`]).toBe('# Style\n- Tabs\n')
  expect(files[`${WIKI}/testing.md`]).toBeUndefined()
  expect(await ui.find({ key: 'wiki:page:0-1.md' })).toBeUndefined()

  // 改既有頁面的草稿：看差異，Accept 整頁取代，草稿不見。
  await ui.press({ key: 'wiki:draft:0-2.md' })
  expect((await ui.find({ type: 'Code' }))?.props.source).toBe('@@ -1,2 +1,3 @@\n # Style\n - Tabs\n+- No semicolons')
  await ui.press({ key: 'wiki:accept' })
  expect(files[`${WIKI}/style.md`]).toBe('# Style\n- Tabs\n- No semicolons\n')
  expect(files[`${WIKI}/.drafts/0-2.md`]).toBeUndefined()
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual(['wiki:draft:0-1.md'])

  // 新頁面的草稿：看 Markdown，Discard 只刪草稿。
  await ui.press({ key: 'wiki:draft:0-1.md' })
  expect(await ui.find({ type: 'Markdown', text: '- Run `claude plugin test` before a commit' })).toBeDefined()
  await ui.press({ key: 'wiki:discard' })
  expect(files[`${WIKI}/testing.md`]).toBeUndefined()
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual([])

  // 沒東西可整理、還不能整理：說原因，不寫草稿。
  reply = { isAnswered: true, text: 'NOTHING', usage: {} }
  await ui.press({ key: 'wiki:distill' })
  expect(await ui.find({ type: 'Text', text: 'Nothing new worth keeping in this conversation.' })).toBeDefined()
  reply = { isAnswered: false, reason: 'nothing-to-fork' }
  await ui.press({ key: 'wiki:distill' })
  expect(await ui.find({ type: 'Text', text: /^Nothing to distill yet/ })).toBeDefined()
  reply = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: {} }
  await ui.press({ key: 'wiki:distill' })
  expect(await ui.find({ type: 'Text', text: 'Distill failed: the API answered overloaded (529). Try again.' })).toBeDefined()
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual([])
  await ui.unmount()
})

test('Summary Conversation asks the model picked beside it: the conversation\'s own reads the conversation itself, another gets it as text', async ($, on) => {
  const store: Record<string, unknown> = {}
  disk(on, { [`${WIKI}/style.md`]: '# Style\n' }, { store })
  const forks: string[] = []
  const completes: { model: string; prompt: string }[] = []
  let messages: unknown[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)

    return { value: { isAnswered: true, text: 'NOTHING', usage: {} } as never }
  })
  on('model.complete', (_$, e) => {
    completes.push({ model: e.model, prompt: String(e.prompt) })

    return { value: { isAnswered: true, text: '=== new deploy.md\n- Deploy with make ship', usage: {} } as never }
  })
  on('session.messages', () => ({ value: messages as never }))

  on('session.model', () => ({ value: 'claude-opus-5-5[1m]' }))

  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  await ui.press({ key: 'sub:wiki' })
  // 三種模型，還沒選過停在對話用的那種。
  const picker = await ui.find({ key: 'wiki:model' })
  expect(picker?.props.value).toBe('opus')
  expect((picker?.props.options as { label: string }[] | undefined)?.map(o => o.label)).toEqual(['Opus', 'Sonnet', 'Haiku'])

  // 選 Sonnet：存進 store（之後的 session 還在），對話轉成文字另外問。
  await ui.select({ key: 'wiki:model', value: 'sonnet' })
  expect((await ui.find({ key: 'wiki:model' }))?.props.value).toBe('sonnet')
  expect(store['wiki.model']).toBe('sonnet')

  // 還沒有回覆過：不問，說沒東西可整理。
  await ui.press({ key: 'wiki:distill' })
  expect(completes).toEqual([])
  expect(await ui.find({ type: 'Text', text: /^Nothing to distill yet.*\(Sonnet\)$/ })).toBeDefined()

  messages = [
    { role: 'user', text: 'how do we deploy?', toolUses: [] },
    { role: 'assistant', text: 'With make ship.', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'make ship' }, text: 'shipped' }] },
  ]
  await ui.press({ key: 'wiki:distill' })
  expect(forks).toEqual([])
  expect(completes).toHaveLength(1)
  expect(completes[0]?.model).toBe('sonnet')
  expect(completes[0]?.prompt).toContain('<conversation>\n[user] how do we deploy?\n[assistant] With make ship.\n  (tool Bash) {"command":"make ship"} -> shipped\n</conversation>')
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual(['wiki:draft:0-1.md'])
  expect(await ui.find({ type: 'Text', text: 'Drafts (1)' })).toBeDefined()

  // 換回跟對話一樣的 Opus：從對話本身接著問。
  await ui.select({ key: 'wiki:model', value: 'opus' })
  await ui.press({ key: 'wiki:distill' })
  expect(forks).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: 'Nothing new worth keeping in this conversation. (Opus)' })).toBeDefined()
  expect(completes).toHaveLength(1)
  await ui.unmount()
})

test('the Wiki tab draws the pages as a tree of folders that open and close, and Uncheck all clears every check', async ($, on) => {
  const store: Record<string, unknown> = {}
  disk(on, { [`${WIKI}/style.md`]: '# Style\n', [`${WIKI}/db/schema.md`]: '# Schema\n', [`${WIKI}/db/ops/backup.md`]: '# Backup\n' }, { store })
  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  await ui.press({ key: 'sub:wiki' })

  // 資料夾在前、頁面在後，預設打開；列上寫名稱，不寫所在資料夾。
  expect(await drawnRows(ui, 'wiki:folder:')).toEqual(['wiki:folder:db/', 'wiki:folder:db/ops/'])
  expect(await drawnRows(ui, 'wiki:page:')).toEqual(['wiki:page:db/ops/backup.md', 'wiki:page:db/schema.md', 'wiki:page:style.md'])
  expect((await ui.find({ key: 'wiki:folder:db/' }))?.props.label).toBe('db/ · 2 ▾')
  expect((await ui.find({ key: 'wiki:page:db/schema.md' }))?.props.label).toBe('schema.md')

  // 點資料夾收起來，底下的（含更深的）都不畫；再點打開。
  await ui.press({ key: 'wiki:folder:db/' })
  expect((await ui.find({ key: 'wiki:folder:db/' }))?.props.label).toBe('db/ · 2 ▸')
  expect(await drawnRows(ui, 'wiki:page:')).toEqual(['wiki:page:style.md'])
  await ui.press({ key: 'wiki:folder:db/' })
  expect(await drawnRows(ui, 'wiki:page:')).toHaveLength(3)

  // Uncheck all：有勾才有，按了全部取消。
  expect(await ui.find({ key: 'wiki:uncheck' })).toBeUndefined()
  await ui.press({ key: 'wiki:check:style.md' })
  await ui.press({ key: 'wiki:check:db/ops/backup.md' })
  expect((await ui.find({ key: 'wiki:send' }))?.props.label).toBe('Send to Claude (2)')
  await ui.press({ key: 'wiki:uncheck' })
  expect((await ui.find({ key: 'wiki:send' }))?.props.label).toBe('Send to Claude (0)')
  expect(CHECKED in store).toBe(false)
  expect(await ui.find({ key: 'wiki:uncheck' })).toBeUndefined()
  await ui.unmount()
})

test('drafts can move and delete pages; Accept all applies them in order, checks follow the pages, and a clash stops it', async ($, on) => {
  const store: Record<string, unknown> = { [CHECKED]: ['style.md', 'naming.md'] }
  const files: Record<string, string> = {
    [`${WIKI}/style.md`]: '# Style\n',
    [`${WIKI}/naming.md`]: '# Naming\n',
    [`${WIKI}/.drafts/1-merge.md`]: 'target: conventions/code.md\n\n# Code\n- Tabs\n- camelCase\n',
    [`${WIKI}/.drafts/2-delete.md`]: 'delete: naming.md\n',
    [`${WIKI}/.drafts/3-move.md`]: 'move: style.md -> conventions/style.md\n',
    [`${WIKI}/.drafts/4-bad.md`]: 'rename: style.md\n',
  }
  disk(on, files, { store })
  const ui = await mountPane($)
  await ui.press({ key: 'tab:spec' })
  await ui.press({ key: 'sub:wiki' })

  // 第一行看不懂的不列；搬移寫「舊 → 新」，每份標它做什麼。
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual(['wiki:draft:1-merge.md', 'wiki:draft:2-delete.md', 'wiki:draft:3-move.md'])
  expect((await ui.find({ key: 'wiki:draft:3-move.md' }))?.props.label).toBe('style.md → conventions/style.md')
  for (const badge of ['new page', 'delete', 'move']) expect(await ui.find({ type: 'Text', text: badge })).toBeDefined()

  // 打開搬移、刪除的草稿：說會怎樣，底下是那頁現在的內容。
  await ui.press({ key: 'wiki:draft:3-move.md' })
  expect(await ui.find({ type: 'Text', text: /^Moves \.soap\/wiki\/style\.md to \.soap\/wiki\/conventions\/style\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: '# Style' })).toBeDefined()
  await ui.press({ key: 'wiki:back' })
  await ui.press({ key: 'wiki:draft:2-delete.md' })
  expect(await ui.find({ type: 'Text', text: 'Deletes .soap/wiki/naming.md:' })).toBeDefined()
  await ui.press({ key: 'wiki:back' })

  // Accept all：照順序全部套用，草稿檔刪掉；勾著的頁面跟著搬、被刪的拿掉。
  await ui.press({ key: 'wiki:accept-all' })
  expect(files[`${WIKI}/conventions/code.md`]).toBe('# Code\n- Tabs\n- camelCase\n')
  expect(files[`${WIKI}/naming.md`]).toBeUndefined()
  expect(files[`${WIKI}/style.md`]).toBeUndefined()
  expect(files[`${WIKI}/conventions/style.md`]).toBe('# Style\n')
  expect(Object.keys(files).filter(p => p.includes('/.drafts/'))).toEqual([`${WIKI}/.drafts/4-bad.md`])
  expect(store[CHECKED]).toEqual(['conventions/style.md'])
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual([])
  expect(await ui.find({ key: 'wiki:accept-all' })).toBeUndefined()

  // 搬到已經有頁面的路徑：不蓋掉，停下來說是哪一份，草稿留著；Discard 丟掉。
  files[`${WIKI}/.drafts/5-clash.md`] = 'move: conventions/code.md -> conventions/style.md\n'
  await endTurn($, ui)
  await ui.press({ key: 'wiki:accept-all' })
  expect(await ui.find({ type: 'Text', text: "Couldn't accept draft 5-clash.md: .soap/wiki/conventions/style.md already exists" })).toBeDefined()
  expect(files[`${WIKI}/conventions/code.md`]).toBeDefined()
  await ui.press({ key: 'wiki:draft:5-clash.md' })
  await ui.press({ key: 'wiki:discard' })
  expect(files[`${WIKI}/.drafts/5-clash.md`]).toBeUndefined()
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual([])

  // 要刪的頁面已經不在：說讀不到，Accept 照樣按得到，按了只把草稿收掉。
  files[`${WIKI}/.drafts/6-gone.md`] = 'delete: naming.md\n'
  await endTurn($, ui)
  await ui.press({ key: 'wiki:draft:6-gone.md' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't read \.soap\/wiki\/naming\.md/ })).toBeDefined()
  await ui.press({ key: 'wiki:accept' })
  expect(files[`${WIKI}/.drafts/6-gone.md`]).toBeUndefined()
  expect(await drawnRows(ui, 'wiki:draft:')).toEqual([])
  await ui.unmount()
})

test('writing a wiki draft with Write checks its first line: one the Wiki tab cannot read adds what to fix for Claude', async ($, on) => {
  const files: Record<string, string> = {}
  const toasts: string[] = []
  stubPanel(on, { root: '/proj' })
  on('process.run', () => ok(''))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('fs.read', (_$, e) => ({ value: files[posix(e.path) ?? ''] ?? '' }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Write') files[e.file_path] = e.content

    return { result: { ok: true } as never }
  })

  const bad = await $.tool.call({ tool: 'Write', file_path: `${WIKI}/.drafts/1-goals.md`, content: '# Goals\n' })
  expect(bad.context?.at(-1)).toMatch(/is not a valid soap-mods wiki draft[\s\S]*`move: <page>\.md -> <new page>\.md`/)
  expect(toasts).toHaveLength(1)
  const good = await $.tool.call({ tool: 'Write', file_path: `${WIKI}/.drafts/2-goals.md`, content: 'target: project/goals.md\n\n# Goals\n' })
  expect(good.context ?? []).toEqual([])
  // 頁面本身不檢查。
  const page = await $.tool.call({ tool: 'Write', file_path: `${WIKI}/goals.md`, content: '# Goals\n' })
  expect(page.context ?? []).toEqual([])
  expect(toasts).toHaveLength(1)
})
