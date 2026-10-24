import type { ProcessRunInit } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { DB_STORE_KEY } from '../../hooks/config'
import { KEYCHAIN, OLD_KEYCHAIN, toHex } from '../../hooks/secret'
import { type Pane, type TestOn, fakeKeychain, mountPane, ok, openTool, stubPanel, stubStore } from '../test-fixtures'

const PASSWORD = 'S3crét;"pw密'
const CONN_STRING = `Server=db.local;Database=shop;User Id=reader;Password="${PASSWORD.replace(/"/g, '""')}";TrustServerCertificate=True`

const TABLES_OUT = 'TABLE_SCHEMA\tTABLE_NAME\tTABLE_TYPE\n------------\t----------\t----------\ndbo\torders\tBASE TABLE\ndbo\tv_sales\tVIEW\n'
const COLUMNS_OUT = 'COLUMN_NAME\tDATA_TYPE\tIS_NULLABLE\n--\t--\t--\nid\tint\tNO\ncustomer\tnvarchar\tYES\n'
const ROWS_OUT = 'id\tcustomer\n--\t--------\n1\tAda | Co\n2\tNULL\n'

const DPAPI_BLOB = '01000000d08c9ddf0115d1118c7a00c04fc297eb'

const OLD_CONNECTION = { id: 'cold1', server: 'db.local', database: 'shop', user: 'reader', isIntegrated: false, trustCert: true, secret: OLD_KEYCHAIN }

type Run = { argv: readonly string[]; init?: ProcessRunInit }

