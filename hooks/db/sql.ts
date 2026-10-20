// DB 分頁：解析 SQL Server 的連線字串、只放行 SELECT、組 sqlcmd 的參數、解析它印出的表格。
// 這裡只放純邏輯；跑 sqlcmd、存密碼在 register.tsx，密碼怎麼存在 db/secret.ts。

import type { DbColumn, DbConnection, DbResult, DbTable } from '../../types'
import { DB_LOGIN_TIMEOUT_S, DB_PREVIEW_ROWS, DB_QUERY_TIMEOUT_S, DB_ROW_LIMIT } from '../config'

/** A connection string's parts: the connection without its id, and the password. */
type ParsedConnection = Omit<DbConnection, 'id'> & { password: string }

// 連線字串的 key（小寫、空白收成一格）→ 欄位。ADO.NET 和 ODBC 常見的寫法都認。
const FIELDS: Record<string, 'server' | 'database' | 'user' | 'password' | 'integrated' | 'trust'> = {
  server: 'server',
  'data source': 'server',
  address: 'server',
  addr: 'server',
  'network address': 'server',
  database: 'database',
  'initial catalog': 'database',
  'user id': 'user',
  userid: 'user',
  uid: 'user',
  user: 'user',
  password: 'password',
  pwd: 'password',
  'integrated security': 'integrated',
  trusted_connection: 'integrated',
  trustservercertificate: 'trust',
  'trust server certificate': 'trust',
}

const isTrue = (v: string) => /^(true|yes|sspi)$/i.test(v.trim())

// 把 `key=value;key="va;lue"` 切成一對對。值可以用 "…"、'…'（兩個引號是一個引號）或 {…}（}} 是一個 }）包起來。
function splitPairs(text: string): [string, string][] {
  const pairs: [string, string][] = []
  let i = 0
  while (i < text.length) {
    const eq = text.indexOf('=', i)
    if (eq === -1) break
    const key = text.slice(i, eq).trim().toLowerCase().replace(/\s+/g, ' ')
    i = eq + 1
    while (text[i] === ' ') i++
    const open = text[i]
    const close = open === '"' || open === "'" ? open : open === '{' ? '}' : undefined
    let value = ''
    if (close === undefined) {
      const end = text.indexOf(';', i)
      value = text.slice(i, end === -1 ? text.length : end).trim()
      i = end === -1 ? text.length : end + 1
    } else {
      i++
      while (i < text.length) {
        if (text[i] === close && text[i + 1] === close) {
          value += close
          i += 2
        } else if (text[i] === close) {
          i++
          break
        } else {
          value += text[i++]
        }
      }
      const end = text.indexOf(';', i)
      i = end === -1 ? text.length : end + 1
    }
    if (key !== '') pairs.push([key, value])
  }

  return pairs
}

/** A SQL Server connection string → its parts, or why it cannot be used. */
export function parseConnectionString(text: string): { parsed: ParsedConnection } | { error: string } {
  const parsed: ParsedConnection = { server: '', database: '', user: '', password: '', isIntegrated: false, trustCert: false }
  for (const [key, value] of splitPairs(text.trim())) {
    const field = FIELDS[key]
    if (field === 'integrated') parsed.isIntegrated = isTrue(value)
    else if (field === 'trust') parsed.trustCert = isTrue(value)
    else if (field !== undefined) parsed[field] = value
  }
  if (parsed.server === '') return { error: 'The connection string has no Server (or Data Source).' }
  if (!parsed.isIntegrated && parsed.user === '') return { error: 'The connection string has no User Id, and no Integrated Security.' }
  if (parsed.isIntegrated) return { parsed: { ...parsed, user: '', password: '' } }

  return { parsed }
}

/** The name a connection is listed by: `database @ server`, or the server alone. */
export const connectionName = (c: Pick<DbConnection, 'server' | 'database'>) => (c.database === '' ? c.server : `${c.database} @ ${c.server}`)

// 把字串、註解、[名稱]、"名稱" 都換成一格空白，剩下的才看關鍵字：字串裡、欄位名稱裡的 DELETE 不算。
function stripSql(sql: string) {
  let out = ''
  let i = 0
  const skipQuoted = (close: string) => {
    i++
    while (i < sql.length) {
      if (sql[i] === close && sql[i + 1] === close) i += 2
      else if (sql[i++] === close) return
    }
  }
  while (i < sql.length) {
    const c = sql[i]
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i)
      i = end === -1 ? sql.length : end
      out += ' '
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? sql.length : end + 2
      out += ' '
    } else if (c === "'" || c === '"') {
      skipQuoted(c)
      out += ' '
    } else if (c === '[') {
      skipQuoted(']')
      out += ' '
    } else {
      out += c
      i++
    }
  }

  return out
}

// 會改資料、改結構、跑程序、讀外部資料、換資料庫、開交易的關鍵字。SELECT … INTO 會建表，所以 INTO 也擋。
const BLOCKED =
  /\b(INTO|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|EXEC|EXECUTE|GRANT|REVOKE|DENY|BACKUP|RESTORE|DBCC|SHUTDOWN|KILL|OPENROWSET|OPENQUERY|OPENDATASOURCE|OPENXML|BULK|USE|SET|DECLARE|BEGIN|COMMIT|ROLLBACK|SAVE|WAITFOR|RECONFIGURE|RECEIVE|SEND|GO)\b/i

