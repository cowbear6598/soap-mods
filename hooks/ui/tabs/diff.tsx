import { FILE_GROUPS, FILE_PAGE } from '../../config'
import type { FileEntry, FileGroupId } from '../../git/parse'
import { groupFiles } from '../../git/parse'
import type { TabBody } from './context'

// diff 分頁：未提交的變更，分 Staged／Unstaged／Untracked。點檔案：衝突的開合併面板，其他開差異面板。
// 每組最多畫 fileLimit 個，其餘按 Show more 再多畫 FILE_PAGE 個。
export const diffTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const v = d.view
  if (v.files.length === 0) return <Text dimColor>No uncommitted changes.</Text>

  const groups = groupFiles(v.files)
  const fileRow = (group: FileGroupId, entry: FileEntry) =>
    w.pathRow(`file:${group}:${entry.file.path}`, entry.file.path, entry.letter, entry.kind, () =>
      entry.kind === 'conflict' ? a.openMerge(entry.file.path) : a.openDiff(entry.file.path),
    )

  return (
    <Box flexDirection="column" gap={1}>
      {FILE_GROUPS.filter(g => groups[g.id].length > 0).map(g => (
        <Box key={`group:${g.id}`} flexDirection="column">
          <Text bold dimColor>{`${g.label} · ${groups[g.id].length}`}</Text>
          {groups[g.id].slice(0, d.fileLimit).map(entry => fileRow(g.id, entry))}
          {groups[g.id].length > d.fileLimit && (
            <Button
              key={`file:more:${g.id}`}
              label={`Show more · ${groups[g.id].length - d.fileLimit} hidden`}
              onPress={w.press(() => a.showMoreFiles())}
            />
          )}
        </Box>
      ))}
    </Box>
  )
}