// DB 分頁要的引擎回應：$.store 放在記憶體、Keychain（macOS）或 DPAPI（Windows），sqlcmd 照查詢回固定的表格。
// sqlcmd 給 false 是沒裝（跑不起來）。記下每個跑過的程序。
function dbWorld(
  on: TestOn,
  {
    isWindows = false,
    hasSqlcmd = true,
    tablesOut = TABLES_OUT,
    hasOldConnection = false,
  }: { isWindows?: boolean; hasSqlcmd?: boolean; tablesOut?: string; hasOldConnection?: boolean } = {},
) {
  // hasOldConnection：舊版存的一條連線，Keychain 項目沒加 -T ""。
  const store: Record<string, unknown> = hasOldConnection ? { [DB_STORE_KEY]: [OLD_CONNECTION] } : {}
  const keychain = fakeKeychain(hasOldConnection ? { [OLD_CONNECTION.id]: toHex(PASSWORD) } : {})
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
  stubStore(on, store)
  on('env.get', (_$, e) => ({ value: isWindows && e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('process.run', (_$, e) => {
    runs.push(e)
    const secret = keychain.run(e)
    if (secret !== undefined) return secret
    const [cmd] = e.argv
    if (cmd === 'powershell' && e.init?.env?.SOAP_SECRET !== undefined) return ok(`${DPAPI_BLOB}\r\n`)
    if (cmd === 'powershell' && e.init?.env?.SOAP_BLOB === DPAPI_BLOB) return ok(toHex(PASSWORD))
    if (cmd === 'sqlcmd') {
      // 引擎跑不起來的程序：$.process.run 被拒，訊息有 ENOENT。
      if (!hasSqlcmd) return { deny: 'spawn sqlcmd ENOENT' }
      const query = e.argv.at(-1) ?? ''
      if (query.includes('INFORMATION_SCHEMA.TABLES')) return ok(tablesOut)
      if (query.includes('INFORMATION_SCHEMA.COLUMNS')) return ok(COLUMNS_OUT)

      return ok(ROWS_OUT)
    }

    return ok('')
  })

  const saved = () => (store[DB_STORE_KEY] ?? []) as { id: string; secret: string }[]
  const sqlcmds = () => runs.filter(r => r.argv[0] === 'sqlcmd')

  return { store, keychain: keychain.items, keychainReads: () => keychain.counts.reads, runs, toasts, saved, sqlcmds }
}

// 打開 DB 分頁、貼上連線字串存好，回傳存好的那筆的 id。
async function addConnection(ui: Pane, world: ReturnType<typeof dbWorld>, text = CONN_STRING) {
  await openTool(ui, 'db')
  await ui.input({ key: 'db:add', text })

  return world.saved()[0]?.id ?? ''
}

const markdown = async (ui: Pane) =>
  (await ui.findAll({ type: 'Markdown' })).map(m => String(m.props.text)).join('\n')

test('on macOS a pasted connection string is saved with its password in the Keychain, never in the store or on a command line', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'db')
  expect(await ui.find({ type: 'Text', text: 'No connections yet.' })).toBeDefined()

  const id = await addConnection(ui, world)
  expect(await ui.find({ type: 'Text', text: 'shop @ db.local' })).toBeDefined()
  expect(world.saved()[0]?.secret).toBe(KEYCHAIN)
  // 密碼（和它的十六進位）不在 $.store 裡，也不在任何程序的命令列上；只從 security -i 的 stdin 進 Keychain。
  const hex = toHex(PASSWORD)
  expect(JSON.stringify(world.store)).not.toContain(PASSWORD)
  expect(JSON.stringify(world.store)).not.toContain(hex)
  expect(world.runs.some(r => r.argv.some(a => a.includes(PASSWORD) || a.includes(hex)))).toBe(false)
  expect(world.keychain[id]).toBe(hex)
  // 加了 -T ""：誰來讀（連 Claude 的 Bash）macOS 都要人輸入密碼。
  expect(world.runs.find(r => r.argv[0] === 'security' && r.argv[1] === '-i')?.init?.stdin).toContain(' -T "" ')
  expect(world.toasts).toContain('Saved shop @ db.local')
  await ui.unmount()
})

test('a connection saved before its Keychain item asked for a password is saved again so it does, and the Keychain is asked once a session', async ($, on) => {
  const world = dbWorld(on, { hasOldConnection: true })
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'db')
  await ui.press({ key: `db:item:${OLD_CONNECTION.id}` })
  expect(await ui.find({ type: 'Text', text: 'Tables (2)' })).toBeDefined()
  expect(world.sqlcmds().at(-1)?.init?.env?.SQLCMDPASSWORD).toBe(PASSWORD)

  // 舊的項目刪掉、加 -T "" 重存，$.store 裡記成新的。
  expect(world.runs.some(r => r.argv[0] === 'security' && r.argv[1] === 'delete-generic-password')).toBe(true)
  expect(world.runs.find(r => r.argv[0] === 'security' && r.argv[1] === '-i')?.init?.stdin).toContain(' -T "" ')
  expect(world.keychain[OLD_CONNECTION.id]).toBe(toHex(PASSWORD))
  expect(world.saved()[0]?.secret).toBe(KEYCHAIN)

  // 回清單再打開：不再問 Keychain。
  await ui.press({ key: 'db:back' })
  await ui.press({ key: `db:item:${OLD_CONNECTION.id}` })
  expect(await ui.find({ type: 'Text', text: 'Tables (2)' })).toBeDefined()
  expect(world.keychainReads()).toBe(1)
  await ui.unmount()
})

test('ADO.NET and ODBC spellings, quoted and braced passwords all reach sqlcmd as written', async ($, on) => {
  const cases = [
    {
      text: 'Server=tcp:db.local,1433;Initial Catalog=shop;User ID=reader;Password="p;w""d";TrustServerCertificate=True;',
      name: 'shop @ tcp:db.local,1433',
      args: ['-S', 'tcp:db.local,1433', '-d', 'shop', '-U', 'reader', '-C'],
      password: 'p;w"d',
    },
    { text: 'Data Source=db\\SQL;Database=shop;UID=sa;PWD={a}}b}', name: 'shop @ db\\SQL', args: ['-S', 'db\\SQL', '-d', 'shop', '-U', 'sa'], password: 'a}b' },
  ]
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'db')
  for (const [i, c] of cases.entries()) {
    await ui.input({ key: 'db:add', text: c.text })
    expect(await ui.find({ type: 'Text', text: c.name })).toBeDefined()
    await ui.press({ key: `db:item:${world.saved()[i]?.id}` })
    const run = world.sqlcmds().at(-1)
    expect(run?.argv.join(' ')).toContain(c.args.join(' '))
    if (!c.args.includes('-C')) expect(run?.argv).not.toContain('-C')
    expect(run?.init?.env?.SQLCMDPASSWORD).toBe(c.password)
    // -X 會讓 sqlcmd 不讀 SQLCMDPASSWORD，改跳密碼提示。
    expect(run?.argv).not.toContain('-X')
    await ui.press({ key: 'db:back' })
  }
  await ui.unmount()
})

