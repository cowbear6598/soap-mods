// DB 分頁（SQL Server）的動作：存連線（密碼放 Keychain／DPAPI）、打開、列資料表和欄位、跑 SELECT。
// 不碰 $ 和 atom，用 register.tsx 給的 DbIo（見 io.ts）。

import type { DbTable, DbView } from '../../types'
import { DB_KEYCHAIN_SERVICE, DB_PROCESS_TIMEOUT_MS, DB_STORE_KEY } from '../config'
import { NO_DB_CONNECTION } from '../defaults'
import { errorText, failure, isMissingCommand } from '../errors'
import type { Io } from '../io'
import { latestOnly } from '../latest'
import { OLD_KEYCHAIN, deleteSecret, readSecret, saveSecret } from '../secret'
import { type ArmSlot, busyFlag, isConfirmed } from '../shell'
import type { DbBusy } from '../ui/actions'
import {
  type SavedConnection,
  TABLES_QUERY,
  columnsQuery,
  connectionId,
  connectionName,
  parseColumns,
  parseConnectionString,
  parseTable,
  parseTables,
  previewQuery,
  savedConnections,
  selectOnlyError,
  sqlcmdCommandError,
  sqlcmdArgv,
  tableKey,
  withoutSecret,
} from './sql'

export type DbIo = Io & {
  getDb: () => Promise<DbView>
  setDb: (change: Partial<DbView>) => Promise<void>
}

// 正在存連線、跑查詢。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後一直停在「Running…」。
const dbBusy = busyFlag<DbBusy>('')

export const dbBusyNow = dbBusy.get

const SQLCMD_MISSING = 'DB needs sqlcmd. Install it: brew install sqlcmd on macOS, winget install sqlcmd on Windows.'
const NO_PASSWORD = 'This connection has no password. Delete it and add it again with Password=… in the connection string.'

async function readSaved(io: DbIo) {
  return savedConnections(await io.storeGet(DB_STORE_KEY))
}

// 存進 $.store，畫面上的清單直接用存進去的那份，不用再讀一次。
async function writeSaved(io: DbIo, saved: SavedConnection[], change: Partial<DbView> = {}) {
  await io.storeSet(DB_STORE_KEY, saved)
  await io.setDb({ ...change, isLoaded: true, connections: saved.map(withoutSecret) })
}

export async function loadDbConnections(io: DbIo) {
  try {
    await io.setDb({ isLoaded: true, connections: (await readSaved(io)).map(withoutSecret) })
  } catch (err) {
    await io.setDb({ isLoaded: true, error: `Couldn't read the saved connections: ${errorText(err)}` })
  }
}

// 連線的密碼存在 Keychain／DPAPI（見 secret.ts），$.store 裡的 secret 記著在哪（見 db/sql.ts 的 SavedConnection）。
const secretRef = (id: string) => ({ service: DB_KEYCHAIN_SERVICE, account: id })

// 一個 session 每條連線只問一次 Keychain。
async function readPassword(io: DbIo, c: SavedConnection) {
  if (c.secret === '') return ''
  const r = secretRef(c.id)
  const password = await readSecret(io, r, c.secret).catch((err: unknown) => {
    throw new Error(`Couldn't read the saved password (delete the connection and add it again): ${errorText(err)}`)
  })
  // 舊版存的沒加 -T ""：刪掉重存（-U 蓋過去不會換掉誰能讀），$.store 裡那筆的 secret 跟著換。
  if (c.secret === OLD_KEYCHAIN) {
    await deleteSecret(io, r, c.secret)
    const secret = await saveSecret(io, r, password)
    await io.storeSet(DB_STORE_KEY, (await readSaved(io)).map(x => (x.id === c.id ? { ...x, secret } : x)))
  }

  return password
}

// 打開著的連線，和它的密碼。換連線、回清單、刪掉就丟掉（密碼本身 secret.ts 記著，再打開不用再問）。
let opened: { c: SavedConnection; password: Promise<string> } | undefined

// 在打開著的連線上跑一段 SQL，回傳它印的表格。密碼只放在 sqlcmd 的環境變數 SQLCMDPASSWORD，不在命令列上。
// sqlcmd 跑不起來（沒裝）才說要裝它；連不上之類的錯誤（訊息裡也會有 not found）照 sqlcmd 說的給。
async function runSql(io: DbIo, query: string) {
  if (opened === undefined) throw new Error('No connection is open.')
  const { c } = opened
  const password = await opened.password
  // 加入時就擋沒密碼的 SQL 登入；這是擋之前存的那些：sqlcmd 會跳出互動的密碼提示，沒有終端機就印「liner: function not supported in this terminal」。
  if (!c.isIntegrated && password === '') throw new Error(NO_PASSWORD)
  const command = sqlcmdCommandError(query)
  if (command !== '') throw new Error(command)
  // 不用 runOk：只有跑不起來（rejected）才算沒裝，sqlcmd 自己回的錯誤不能拿去比對 not found。
  const r = await io.run(sqlcmdArgv(c, query), { env: c.isIntegrated ? {} : { SQLCMDPASSWORD: password }, timeoutMs: DB_PROCESS_TIMEOUT_MS }).catch((err: unknown) => {
    throw isMissingCommand(err) ? new Error(SQLCMD_MISSING) : err
  })
  if (r.exitCode !== 0) throw failure(r, 'sqlcmd')

  return parseTable(r.stdout, r.isStdoutTruncated)
}