/** Why `sql` may not run, '' when it is one SELECT (or a WITH … SELECT). */
export function selectOnlyError(sql: string): string {
  const bare = stripSql(sql).trim().replace(/[;\s]+$/, '')
  if (bare === '') return 'Type a SELECT to run.'
  // sqlcmd 送出前會先處理 :setvar、!! 這類指令和 $(var)，連字串裡的也算，所以看原文。
  if (/^\s*(:|!!)/m.test(sql) || sql.includes('$(')) return 'sqlcmd commands and $( ) are not allowed: only SELECT runs here.'
  if (bare.includes(';')) return 'Only one statement at a time.'
  if (!/^(SELECT|WITH)\b/i.test(bare)) return 'Only SELECT runs here.'
  const blocked = BLOCKED.exec(bare)?.[1]

  return blocked === undefined ? '' : `${blocked.toUpperCase()} is not allowed: only SELECT runs here.`
}

// sqlcmd 印表格用的欄位分隔字元（-s）。
const DB_SEPARATOR = '\t'

/**
 * sqlcmd's arguments to run `query` on `c`: errors to stderr and a nonzero
 * exit (-r 1, -b), tab separated with trailing spaces trimmed (-s, -W), no
 * scripting variables or commands (-x, -X).
 * No -f: go-sqlcmd (brew, winget) prints UTF-8 and refuses it. The password
 * goes in SQLCMDPASSWORD, never here.
 */
export function sqlcmdArgv(c: DbConnection, query: string): string[] {
  return [
    'sqlcmd',
    '-S',
    c.server,
    ...(c.database === '' ? [] : ['-d', c.database]),
    ...(c.isIntegrated ? ['-E'] : ['-U', c.user]),
    ...(c.trustCert ? ['-C'] : []),
    '-b',
    '-x',
    '-X',
    '-r',
    '1',
    '-W',
    '-w',
    '65535',
    '-s',
    DB_SEPARATOR,
    '-l',
    String(DB_LOGIN_TIMEOUT_S),
    '-t',
    String(DB_QUERY_TIMEOUT_S),
    '-Q',
    // NOCOUNT：不印「(N rows affected)」；分號讓後面的 WITH 也能跑。
    `SET NOCOUNT ON;\n${query}`,
  ]
}

/**
 * sqlcmd's printed table → columns and rows: the header line, a line of
 * dashes, then a row per line up to the trailing blank lines. Keeps the first DB_ROW_LIMIT
 * rows; a value holding a line break splits its row (sqlcmd prints it as is).
 */
export function parseTable(out: string, isTruncated = false): DbResult {
  const lines = out.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l.trim() !== '')
  if (start === -1) return { columns: [], rows: [], total: 0, isTruncated }
  const columns = lines[start]?.split(DB_SEPARATOR) ?? []
  const body = lines.slice(start + 2)
  // 單欄的空字串值也印成空行，所以只去掉結尾的空行；被截斷時最後一列可能不完整，也丟掉。
  let end = body.length
  while (end > 0 && body[end - 1] === '') end--
  const all = body.slice(0, isTruncated && end === body.length ? -1 : end)

  return { columns, rows: all.slice(0, DB_ROW_LIMIT).map(l => l.split(DB_SEPARATOR)), total: all.length, isTruncated }
}

/** `[name]` with `]` doubled. */
const bracket = (name: string) => `[${name.replace(/]/g, ']]')}]`

/** `N'text'` with `'` doubled. */
const literal = (text: string) => `N'${text.replace(/'/g, "''")}'`

export const TABLES_QUERY = 'SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME'

export const parseTables = (r: DbResult): DbTable[] =>
  r.rows.map(([schema = '', name = '', type = '']) => ({ schema, name, isView: type === 'VIEW' }))

export const columnsQuery = (t: Pick<DbTable, 'schema' | 'name'>) =>
  `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ${literal(t.schema)} AND TABLE_NAME = ${literal(t.name)} ORDER BY ORDINAL_POSITION`

export const parseColumns = (r: DbResult): DbColumn[] =>
  r.rows.map(([name = '', type = '', nullable = '']) => ({ name, type, isNullable: nullable === 'YES' }))

/** The query a table row fills in: its first DB_PREVIEW_ROWS rows. */
export const previewQuery = (t: Pick<DbTable, 'schema' | 'name'>) => `SELECT TOP ${DB_PREVIEW_ROWS} * FROM ${bracket(t.schema)}.${bracket(t.name)}`

/** The key a table is expanded by: `schema.name`. */
export const tableKey = (t: Pick<DbTable, 'schema' | 'name'>) => `${t.schema}.${t.name}`

/**
 * A connection as $.store keeps it: what the tab lists, plus where its
 * password is. `secret` is '' with no password, KEYCHAIN on macOS, else the
 * Windows DPAPI ciphertext.
 */
export type SavedConnection = DbConnection & { secret: string }

export const KEYCHAIN = 'keychain'

const isText = (v: unknown): v is string => typeof v === 'string'

/** What $.store holds under DB_STORE_KEY → the well formed connections; the rest dropped. */
export function savedConnections(raw: unknown): SavedConnection[] {
  if (!Array.isArray(raw)) return []

  return raw.filter((c: Record<string, unknown> | null): c is SavedConnection =>
    typeof c === 'object' &&
    c !== null &&
    [c.id, c.server, c.database, c.user, c.secret].every(isText) &&
    typeof c.isIntegrated === 'boolean' &&
    typeof c.trustCert === 'boolean',
  )
}

/** The connection without where its password is: what the panel draws. */
export const withoutSecret = ({ secret: _secret, ...c }: SavedConnection): DbConnection => c

/** A new connection's id: letters and digits only (it is a Keychain account name, read by security -i). */
export const connectionId = (now: number, random: number) => `c${now.toString(36)}${Math.floor(random * 36 ** 6).toString(36)}`
