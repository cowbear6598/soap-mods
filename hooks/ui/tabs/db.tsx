import type { DbConnection, DbResult, DbTable } from '../../../types'
import { DB_CELL_WIDTH, DB_TABLE_LIMIT } from '../../config'
import { connectionName, tableKey } from '../../db/sql'
import { cutAtLineEnd, truncate } from '../../text'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// DB 分頁（SQL Server）：存著的連線一個一列，最右邊垃圾桶（按兩次才刪）；最下面貼連線字串新增。
// 點連線：最上面 ← Back（b），查詢框（只跑 SELECT），結果表格，最下面資料表清單；點資料表展開欄位、預覽前幾列。
// 手機版沒有輸入框，只能看。
export const dbTab: TabBody = ctx => (ctx.d.db.open === '' ? connectionList(ctx) : connectionView(ctx))

function connectionList({ w, d, a }: TabContext) {
  const { Box, Text } = w
  const db = d.db
  if (!db.isLoaded) return <Text dimColor>Loading…</Text>

  const row = (c: DbConnection) =>
    w.pressRow({
      key: `db:item:${c.id}`,
      label: connectionName(c),
      // 不縮排：跟下面的輸入框對齊。
      indent: 0,
      isTruncated: true,
      rest: <Text dimColor>{c.isIntegrated ? 'Windows login' : c.user}</Text>,
      onPress: () => a.openDbConnection(c.id),
      trailing: w.deleteButton(`db:delete:${c.id}`, d.armed === `db:delete:${c.id}`, () => a.deleteDbConnection(c.id)),
    })

  return (
    <Box flexDirection="column" gap={1}>
      {db.error !== '' && <Text color="error">{db.error}</Text>}
      {db.connections.length === 0 ? (
        <Text dimColor>No connections yet.</Text>
      ) : (
        <Box flexDirection="column">{db.connections.map(row)}</Box>
      )}
      {d.dbBusy === 'adding' ? (
        <Text dimColor>Saving…</Text>
      ) : (
        w.field('db:add', {
          placeholder: 'Paste a SQL Server connection string',
          value: '',
          submitLabel: 'Add',
          onSubmit: text => a.addDbConnection(text),
        })
      )}
    </Box>
  )
}

// 一格：換行、Tab 換成空白，太長截成「…」。跳脫 |（表格的欄線）和連結、圖片、強調、HTML 的符號：
// 資料庫裡的值要原樣畫出來，不能變成會去抓網址的圖片或連結。
function cell(value: string) {
  return truncate(value.replace(/[\r\n\t]+/g, ' '), DB_CELL_WIDTH).replace(/[\\|[\]()!<>*_`~]/g, '\\$&') || ' '
}

// 查詢結果畫成一張 Markdown 表格：上千個格子一格一個元素太重，一個 Markdown 就好。
// 欄位多時一列就上千字：只畫到 CODE_MAX_CHARS 字為止，rows 是畫了幾列（格子裡沒有換行，一列一行）。
function resultTable(r: DbResult) {
  const line = (cells: string[]) => `| ${cells.map(cell).join(' | ')} |`
  const width = r.columns.length
  const { text } = cutAtLineEnd(
    [line(r.columns), `|${' --- |'.repeat(width)}`, ...r.rows.map(row => line(Array.from({ length: width }, (_, i) => row[i] ?? '')))].join('\n'),
  )

  return { text, rows: Math.max(0, text.split('\n').length - 2) }
}

function resultNote(r: DbResult, shown: number) {
  const more = r.isTruncated ? '+' : ''
  if (r.total > shown) return `First ${shown} of ${r.total}${more} rows`

  return `${r.total}${more} row${r.total === 1 && more === '' ? '' : 's'}`
}

function connectionView({ w, d, a }: TabContext) {
  const { Box, Markdown, Text } = w
  const db = d.db
  const c = db.connections.find(x => x.id === db.open)
  const table = db.result !== null && db.result.columns.length > 0 ? resultTable(db.result) : undefined

  const tableRow = (t: DbTable) => {
    const key = tableKey(t)
    const isOpen = db.table === key

    return (
      <Box key={`db:table:${key}:box`} flexDirection="column">
        {w.pressRow({
          key: `db:table:${key}`,
          label: `${isOpen ? '▾' : '▸'} ${key}`,
          isBold: isOpen,
          isTruncated: true,
          rest: t.isView && <Text dimColor>view</Text>,
          onPress: () => a.toggleDbTable(t),
        })}
        {isOpen &&
          db.columns.map(col => (
            <Box key={`db:col:${key}:${col.name}`} gap={1} paddingLeft={6}>
              <Text>{col.name}</Text>
              <Text dimColor>{`${col.type}${col.isNullable ? '?' : ''}`}</Text>
            </Box>
          ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'db', () => a.closeDbConnection())}
        <Text bold wrap="truncate-end">{c === undefined ? db.open : connectionName(c)}</Text>
      </Box>
      {db.error !== '' && <Text color="error">{db.error}</Text>}
      {w.field('db:query', {
        placeholder: 'SELECT … (only SELECT runs)',
        value: db.query,
        submitLabel: 'Run',
        onInput: text => a.setDbQuery(text),
        onSubmit: text => a.runDbQuery(text),
      })}
      {db.queryError !== '' && <Text color="error">{db.queryError}</Text>}
      {d.dbBusy === 'query' ? (
        <Text dimColor>Running…</Text>
      ) : (
        db.result !== null && (
          <Box flexDirection="column">
            <Text dimColor>{resultNote(db.result, table?.rows ?? db.result.rows.length)}</Text>
            {table !== undefined && <Markdown text={table.text} />}
          </Box>
        )
      )}
      {w.divider}
      <Text bold dimColor>
        {db.tables === null ? 'Tables' : `Tables (${db.tables.length})`}
      </Text>
      {db.tables === null ? (
        <Text dimColor>Loading…</Text>
      ) : db.tables.length === 0 ? (
        <Text dimColor>No tables.</Text>
      ) : (
        <Box flexDirection="column">
          {db.tables.slice(0, DB_TABLE_LIMIT).map(tableRow)}
          {db.tables.length > DB_TABLE_LIMIT && <Text dimColor>{`… ${db.tables.length - DB_TABLE_LIMIT} more; query INFORMATION_SCHEMA.TABLES to see them.`}</Text>}
        </Box>
      )}
    </Box>
  )
}
