// 選中檔案的差異，開在自己的面板裡：diff 分頁的未提交變更，或 log 分頁某個 commit 裡的檔案（標題後面加 @ sha）。
// commit 的檔案有好幾個時，標題下面一行「3 of 15 files」和 Previous／Next，面板拿著鍵盤時按 n／m 也行（跟合併面板一樣）。

import type { DiffPaneView } from '../../types'
import { KIND_STYLE } from '../config'
import { commitsLabel } from '../git/parse'
import type { Actions, Press, Ui } from './actions'

export function renderDiffPane(ui: Ui, shown: DiffPaneView, a: Actions, press: Press) {
  const { Box, Button, Code, Text } = ui

  if (shown.path === '') return <Text dimColor>No file selected.</Text>

  const kind = KIND_STYLE[shown.kind]

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text bold color={kind.theme}>
          {kind.label}
        </Text>
        <Text bold>{shown.path}</Text>
        {shown.commits.length > 0 && <Text dimColor>{`@ ${commitsLabel(shown.commits)}`}</Text>}
      </Box>
      {shown.files.length > 1 && (
        <Box gap={1} flexWrap="wrap" alignItems="center">
          <Text dimColor>{`${shown.files.findIndex(f => f.path === shown.path) + 1} of ${shown.files.length} files`}</Text>
          <Button key="diff:prev" label="↑ Previous" hotkey="n" onPress={press(() => a.stepCommitFile(-1))} />
          <Button key="diff:next" label="↓ Next" hotkey="m" onPress={press(() => a.stepCommitFile(1))} />
        </Box>
      )}
      {shown.error !== '' && <Text color="error">{shown.error}</Text>}
      {shown.diff === '' ? (
        <Text dimColor>No text diff to show (binary file, or only the mode changed).</Text>
      ) : (
        <Code source={shown.diff} format="diff" path={shown.path} />
      )}
      {shown.isTruncated && <Text dimColor>Diff is too long; showing only the beginning.</Text>}
    </Box>
  )
}
