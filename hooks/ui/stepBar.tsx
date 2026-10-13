// 差異和檔案內容最上面那排：← Back（b）；有好幾個檔案時接著「3 of 15 files」和 Previous／Next（n／m）。
// key 是「prefix:back」這種，焦點圈認得 *:back（keys.ts）。

import type { Press, Ui } from './actions'

// ← Back（b）。key 一律是「prefix:back」，焦點圈靠這個找到它（keys.ts 的 ringAnchor）。
export function backButton(ui: Pick<Ui, 'Button'>, press: Press, prefix: string, onBack: () => unknown) {
  return <ui.Button key={`${prefix}:back`} label="← Back" hotkey="b" onPress={press(onBack)} />
}

export function stepBar(
  ui: Ui,
  press: Press,
  prefix: string,
  index: number,
  total: number,
  onBack: () => unknown,
  onStep: (step: 1 | -1) => unknown,
) {
  const { Box, Button, Text } = ui

  return (
    <Box gap={1} flexWrap="wrap" alignItems="center">
      {backButton(ui, press, prefix, onBack)}
      {total > 1 && [
        <Text key={`${prefix}:count`} dimColor>{`${index + 1} of ${total} files`}</Text>,
        <Button key={`${prefix}:prev`} label="↑ Previous" hotkey="n" onPress={press(() => onStep(-1))} />,
        <Button key={`${prefix}:next`} label="↓ Next" hotkey="m" onPress={press(() => onStep(1))} />,
      ]}
    </Box>
  )
}
