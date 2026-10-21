// 選中檔案的差異，畫在 Soap Panel 裡蓋掉分頁：
// diff 分頁的未提交變更，或 log 分頁某個 commit 裡的檔案（路徑後面加 @ sha）。

import type { DiffPage, DiffPaneView } from '../../types'
import { KIND_STYLE } from '../config'
import { commitsLabel } from '../git/parse'
import type { Actions, Press, Ui } from './actions'
import type { Widgets } from './widgets'
import { stepBar } from './stepBar'

export function diffView(ui: Ui, w: Widgets, shown: DiffPaneView, pages: Readonly<Record<string, DiffPage>>, a: Actions, press: Press) {
  const { Box, Text } = ui
  const kind = KIND_STYLE[shown.kind]
  const index = shown.files.findIndex(f => f.path === shown.path)

  return (
    <Box flexDirection="column" gap={1}>
      {stepBar(ui, press, 'diff', index, shown.files.length, () => a.closeCover(), step => a.stepDiffFile(step))}
      <Box gap={1} flexWrap="wrap">
        <Text bold color={kind.theme}>
          {kind.label}
        </Text>
        <Text bold>{shown.path}</Text>
        {shown.commits.length > 0 && <Text dimColor>{`@ ${commitsLabel(shown.commits)}`}</Text>}
      </Box>
      {shown.error !== '' && <Text color="error">{shown.error}</Text>}
      {shown.diff === '' ? (
        <Text dimColor>No text diff to show (binary file, or only the mode changed).</Text>
      ) : (
        w.diff(shown.diff, 'diffpage', `${shown.commits.map(c => c.sha).join(',')}:${shown.path}`, pages, a.showDiffPage)
      )}
      {shown.isTruncated && <Text dimColor>Diff is too long; showing only the beginning.</Text>}
    </Box>
  )
}
