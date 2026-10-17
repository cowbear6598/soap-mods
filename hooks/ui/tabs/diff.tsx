import { FILE_GROUPS, FILE_PAGE } from '../../config'
import type { FileEntry, FileGroupId } from '../../git/parse'
import { canDelete, canRollback, groupFiles } from '../../git/parse'
import type { TabBody } from './context'

// diff 分頁：未提交的變更，分 Staged／Unstaged／Untracked。點檔案：衝突的開三欄合併，其他看差異（都畫在 Soap Panel 裡）。
// 每組最多畫 fileLimit 個，其餘按 Show more 再多畫 FILE_PAGE 個。
// 每列右邊兩顆，都是按了換成打勾、再按才做：rollback 把檔案還原成 HEAD（HEAD 有的才有，衝突、改名、複製的除外），
// 垃圾桶只刪掉檔案（檔案還在、不是衝突的才有）。
export const diffTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const v = d.view
  if (v.files.length === 0) return <Text dimColor>No uncommitted changes.</Text>

  const groups = groupFiles(v.files)
  const fileRow = (group: FileGroupId, { file, letter, kind }: FileEntry) => {
    const isDeletable = canDelete(file)
    const isRollbackable = canRollback(file)

    return w.pathRow(`file:${group}:${file.path}`, file.path, () => (kind === 'conflict' ? a.openMerge(file.path) : a.openDiff(file.path)), {
      status: { letter, kind },
      // 一顆都沒有要給 undefined：pressRow 看到 trailing 就會改排版。
      trailing:
        isDeletable || isRollbackable ? (
          <Box key={`trailing:${group}:${file.path}`} gap={1} alignItems="center">
            {isRollbackable && w.rollbackButton(`rollback:${group}:${file.path}`, v.fileArmed === `rollback:${file.path}`, () => a.rollbackChange(file))}
            {/* key 用 remove: 不用 delete:：branch 列的刪除鈕佔了 delete:。 */}
            {isDeletable && w.deleteButton(`remove:${group}:${file.path}`, v.fileArmed === `delete:${file.path}`, () => a.deleteChange(file))}
          </Box>
        ) : undefined,
    })
  }

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
