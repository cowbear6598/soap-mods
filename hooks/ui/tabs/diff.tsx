import { FILE_GROUPS, FILE_PAGE } from '../../config'
import type { FileEntry, FileGroupId } from '../../git/parse'
import { canDiscard, groupFiles } from '../../git/parse'
import type { TabBody } from './context'

// diff 分頁：未提交的變更，分 Staged／Unstaged／Untracked。點檔案：衝突的開三欄合併，其他看差異（都畫在 Soap Panel 裡）。
// 每組最多畫 fileLimit 個，其餘按 Show more 再多畫 FILE_PAGE 個。
// 每列右邊一個垃圾桶（衝突、改名、複製的除外），按了換成打勾、再按才做：未追蹤的刪掉檔案，其他的捨棄這個檔案所有的變更。
export const diffTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const v = d.view
  if (v.files.length === 0) return <Text dimColor>No uncommitted changes.</Text>

  const groups = groupFiles(v.files)
  const fileRow = (group: FileGroupId, { file, letter, kind }: FileEntry) =>
    w.pathRow(`file:${group}:${file.path}`, file.path, letter, kind, () => (kind === 'conflict' ? a.openMerge(file.path) : a.openDiff(file.path)), {
      // 沒有垃圾桶要給 undefined：pressRow 看到 trailing 就會改排版。
      trailing: canDiscard(file) ? w.deleteButton(`discard:${group}:${file.path}`, v.fileArmed === file.path, () => a.discardFile(file)) : undefined,
    })

  return (
    <Box flexDirection="column" gap={1}>
      {v.fileError !== '' && <Text color="error">{v.fileError}</Text>}
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
