import type { FolderEntry } from '../../../types'
import { childPath, formatSize } from '../../files/list'
import { FOLDER_COLOR } from '../../config'
import { splitPath } from '../../git/parse'
import { backButton } from '../stepBar'
import type { TabBody } from './context'

// Files 分頁：session 資料夾（或點進去的子資料夾）裡有什麼。資料夾在前、點了進去。
// 子資料夾裡最上面是 ← Back（b）回上一層、旁邊是路徑；session 資料夾本身兩個都不畫，也就走不出去。
// 檔案列名稱和大小，點了在 Soap Panel 裡看內容（fileView）；register 只存前 FILES_ROW_LIMIT 筆，其餘寫「… N more」。
export const filesTab: TabBody = ({ w, d, a }) => {
  const { Box, Text } = w
  const f = d.files
  const hidden = f.total - f.entries.length

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
          {backButton(w, w.press, 'files', () => a.openDir(splitPath(f.dir).dir))}
          <Text bold dimColor wrap="truncate-start">{`${f.dir}/`}</Text>
        </Box>
      )}
      {body}
    </Box>
  )
}
