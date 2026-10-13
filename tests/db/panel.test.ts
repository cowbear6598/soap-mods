import type { ProcessRunInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { DB_STORE_KEY } from '../../hooks/config'
import { toHex } from '../../hooks/db/secret'
import { type TestOn, fail, mountPane, ok, stubPanel } from '../test-fixtures'

const PASSWORD = 'S3crét;"pw密'
const CONN_STRING = `Server=db.local;Database=shop;User Id=reader;Password="${PASSWORD.replace(/"/g, '""')}";TrustServerCertificate=True`

const TABLES_OUT = 'TABLE_SCHEMA\tTABLE_NAME\tTABLE_TYPE\n------------\t----------\t----------\ndbo\torders\tBASE TABLE\ndbo\tv_sales\tVIEW\n'
const COLUMNS_OUT = 'COLUMN_NAME\tDATA_TYPE\tIS_NULLABLE\n--\t--\t--\nid\tint\tNO\ncustomer\tnvarchar\tYES\n'
const ROWS_OUT = 'id\tcustomer\n--\t--------\n1\tAda | Co\n2\tNULL\n'

const DPAPI_BLOB = '01000000d08c9ddf0115d1118c7a00c04fc297eb'

type Run = { argv: readonly string[]; init?: ProcessRunInit }

// DB 分頁要的引擎回應：$.store 放在記憶體、Keychain（macOS）或 DPAPI（Windows），sqlcmd 照查詢回固定的表格。
// sqlcmd 給 false 是沒裝（跑不起來）。記下每個跑過的程序。
function dbWorld(on: TestOn, { isWindows = false, hasSqlcmd = true }: { isWindows?: boolean; hasSqlcmd?: boolean } = {}) {
  const store: Record<string, unknown> = {}
  const keychain: Record<string, string> = {}
  const runs: Run[] = []
  const toasts: string[] = []
  stubPanel(on, { root: '/proj', now: null })
  mock.clock(on)
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('ui.toast', (_$, e) => {
    toasts.push(String(e.text))

    return { value: undefined }
  })
  on('store.get', (_$, e) => ({ value: store[e.key] }))
  on('store.set', (_$, e) => {
    store[e.key] = e.value

    return { value: undefined }
  })
  on('env.get', (_$, e) => ({ value: isWindows && e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    runs.push(e)
    const [cmd, sub] = e.argv
    const account = e.argv[e.argv.indexOf('-a') + 1] ?? ''
    if (cmd === 'security' && sub === '-i') {
      const [, id = '', hex = ''] = /-a (\S+) -w (\S+)/.exec(e.init?.stdin ?? '') ?? []
      keychain[id] = hex

      return ok('')
    }
    if (cmd === 'security' && sub === 'find-generic-password') {
      const hex = keychain[account]
      if (hex === undefined) return fail('The specified item could not be found in the keychain.', 44)

      return ok(e.argv.includes('-w') ? `${hex}\n` : 'keychain: "login.keychain-db"\n')
    }
    if (cmd === 'security' && sub === 'delete-generic-password') {
      delete keychain[account]

      return ok('')
    }
    if (cmd === 'powershell' && e.init?.env?.SOAP_SECRET !== undefined) return ok(`${DPAPI_BLOB}\r\n`)
    if (cmd === 'powershell' && e.init?.env?.SOAP_BLOB === DPAPI_BLOB) return ok(toHex(PASSWORD))
    if (cmd === 'sqlcmd') {
      // 引擎跑不起來的程序：$.process.run 被拒，訊息有 ENOENT。
      if (!hasSqlcmd) return { deny: 'spawn sqlcmd ENOENT' }
      const query = e.argv.at(-1) ?? ''
      if (query.includes('INFORMATION_SCHEMA.TABLES')) return ok(TABLES_OUT)
      if (query.includes('INFORMATION_SCHEMA.COLUMNS')) return ok(COLUMNS_OUT)

      return ok(ROWS_OUT)
    }

    return ok('')
  })

  const saved = () => (store[DB_STORE_KEY] ?? []) as { id: string; secret: string }[]
  const sqlcmds = () => runs.filter(r => r.argv[0] === 'sqlcmd')

  return { store, keychain, runs, toasts, saved, sqlcmds }
}

// 打開 DB 分頁、貼上連線字串存好，回傳存好的那筆的 id。
async function addConnection(ui: Awaited<ReturnType<typeof mountPane>>, world: ReturnType<typeof dbWorld>) {
  await ui.press({ key: 'tab:db' })
  await ui.input({ key: 'db:add', text: CONN_STRING })

  return world.saved()[0]?.id ?? ''
}

const markdown = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
  (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text)).join('\n')

test('on macOS a pasted connection string is saved with its password in the Keychain, never in the store or on a command line', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:db' })
  expect(await ui.find({ type: 'Text', text: 'No connections yet.' })).toBeDefined()

  const id = await addConnection(ui, world)
  expect(await ui.find({ type: 'Text', text: 'shop @ db.local' })).toBeDefined()
  expect(world.saved()[0]?.secret).toBe('keychain')
  // 密碼（和它的十六進位）不在 $.store 裡，也不在任何程序的命令列上；只從 security -i 的 stdin 進 Keychain。
  const hex = toHex(PASSWORD)
  expect(JSON.stringify(world.store)).not.toContain(PASSWORD)
  expect(JSON.stringify(world.store)).not.toContain(hex)
  expect(world.runs.some(r => r.argv.some(a => a.includes(PASSWORD) || a.includes(hex)))).toBe(false)
  expect(world.keychain[id]).toBe(hex)
  expect(world.toasts).toContain('Saved shop @ db.local')
  await ui.unmount()
})

