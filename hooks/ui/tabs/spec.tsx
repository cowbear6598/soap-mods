import type { RenderChildren } from 'claude-code'

import { PLAN_FILE, SPEC_DIR } from '../../config'
import { backButton } from '../stepBar'
import type { Widgets } from '../widgets'
import type { TabBody, TabContext } from './context'

// Spec 分頁：soap-plan skill 在 .soap/tasks/<feature>/plan.yaml 寫的計劃，一個 feature 一列，最新改的在上面。
// 點了在分頁裡看它的 Description／Goals／Verify，最上面 ← Back（b）回清單。
// plan.yaml 格式不對時先列出哪裡不對（紅字），讀得到的部分照樣畫。
export const specTab: TabBody = ctx => (ctx.d.spec.open === '' ? specList(ctx) : planView(ctx))

function specList({ w, d, a }: TabContext) {
  const { Box, Text } = w
  const s = d.spec
  if (!s.isLoaded) return <Text dimColor>Loading…</Text>
  if (s.error !== '') return <Text color="error">{s.error}</Text>
  if (s.specs.length === 0) return <Text dimColor>No specs yet. Run /soap-plan to write one.</Text>

  return (
    <Box flexDirection="column">
      {s.specs.map(spec =>
        w.pressRow({
          key: `spec:item:${spec.name}`,
          label: spec.name,
          isDim: !spec.hasPlan,
          isTruncated: true,
          rest: !spec.hasPlan && <Text dimColor>{`no ${PLAN_FILE}`}</Text>,
          onPress: () => a.openSpec(spec.name),
        }),
      )}
    </Box>
  )
}

// 一段：粗體標題，底下是內容；沒內容寫 None。
function section(w: Widgets, title: string, body: RenderChildren, isEmpty: boolean) {
  const { Box, Text } = w

  return (
    <Box key={`spec:section:${title}`} flexDirection="column">
      <Text bold>{title}</Text>
      {isEmpty ? <Text dimColor>None</Text> : body}
    </Box>
  )
}

// 條列：每項前面一個符號，太長換行時對齊在符號後面。
function bullets(w: Widgets, prefix: string, items: readonly string[], mark: string) {
  const { Box, Text } = w

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={`${prefix}:${i}`} gap={1}>
          <Text dimColor>{mark}</Text>
          <Box flexShrink={1}>
            <Text>{item}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

function planView({ w, d, a }: TabContext) {
  const { Box, Text } = w
  const s = d.spec
  const p = s.plan
  const meta = [p.issueNumber, p.branch].filter(m => m !== '').join(' · ')

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'spec', () => a.closeSpec())}
        <Text bold wrap="truncate-start">{s.open}</Text>
      </Box>
      {meta !== '' && <Text dimColor>{meta}</Text>}
      {s.problems.length > 0 && (
        <Box flexDirection="column">
          <Text color="error" bold>{`${SPEC_DIR}/${s.open}/${PLAN_FILE} has problems:`}</Text>
          {bullets(w, 'spec:problem', s.problems, '!')}
        </Box>
      )}
      {section(w, 'Description', <Text>{p.description}</Text>, p.description === '')}
      {section(w, 'Goals', bullets(w, 'spec:goal', p.goals, '•'), p.goals.length === 0)}
      {section(w, 'Verify', bullets(w, 'spec:verify', p.verify, '$'), p.verify.length === 0)}
    </Box>
  )
}