// 貼上連線字串：拆開、密碼存進 Keychain／DPAPI，其餘存進 $.store。錯誤訊息裡不放連線字串（有密碼）。
export async function addDbConnection(io: DbIo, text: string) {
  if (dbBusy.get() !== '' || text.trim() === '') return
  const p = parseConnectionString(text)
  if ('error' in p) return io.setDb({ error: p.error })
  const { password, ...parts } = p.parsed
  dbBusy.set(io, 'adding')
  try {
    const id = connectionId(await io.now(), Math.random())
    const saved: SavedConnection = { id, ...parts, secret: password === '' ? '' : await saveSecret(io, secretRef(id), password) }
    await writeSaved(io, [...(await readSaved(io)), saved], { error: '' })
    io.toast(`Saved ${connectionName(saved)}`)
  } catch (err) {
    await io.setDb({ error: `Couldn't save the connection: ${errorText(err)}` })
  } finally {
    dbBusy.set(io, '')
  }
}

const dbArm: ArmSlot = {}

// 刪連線要按兩次，跟 Spec 一樣；刪的時候密碼一起刪。
export async function deleteDbConnection(io: DbIo, id: string) {
  const arm = () => io.setDb({ deleteArmed: id, error: '' })
  if (!(await isConfirmed(io, dbArm, (await io.getDb()).deleteArmed === id, arm, () => io.setDb({ deleteArmed: '' })))) return
  try {
    const saved = await readSaved(io)
    const gone = saved.find(c => c.id === id)
    await io.leaveRow()
    await writeSaved(io, saved.filter(c => c.id !== id), { deleteArmed: '' })
    if (gone === undefined) return
    if (opened?.c.id === id) opened = undefined
    await deleteSecret(io, secretRef(gone.id), gone.secret)
  } catch (err) {
    await io.setDb({ deleteArmed: '', error: `Couldn't delete the connection: ${errorText(err)}` })
  }
}

// 打開、展開的讀取和查詢：連點、讀到一半按了 Back，晚到的舊結果不寫。
const tableLoads = latestOnly()
const columnLoads = latestOnly()
const queryRuns = latestOnly()

function dropConnection(io: DbIo) {
  tableLoads.drop()
  columnLoads.drop()
  queryRuns.drop()
  opened = undefined
  dbBusy.set(io, '')
}

export async function openDbConnection(io: DbIo, id: string) {
  dropConnection(io)
  const isStale = tableLoads.start()
  const [saved] = await Promise.all([readSaved(io), io.setDb({ ...NO_DB_CONNECTION, open: id, deleteArmed: '' }), io.scrollTop()])
  const c = saved.find(x => x.id === id)
  if (c === undefined) return io.setDb({ ...NO_DB_CONNECTION, error: 'That connection was deleted.' })
  opened = { c, password: readPassword(io, c) }
  // 沒人等的時候讀不到也不要變成未處理的錯誤；要用時 runSql 會再丟出來。
  opened.password.catch(() => undefined)
  try {
    const tables = parseTables(await runSql(io, TABLES_QUERY))
    if (!isStale()) await io.setDb({ tables })
  } catch (err) {
    if (!isStale()) await io.setDb({ tables: [], error: errorText(err) })
  }
}

export async function closeDbConnection(io: DbIo) {
  dropConnection(io)
  await io.setDb(NO_DB_CONNECTION)
}

// 跑一段 SQL（按 Enter 時框裡的字，或點資料表的預覽）：只放行一段 SELECT（selectOnlyError），其他的不跑、說為什麼。
export async function runDbQuery(io: DbIo, query: string) {
  const refused = selectOnlyError(query)
  if (refused !== '') return io.setDb({ query, queryError: refused })
  const isStale = queryRuns.start()
  dbBusy.set(io, 'query')
  await io.setDb({ query, queryError: '' })
  try {
    const result = await runSql(io, query)
    if (!isStale()) await io.setDb({ result })
  } catch (err) {
    if (!isStale()) await io.setDb({ result: null, queryError: errorText(err) })
  } finally {
    if (!isStale()) dbBusy.set(io, '')
  }
}

async function loadColumns(io: DbIo, t: DbTable) {
  const isStale = columnLoads.start()
  try {
    const columns = parseColumns(await runSql(io, columnsQuery(t)))
    if (!isStale()) await io.setDb({ columns })
  } catch (err) {
    if (!isStale()) await io.setDb({ error: errorText(err) })
  }
}

export async function toggleDbTable(io: DbIo, t: DbTable) {
  const key = tableKey(t)
  if ((await io.getDb()).table === key) {
    columnLoads.drop()

    return io.setDb({ table: '', columns: [] })
  }
  await io.setDb({ table: key, columns: [] })
  await Promise.all([loadColumns(io, t), runDbQuery(io, previewQuery(t))])
}
