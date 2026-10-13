// Files 分頁點開的檔案內容，畫在 Soap Panel 裡蓋掉分頁。

import type { FileView, FilesView } from '../../types'
import { fileSteps } from '../files/list'
import type { Actions, Press, Ui } from './actions'
import { stepBar } from './stepBar'

export function fileView(ui: Ui, shown: FileView, files: FilesView, a: Actions, press: Press) {
  const { Box, Code, Text } = ui
  const steps = fileSteps(files)

  return (
    <Box flexDirection="column" gap={1}>
      {stepBar(ui, press, 'fileview', steps.indexOf(shown.path), steps.length, () => a.closeCover(), step => a.stepFile(step))}
      <Text bold>{shown.path}</Text>
      {shown.error !== '' && <Text color="error">{shown.error}</Text>}
      {shown.note !== '' && <Text dimColor>{shown.note}</Text>}
      {shown.text !== '' && <Code source={shown.text} path={shown.path} startLine={1} />}
      {shown.isTruncated && <Text dimColor>File is too long; showing only the beginning.</Text>}
    </Box>
  )
}
