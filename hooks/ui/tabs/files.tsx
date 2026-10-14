import type { FolderEntry } from '../../../types'
import { childPath, formatSize } from '../../files/list'
import { FILES_WALK_LIMIT, FOLDER_COLOR } from '../../config'
import { splitPath } from '../../git/parse'
import { hasQuery } from '../../search'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// Files 分頁：session 資料夾（或點進去的子資料夾）裡有什麼。資料夾在前、點了進去。
// 子資料夾裡最上面是 ← Back（b）回上一層、旁邊是路徑；session 資料夾本身兩個都不畫，也就走不出去。
// 檔案列名稱和大小，點了在 Soap Panel 裡看內容（fileView）；register 只存前 FILES_ROW_LIMIT 筆，其餘寫「… N more」。
// 最上面的搜尋框有字時，改列整個 session 資料夾裡檔名符合的檔案（searchBody）。
export const filesTab: TabBody = ctx => {
  const { w, d, a } = ctx
  const { Box, Text } = w
  const f = d.files
  const hidden = f.total - f.entries.length
  const isSearching = hasQuery(f.query)

  // 資料夾點了進去；檔案（連結也是）點了看內容，大小貼在最右邊。
  const entryRow = (e: FolderEntry) =>
    e.kind === 'dir'
      ? w.pressRow({ key: `files:dir:${e.name}`, label: `${e.name}/`, color: FOLDER_COLOR, onPress: () => a.openDir(childPath(f.dir, e.name)) })
      : w.pressRow({
          key: `files:file:${e.name}`,
          label: e.name,
          isDim: e.kind === 'other',
          isTruncated: true,
          rest: e.kind === 'file' && <Text dimColor>{formatSize(e.size)}</Text>,
          onPress: () => a.openFile(childPath(f.dir, e.name)),
        })

  const body = !f.isLoaded ? (
    <Text dimColor>Loading…</Text>
  ) : f.error !== '' ? (
    <Text color="error">{f.error}</Text>
  ) : f.total === 0 ? (
    <Text dimColor>This folder is empty.</Text>
  ) : (
    <Box flexDirection="column">
      {f.entries.map(entryRow)}
      {hidden > 0 && note(ctx, `… ${hidden} more`)}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {w.searchField('files:search', f.query, text => a.searchFiles(text))}
      {!isSearching && f.dir !== '' && (
        <Box gap={1} alignItems="center">
          {backButton(w, w.press, 'files', () => a.openDir(splitPath(f.dir).dir))}
          <Text bold dimColor wrap="truncate-start">{`${f.dir}/`}</Text>
        </Box>
      )}
      {isSearching ? searchBody(ctx) : body}
    </Box>
  )
}

// 搜尋結果：一個檔案一列，檔名、淡色的所在資料夾；found 是 null 時還在走資料夾。
function searchBody(ctx: TabContext) {
  const { w, a } = ctx
  const { Box, Text } = w
  const found = ctx.d.files.found
  if (found === null) return <Text dimColor>Searching…</Text>
  if (found.total === 0) return <Text dimColor>No files match.</Text>
  const hidden = found.total - found.paths.length

  return (
    <Box flexDirection="column">
      {found.paths.map(path => {
        const { name, dir } = splitPath(path)

        return w.pressRow({
          key: `files:found:${path}`,
          label: name,
          isTruncated: true,
          rest: dir !== '' && <Text dimColor wrap="truncate-start">{dir}</Text>,
          onPress: () => a.openFile(path),
        })
      })}
      {hidden > 0 && note(ctx, `… ${hidden} more`)}
      {found.isCapped && note(ctx, `Only the first ${FILES_WALK_LIMIT} files were searched.`)}
    </Box>
  )
}

// 列表底下淡色的一行說明（還有幾筆沒畫、只找了前幾個檔案）。
function note({ w }: TabContext, text: string) {
  const { Box, Text } = w

  return (
    <Box paddingLeft={2}>
      <Text dimColor>{text}</Text>
    </Box>
  )
}