test('a bad connection string is refused with the reason, and nothing is saved', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  await openTool(ui, 'db')
  for (const [text, reason] of [
    ['Database=shop;User Id=x;Password=topsecret', 'The connection string has no Server (or Data Source).'],
    ['Server=db;Password=topsecret', 'The connection string has no User Id, and no Integrated Security.'],
    // 沒密碼的 SQL 登入存下來，sqlcmd 會跳出互動的密碼提示（沒有終端機就印 liner: function not supported in this terminal）。
    ['Server=db;User Id=app', 'The connection string has no Password, and no Integrated Security.'],
  ] as const) {
    await ui.input({ key: 'db:add', text })
    expect(await ui.find({ type: 'Text', text: reason })).toBeDefined()
  }
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

  const SQLCMD_BLOCKED = 'sqlcmd commands and $( ) are not allowed: only SELECT runs here.'
  for (const [query, error] of [
    ['   ', 'Type a SELECT to run.'],
    ['DELETE FROM dbo.orders', 'Only SELECT runs here.'],
    ['EXEC sp_who', 'Only SELECT runs here.'],
    ['SELECT 1; DROP TABLE dbo.orders', 'Only one statement at a time.'],
    ['SELECT * INTO copy FROM dbo.orders', 'INTO is not allowed: only SELECT runs here.'],
    ['WITH x AS (SELECT 1 AS n) DELETE FROM dbo.orders', 'DELETE is not allowed: only SELECT runs here.'],
    ["SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'y')", 'OPENROWSET is not allowed: only SELECT runs here.'],
    [':setvar x 1\nSELECT 1', SQLCMD_BLOCKED],
    ['SELECT 1\n!!dir', SQLCMD_BLOCKED],
    ["SELECT '$(x)' AS v", SQLCMD_BLOCKED],
  ] as const) {
    const before = world.sqlcmds().length
    await ui.input({ key: 'db:query', text: query })
    expect(await ui.find({ type: 'Text', text: error })).toBeDefined()
    expect(world.sqlcmds()).toHaveLength(before)
  }
  await ui.unmount()
})

test('a SELECT runs even with write keywords inside strings, [names] or comments', async ($, on) => {
  const world = dbWorld(on)
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)
  await ui.press({ key: `db:item:${id}` })

  for (const query of [
    'select top 5 id from dbo.orders;',
    'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
    "SELECT 'DELETE FROM a; DROP TABLE b' AS note, [update] FROM t -- insert here\n",
    'SELECT /* exec */ 1',
  ]) {
    await ui.input({ key: 'db:query', text: query })
    expect(world.sqlcmds().at(-1)?.argv.at(-1)).toBe(`SET NOCOUNT ON;\n${query}`)
  }
  await ui.unmount()
})

test("a table name with ] and ' is bracketed and quoted in the preview and columns queries", async ($, on) => {
  const world = dbWorld(on, { tablesOut: "TABLE_SCHEMA\tTABLE_NAME\tTABLE_TYPE\n--\t--\t--\ndbo\to]rd'ers\tBASE TABLE\n" })
  const ui = await mountPane($, 'desktop')
  const id = await addConnection(ui, world)
  await ui.press({ key: `db:item:${id}` })

  await ui.press({ key: "db:table:dbo.o]rd'ers" })
  expect((await ui.find({ key: 'db:query' }))?.props.value).toBe("SELECT TOP 100 * FROM [dbo].[o]]rd'ers]")
  const queries = world.sqlcmds().map(r => r.argv.at(-1) ?? '')
  expect(queries.some(q => q.endsWith("SELECT TOP 100 * FROM [dbo].[o]]rd'ers]"))).toBe(true)
  expect(queries.some(q => q.includes("TABLE_NAME = N'o]rd''ers'"))).toBe(true)
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
  const id = await addConnection(ui, world, 'Server=db.local;Database=shop;Integrated Security=SSPI')
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
