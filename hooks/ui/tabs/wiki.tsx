import type { WikiDraft } from '../../../types'
import { WIKI_DIR, WIKI_MODELS } from '../../config'
import { wikiModelOf } from '../../wiki/parse'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// Wiki 子分頁：.soap/wiki 底下的 Markdown 頁面，一頁一列：最左邊勾選框，最下面 Send（s）把勾了的送給 Claude；
// 點名稱在分頁裡看內容，最右邊垃圾桶按兩次才刪。
// 最上面 Summary Conversation（旁邊選問哪個模型：Current 是對話目前的模型）請 Claude 把這段對話值得留下的整理成草稿；草稿列在頁面上面，點開看內容（改既有頁面的看差異），
// Accept 才寫進 wiki、Discard 丟掉。
export const wikiTab: TabBody = ctx => {
  const s = ctx.d.wiki

  return s.draft !== '' ? draftView(ctx) : s.open !== '' ? pageView(ctx) : wikiList(ctx)
}

function wikiList(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const s = d.wiki
  if (!s.isLoaded) return <Text dimColor>Loading…</Text>
  const checked = new Set(s.checked)
  const sent = new Set(d.wikiSent)

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} flexWrap="wrap" alignItems="center" justifyContent="center">
        <Button
          key="wiki:distill"
          label={d.isDistilling ? 'Summarizing…' : 'Summary Conversation'}
          hotkey="d"
          onPress={w.press(() => a.distillWiki())}
        />
        <Text dimColor>│</Text>
        {w.select('wiki:model', {
          label: 'Model',
          // 還沒選過：跟對話同一種；對話的也讀不到就是第一個。
          value: s.model || d.currentModel || (WIKI_MODELS[0]?.id ?? ''),
          options: WIKI_MODELS.map(m => ({ value: m.id, label: m.label })),
          onSelect: value => {
            const model = wikiModelOf(value)
            if (model !== '') void a.selectWikiModel(model)
          },
        })}
      </Box>
      {s.distillNote !== '' && <Text dimColor>{s.distillNote}</Text>}
      {s.error !== '' && <Text color="error">{s.error}</Text>}
      {s.deleteError !== '' && <Text color="error">{s.deleteError}</Text>}
      {s.drafts.length > 0 && (
        <Box flexDirection="column">
          <Text bold>{`Drafts (${s.drafts.length})`}</Text>
          {s.drafts.map(draft => draftRow(ctx, draft))}
        </Box>
      )}
      {s.pages.length === 0 ? (
        <Text dimColor>{`No wiki pages yet. Press Summary Conversation to draft some from this conversation, or add Markdown files to ${WIKI_DIR}/.`}</Text>
      ) : (
        <Box flexDirection="column">
          {s.drafts.length > 0 && <Text bold>Pages</Text>}
          {s.pages.map(path => pageRow(ctx, path, checked.has(path), s.deleteArmed === path, sent.has(path)))}
        </Box>
      )}
      {s.pages.length > 0 && (
        <Box justifyContent="center">
          <Button key="wiki:send" label={`Send to Claude (${s.checked.length})`} hotkey="s" onPress={w.press(() => a.sendWikiPages())} />
        </Box>
      )}
    </Box>
  )
}

// 一頁一列：勾選框、名稱（點了看內容；這段對話送過的後面標 sent）、垃圾桶。
function pageRow({ w, a }: TabContext, path: string, isChecked: boolean, isArmed: boolean, isSent: boolean) {
  const { Box, Text } = w

  return (
    <Box key={`wiki:line:${path}`} gap={1} alignItems="center">
      {w.iconButton(`wiki:check:${path}`, isChecked ? 'boxChecked' : 'box', isChecked ? '[x]' : '[ ]', isChecked, () => a.toggleWikiPage(path))}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {w.pressRow({
          key: `wiki:page:${path}`,
          label: path,
          indent: 0,
          isTruncated: true,
          rest: isSent ? <Text dimColor>sent</Text> : undefined,
          onPress: () => a.openWikiPage(path),
          trailing: w.deleteButton(`wiki:delete:${path}`, isArmed, () => a.deleteWikiPage(path)),
        })}
      </Box>
    </Box>
  )
}

// 草稿是新頁面還是改既有頁面。
const draftBadge = ({ Text }: TabContext['w'], isNew: boolean) => <Text color={isNew ? 'success' : 'warning'}>{isNew ? 'new page' : 'edit'}</Text>

function draftRow({ w, a }: TabContext, draft: WikiDraft) {
  return w.pressRow({
    key: `wiki:draft:${draft.id}`,
    label: draft.target,
    isTruncated: true,
    rest: draftBadge(w, draft.isNew),
    onPress: () => a.openWikiDraft(draft.id),
  })
}

function pageView({ w, d, a }: TabContext) {
  const { Box, Markdown, Text } = w
  const s = d.wiki

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'wiki', () => a.closeWiki())}
        <Text bold wrap="truncate-start">{s.open}</Text>
      </Box>
      {s.readError !== '' && <Text color="error">{s.readError}</Text>}
      {s.readError === '' && (s.text === '' ? <Text dimColor>Empty page.</Text> : <Markdown text={s.text} />)}
      {s.isTruncated && <Text dimColor>Page is too long; showing only the beginning.</Text>}
    </Box>
  )
}

function draftView({ w, d, a }: TabContext) {
  const { Box, Button, Markdown, Text } = w
  const s = d.wiki
  const draft = s.drafts.find(x => x.id === s.draft)
  const isNew = draft?.isNew !== false

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'wiki', () => a.closeWiki())}
        <Text bold wrap="truncate-start">{draft?.target ?? s.draft}</Text>
        {draftBadge(w, isNew)}
      </Box>
      {s.deleteError !== '' && <Text color="error">{s.deleteError}</Text>}
      {s.readError !== '' && <Text color="error">{s.readError}</Text>}
      {s.readError === '' &&
        (isNew ? (
          <Markdown text={s.text} />
        ) : s.diff === '' ? (
          <Text dimColor>Same as the page now.</Text>
        ) : (
          <w.Code source={s.diff} format="diff" path={draft?.target ?? ''} />
        ))}
      {s.isTruncated && <Text dimColor>Too long; showing only the beginning.</Text>}
      {s.readError === '' && (
        <Box gap={1} justifyContent="center">
          <Button key="wiki:accept" label="Accept" hotkey="a" onPress={w.press(() => a.acceptWikiDraft())} />
          <Button key="wiki:discard" label="Discard" hotkey="x" onPress={w.press(() => a.discardWikiDraft())} />
        </Box>
      )}
    </Box>
  )
}
