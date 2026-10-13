import { PLAN_FILE } from '../../config'
import { planPath } from '../../spec/parse'
import { backButton } from '../stepBar'
import type { Widgets } from '../widgets'
import type { TabBody, TabContext } from './context'

// Spec 分頁：plan skill 在 .soap/tasks/<feature>/plan.yaml 寫的計劃，一個 feature 一列，最新改的在上面。
// 點了在分頁裡看它的 Description／Goals／Related／Verify，最上面 ← Back（b）回清單，最底下正中間 Do（d）叫 Claude 照它做。
// plan.yaml 格式不對時先列出哪裡不對（紅字），讀得到的部分照樣畫。
export const specTab: TabBody = ctx => (ctx.d.spec.open === '' ? specList(ctx) : planView(ctx))

function specList({ w, d, a }: TabContext) {
  const { Box, Text } = w
  const s = d.spec
  if (!s.isLoaded) return <Text dimColor>Loading…</Text>
  if (s.error !== '') return <Text color="error">{s.error}</Text>
  if (s.specs.length === 0) return <Text dimColor>No specs yet. Run /soap-mods:plan to write one.</Text>

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

// 一段：Markdown 標題（比面板的字大），底下的內容（一樣是 Markdown）包在圓角框裡；沒內容寫 None。
function section(w: Widgets, title: string, markdown: string) {
  const { Box, Markdown, Text } = w

  return (
    <Box key={`spec:section:${title}`} flexDirection="column">
      <Markdown text={`### ${title}`} />
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {markdown === '' ? <Text dimColor>None</Text> : <Markdown text={markdown} />}
      </Box>
    </Box>
  )
}

// 條列（Markdown 清單，跟 Claude 回覆的字一樣大）。code：每項包成 inline code（Verify 的指令）；
// 指令裡有反引號就用兩個反引號包，前後各空一格，Markdown 才不會切錯。
function bulletList(items: readonly string[], isCode = false) {
  const asCode = (item: string) => (item.includes('`') ? `\`\` ${item} \`\`` : `\`${item}\``)

  return items.map(item => `- ${isCode ? asCode(item) : item}`).join('\n')
}

function planView({ w, d, a }: TabContext) {
  const { Box, Button, Text } = w
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
        <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" bold>{`${planPath(s.open)} has problems:`}</Text>
          {s.problems.map((problem, i) => (
            <Text key={`spec:problem:${i}`} color="error">{`! ${problem}`}</Text>
          ))}
        </Box>
      )}
      {section(w, 'Description', p.description)}
      {section(w, 'Goals', bulletList(p.goals))}
      {section(w, 'Related', bulletList(p.related, true))}
      {section(w, 'Verify', bulletList(p.verify, true))}
      <Box justifyContent="center">
        <Button key="spec:do" label="Do" hotkey="d" onPress={w.press(() => a.doSpec())} />
      </Box>
    </Box>
  )
}