test('a bad connection string is refused with the reason, and nothing is saved', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:db' })
  await ui.input({ key: 'db:add', text: 'Database=shop;User Id=x;Password=topsecret' })
  expect(await ui.find({ type: 'Text', text: 'The connection string has no Server (or Data Source).' })).toBeDefined()
  expect(world.saved()).toEqual([])
  expect(world.runs.some(r => r.argv[0] === 'security')).toBe(false)
  await ui.unmount()
})

test('opening a connection lists its tables; a SELECT runs with the password in SQLCMDPASSWORD and draws a table', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)

  await ui.press({ key: `db:item:${id}` })
  expect(await ui.find({ key: 'db:back' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tables (2)' })).toBeDefined()
  expect(await ui.find({ key: 'db:table:dbo.orders' })).toBeDefined()
  expect(await ui.find({ key: 'db:table:dbo.v_sales' })).toBeDefined()

  await ui.input({ key: 'db:query', text: 'SELECT id, customer FROM dbo.orders' })
  const run = world.sqlcmds().at(-1)
  expect(run?.argv.at(-1)).toBe('SET NOCOUNT ON;\nSELECT id, customer FROM dbo.orders')
  expect(run?.init?.env?.SQLCMDPASSWORD).toBe(PASSWORD)
  expect(run?.argv).toContain('-C')
  expect(await ui.find({ type: 'Text', text: '2 rows' })).toBeDefined()
  // | 在格子裡要跳脫，才不會切出多一欄。
  const table = await markdown(ui)
  expect(table).toContain('| id | customer |')
  expect(table).toContain('| 1 | Ada \\| Co |')
  expect(table).toContain('| 2 | NULL |')

  // Back 回清單。
  await ui.press({ key: 'db:back' })
  expect(await ui.find({ type: 'Text', text: 'shop @ db.local' })).toBeDefined()
  expect(await ui.find({ key: 'db:query' })).toBeUndefined()
  await ui.unmount()
})

test('anything but one SELECT is refused before sqlcmd runs', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)
  await ui.press({ key: `db:item:${id}` })
  const before = world.sqlcmds().length

  await ui.input({ key: 'db:query', text: 'DELETE FROM dbo.orders' })
  expect(await ui.find({ type: 'Text', text: 'Only SELECT runs here.' })).toBeDefined()
  await ui.input({ key: 'db:query', text: 'SELECT 1; DROP TABLE dbo.orders' })
  expect(await ui.find({ type: 'Text', text: 'Only one statement at a time.' })).toBeDefined()
  await ui.input({ key: 'db:query', text: 'SELECT * INTO copy FROM dbo.orders' })
  expect(await ui.find({ type: 'Text', text: 'INTO is not allowed: only SELECT runs here.' })).toBeDefined()
  expect(world.sqlcmds()).toHaveLength(before)
  await ui.unmount()
})

