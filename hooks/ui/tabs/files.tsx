import type { FolderEntry } from '../../../types'
import { childPath, formatSize } from '../../files/list'
import { FOLDER_COLOR } from '../../config'
import { splitPath } from '../../git/parse'
import type { TabBody } from './context'

// Files 分頁：session 資料夾（或點進去的子資料夾）裡有什麼。資料夾在前、點了進去。
// 子資料夾裡最上面是 ← Back（b）回上一層、旁邊是路徑；session 資料夾本身兩個都不畫，也就走不出去。
// 檔案只列名稱和大小；register 只存前 FILES_ROW_LIMIT 筆，其餘寫「… N more」。
export const filesTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const f = d.files
  const hidden = f.total - f.entries.length

  const entryRow = (e: FolderEntry) =>
    e.kind === 'dir' ? (
      w.pressRow({ key: `files:dir:${e.name}`, label: `${e.name}/`, color: FOLDER_COLOR, onPress: () => a.openDir(childPath(f.dir, e.name)) })
    ) : (
      <Box key={`files:file:${e.name}`} gap={1} paddingLeft={2}>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text dimColor={e.kind === 'other'} wrap="truncate-end">
            {e.name}
          </Text>
        </Box>
        {e.kind === 'file' && (
          <Box flexShrink={0}>
            <Text dimColor>{formatSize(e.size)}</Text>
          </Box>
        )}
      </Box>
    )

  const body = !f.isLoaded ? (
    <Text dimColor>Loading…</Text>
  ) : f.error !== '' ? (
    <Text color="error">{f.error}</Text>
  ) : f.total === 0 ? (
    <Text dimColor>This folder is empty.</Text>
  ) : (
    <Box flexDirection="column">
      {f.entries.map(entryRow)}
      {hidden > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>{`… ${hidden} more`}</Text>
        </Box>
      )}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {f.dir !== '' && (
        <Box gap={1} alignItems="center">
          <Button key="files:back" label="← Back" hotkey="b" onPress={w.press(() => a.openDir(splitPath(f.dir).dir))} />
          <Text bold dimColor wrap="truncate-start">{`${f.dir}/`}</Text>
        </Box>
      )}
      {body}
    </Box>
  )
}
