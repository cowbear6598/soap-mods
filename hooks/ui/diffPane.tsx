// 選中檔案的差異，開在自己的面板裡：diff 分頁的未提交變更，或 log 分頁某個 commit 裡的檔案（標題後面加 @ sha）。

import type { DiffPaneView } from '../../types'
import { KIND_STYLE } from '../config'
import type { Ui } from './actions'

export function renderDiffPane(ui: Ui, shown: DiffPaneView) {
  const { Box, Code, Text } = ui

  if (shown.path === '') return <Text dimColor>No file selected.</Text>

  const kind = KIND_STYLE[shown.kind]

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1}>
        <Text bold color={kind.theme}>
          {kind.label}
        </Text>
        <Text bold>{shown.path}</Text>
        {shown.at !== '' && <Text dimColor>{`@ ${shown.at}`}</Text>}
      </Box>
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
