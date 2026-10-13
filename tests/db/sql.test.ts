import { expect, test } from 'claude-code/testing'

import { DB_ROW_LIMIT } from '../../hooks/config'
import { fromHex, macSaveInput, toHex } from '../../hooks/db/secret'
import {
  columnsQuery,
  connectionId,
  parseConnectionString,
  parseTable,
  previewQuery,
  savedConnections,
  selectOnlyError,
  sqlcmdArgv,
} from '../../hooks/db/sql'

const CONN = { id: 'c1', server: 'db.local', database: 'shop', user: 'reader', isIntegrated: false, trustCert: false }

test('parseConnectionString reads ADO.NET and ODBC spellings, quoted values and integrated security', () => {
  expect(parseConnectionString('Server=tcp:db.local,1433;Initial Catalog=shop;User ID=reader;Password="p;w""d";TrustServerCertificate=True;')).toEqual({
    parsed: { server: 'tcp:db.local,1433', database: 'shop', user: 'reader', password: 'p;w"d', isIntegrated: false, trustCert: true },
  })
  expect(parseConnectionString('Data Source=db\\SQL;Database=shop;UID=sa;PWD={a}}b}')).toEqual({
    parsed: { server: 'db\\SQL', database: 'shop', user: 'sa', password: 'a}b', isIntegrated: false, trustCert: false },
  })
  // 整合驗證不用帳密，就算字串裡有也不留。
  expect(parseConnectionString('Server=db;Integrated Security=SSPI;User Id=x;Password=y')).toEqual({
    parsed: { server: 'db', database: '', user: '', password: '', isIntegrated: true, trustCert: false },
  })
  expect(parseConnectionString('Database=shop;User Id=x')).toEqual({ error: 'The connection string has no Server (or Data Source).' })
  expect(parseConnectionString('Server=db;Password=y')).toEqual({ error: 'The connection string has no User Id, and no Integrated Security.' })
})

test('selectOnlyError lets one SELECT through and refuses anything that writes, runs code or chains statements', () => {
  for (const ok of [
    'SELECT * FROM orders',
    'select top 5 id from dbo.orders;',
    "WITH x AS (SELECT 1 AS n) SELECT n FROM x",
    // 字串、[名稱]、註解裡的關鍵字不算。
    "SELECT 'DELETE FROM a; DROP TABLE b' AS note, [update] FROM t -- insert here\n",
    'SELECT /* exec */ 1',
  ]) {
    expect(selectOnlyError(ok)).toBe('')
  }
  expect(selectOnlyError('   ')).toBe('Type a SELECT to run.')
  expect(selectOnlyError('DELETE FROM orders')).toBe('Only SELECT runs here.')
  expect(selectOnlyError('SELECT * INTO copy FROM orders')).toBe('INTO is not allowed: only SELECT runs here.')
  expect(selectOnlyError('SELECT 1; DROP TABLE orders')).toBe('Only one statement at a time.')
  expect(selectOnlyError('WITH x AS (SELECT 1 AS n) DELETE FROM orders')).toBe('DELETE is not allowed: only SELECT runs here.')
  expect(selectOnlyError("SELECT * FROM OPENROWSET('SQLNCLI', 'x', 'y')")).toBe('OPENROWSET is not allowed: only SELECT runs here.')
  expect(selectOnlyError('EXEC sp_who')).toBe('Only SELECT runs here.')
})

test('sqlcmdArgv never carries the password, uses -E for integrated security and -C to trust the certificate', () => {
  const argv = sqlcmdArgv(CONN, 'SELECT 1')
  expect(argv.slice(0, 7)).toEqual(['sqlcmd', '-S', 'db.local', '-d', 'shop', '-U', 'reader'])
  expect(argv.at(-1)).toBe('SET NOCOUNT ON;\nSELECT 1')
  expect(argv).not.toContain('-P')
  expect(argv).not.toContain('-C')
  const trusted = sqlcmdArgv({ ...CONN, user: '', isIntegrated: true, trustCert: true }, 'SELECT 1')
  expect(trusted).toContain('-E')
  expect(trusted).toContain('-C')
  expect(trusted).not.toContain('-U')
})

test('parseTable reads the header, skips the dashes, stops at the blank line and keeps the first rows only', () => {
  expect(parseTable('id\tname\n--\t----\n1\tAda\n2\tNULL\n\n')).toEqual({
    columns: ['id', 'name'],
    rows: [
      ['1', 'Ada'],
      ['2', 'NULL'],
    ],
    total: 2,
    isTruncated: false,
  })
  expect(parseTable('id\r\n--\r\n')).toEqual({ columns: ['id'], rows: [], total: 0, isTruncated: false })
  expect(parseTable('')).toEqual({ columns: [], rows: [], total: 0, isTruncated: false })
  const many = ['n', '-', ...Array.from({ length: DB_ROW_LIMIT + 5 }, (_, i) => String(i))].join('\n')
  const r = parseTable(many)
  expect(r.rows).toHaveLength(DB_ROW_LIMIT)
  expect(r.total).toBe(DB_ROW_LIMIT + 5)
  // 輸出被截斷：最後一列可能只有一半，丟掉。
  expect(parseTable('n\n-\n1\n2\n12', true)).toEqual({ columns: ['n'], rows: [['1'], ['2']], total: 2, isTruncated: true })
})

test('table queries bracket and quote names so a name cannot break out', () => {
  const t = { schema: 'dbo', name: "o]rd'ers" }
  expect(previewQuery(t)).toBe("SELECT TOP 100 * FROM [dbo].[o]]rd'ers]")
  expect(columnsQuery(t)).toContain("TABLE_NAME = N'o]rd''ers'")
})

test('passwords go to the Keychain as UTF-8 hex: never as is, and back the same', () => {
  for (const pw of ['abc', 'p@ss "x"\\', '密碼 ✓', "a;b=c'"]) {
    expect(fromHex(toHex(pw))).toBe(pw)
    expect(toHex(pw)).toMatch(/^[0-9a-f]*$/)
  }
  expect(toHex('A密')).toBe('41e5af86')
  const line = macSaveInput('c1', 'secret pw')
  expect(line).toBe(`add-generic-password -U -s soap-mods-db -a c1 -w ${toHex('secret pw')}\n`)
  expect(line).not.toContain('secret')
  expect(() => fromHex('zz')).toThrow()
})

test('savedConnections keeps the well formed ones; connectionId is letters and digits', () => {
  const good = { ...CONN, secret: 'keychain' }
  expect(savedConnections([good, { id: 1 }, null, 'x'])).toEqual([good])
  expect(savedConnections(undefined)).toEqual([])
  expect(connectionId(1_700_000_000_000, 0.5)).toMatch(/^c[0-9a-z]+$/)
})
