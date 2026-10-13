import { expect, test } from 'claude-code/testing'

import {
  columnsQuery,
  parseConnectionString,
  previewQuery,
  selectOnlyError,
} from '../../hooks/db/sql'

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

test('table queries bracket and quote names so a name cannot break out', () => {
  const t = { schema: 'dbo', name: "o]rd'ers" }
  expect(previewQuery(t)).toBe("SELECT TOP 100 * FROM [dbo].[o]]rd'ers]")
  expect(columnsQuery(t)).toContain("TABLE_NAME = N'o]rd''ers'")
})
