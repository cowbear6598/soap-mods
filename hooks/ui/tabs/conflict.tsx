import type { GitFile } from '../../../types'
import { OP_LABEL } from '../../config'
import { isConflict } from '../../git/parse'
import { conflictLabel } from '../../merge/algo'
import type { TabBody } from './context'

// conflict 分頁。停在 merge／rebase 時：最上面是進行中的操作和 Abort／Continue（衝突全解完才有 Continue），
// 下面是還沒解的檔案，點了在 Soap Panel 裡開三欄合併。
export const conflictTab: TabBody = ({ w, d, a }) => {
  const { Box, Button, Text } = w
  const v = d.view
  const conflicts = v.files.filter(isConflict)
  const opLabel = v.op === '' ? '' : OP_LABEL[v.op]
  const conflictRow = (f: GitFile) => w.pathRow(`conflict:${f.path}`, f.path, () => a.openMerge(f.path), { status: { letter: '!', kind: 'conflict' }, note: conflictLabel(f) })

  return (
    <Box flexDirection="column" gap={1}>
      {v.opError !== '' && <Text color="error">{v.opError}</Text>}
      {v.op !== '' && (
        <Box flexDirection="column">
          <Text bold color="warning">{`${opLabel} in progress`}</Text>
          <Box gap={1} flexWrap="wrap">
            {conflicts.length === 0 && (
              <Button key="op:continue" label={`Continue ${v.op}`} variant="primary" onPress={w.press(() => a.continueOp())} />
            )}
            {v.isAbortArmed
              ? [
                  <Button key="op:abort" label={`Yes, abort ${v.op}`} onPress={w.press(() => a.abortOp())} />,
                  <Button key="op:abort-cancel" label="Cancel" onPress={w.press(() => a.cancelAbort())} />,
                ]
              : [<Button key="op:abort" label={`Abort ${v.op}`} onPress={w.press(() => a.abortOp())} />]}
          </Box>
          {v.isAbortArmed && <Text color="warning">Aborting throws away every resolution made so far.</Text>}
        </Box>
      )}
      {conflicts.length === 0 ? (
        <Text dimColor>{v.op === '' ? 'No conflicts.' : 'All conflicts resolved.'}</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold dimColor>{`Conflicts · ${conflicts.length}`}</Text>
          {conflicts.map(conflictRow)}
        </Box>
      )}
    </Box>
  )
}