test('pressing a table shows its columns and previews its rows; pressing it again folds it', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)
  await ui.press({ key: `db:item:${id}` })

  await ui.press({ key: 'db:table:dbo.orders' })
  expect(await ui.find({ type: 'Text', text: 'customer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'nvarchar?' })).toBeDefined()
  expect((await ui.find({ key: 'db:query' }))?.props.value).toBe('SELECT TOP 100 * FROM [dbo].[orders]')
  expect(world.sqlcmds().some(r => r.argv.at(-1)?.endsWith('SELECT TOP 100 * FROM [dbo].[orders]'))).toBe(true)
  expect(await markdown(ui)).toContain('| id | customer |')

  await ui.press({ key: 'db:table:dbo.orders' })
  expect(await ui.find({ type: 'Text', text: 'nvarchar?' })).toBeUndefined()
  // 打開連線後密碼只讀一次：之後讀資料表、欄位、預覽都用同一份，不再開 security。
  expect(world.runs.filter(r => r.argv[0] === 'security' && r.argv.includes('-w') && r.argv[1] === 'find-generic-password')).toHaveLength(1)
  await ui.unmount()
})

test('deleting a connection takes two presses and removes its Keychain password too', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)

  await ui.press({ key: `db:delete:${id}` })
  expect(world.saved()).toHaveLength(1)
  expect(await ui.find({ key: `db:delete:${id}` })).toBeDefined()
  await ui.press({ key: `db:delete:${id}` })
  expect(world.saved()).toEqual([])
  expect(world.keychain[id]).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'No connections yet.' })).toBeDefined()
  await ui.unmount()
})

test('with Integrated Security sqlcmd runs with -E: no user, no password, nothing in the Keychain', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  await ui.press({ key: 'tab:db' })
  await ui.input({ key: 'db:add', text: 'Server=db.local;Database=shop;Integrated Security=SSPI' })
  const id = world.saved()[0]?.id ?? ''
  expect(await ui.find({ type: 'Text', text: 'Windows login' })).toBeDefined()

  await ui.press({ key: `db:item:${id}` })
  const run = world.sqlcmds().at(-1)
  expect(run?.argv).toContain('-E')
  expect(run?.argv).not.toContain('-U')
  expect(run?.init?.env?.SQLCMDPASSWORD).toBeUndefined()
  expect(world.runs.some(r => r.argv[0] === 'security')).toBe(false)
  await ui.unmount()
})

test('without sqlcmd the tab says to install it instead of breaking', async ($, on) => {
  const world = dbWorld(on, { hasSqlcmd: false })
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)
  await ui.press({ key: `db:item:${id}` })
  expect(await ui.find({ type: 'Text', text: /^DB needs sqlcmd\. Install it/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'No tables.' })).toBeDefined()
  await ui.unmount()
})

test('on Windows the password is kept as DPAPI ciphertext in the store and decrypted only to run sqlcmd', async ($, on) => {
  const world = dbWorld(on, { isWindows: true })
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)
  expect(world.saved()[0]?.secret).toBe(DPAPI_BLOB)
  expect(JSON.stringify(world.store)).not.toContain(PASSWORD)
  expect(world.runs.some(r => r.argv[0] === 'security')).toBe(false)
  // 要加密的密碼從環境變數進 PowerShell，命令列上沒有。
  const protect = world.runs.find(r => r.init?.env?.SOAP_SECRET !== undefined)
  expect(protect?.init?.env?.SOAP_SECRET).toBe(toHex(PASSWORD))
  expect(protect?.argv.some(a => a.includes(PASSWORD))).toBe(false)

  await ui.press({ key: `db:item:${id}` })
  expect(world.sqlcmds().at(-1)?.init?.env?.SQLCMDPASSWORD).toBe(PASSWORD)
  expect(await ui.find({ key: 'db:table:dbo.orders' })).toBeDefined()
  await ui.unmount()
})

test('the DB tab draws on the terminal too', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'terminal')
  const id = await addConnection(ui, world)
  await ui.press({ key: `db:item:${id}` })
  await ui.input({ key: 'db:query', text: 'SELECT 1' })
  expect(await markdown(ui)).toContain('| 1 | Ada \\| Co |')
  await ui.unmount()
})
