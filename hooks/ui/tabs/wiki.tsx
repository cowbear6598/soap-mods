import type { WikiDraft } from '../../../types'
import { FOLDER_COLOR, WIKI_DRAFTS_DIR, WIKI_MODELS } from '../../config'
import { pathTree, treeRows } from '../../tree'
import { draftPath, wikiModelOf, wikiPath } from '../../wiki/parse'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// Wiki 子分頁：.soap/wiki 底下的 Markdown 頁面，照資料夾畫成樹（資料夾一列，點了開合，預設打開），一頁一列：最左邊勾選框，
// 最下面 Send（s）把勾了的送給 Claude、Uncheck all 取消全部勾選；點名稱在分頁裡看內容，最右邊 @ 把路徑插進聊天框、垃圾桶按兩次才刪。
// 最上面 Summary Conversation（旁邊選問哪個模型：Current 是對話目前的模型）請 Claude 把這段對話值得留下的整理成草稿；
// /soap-mods:wiki 跟 Claude 討論後寫的草稿也在這裡。草稿列在頁面上面，照它寫到的頁面路徑跟頁面一樣畫成樹，右邊 @ 插草稿檔的路徑、
// 垃圾桶按兩次丟掉；點開看內容（改既有頁面的看差異，搬移、刪除看那頁現在的內容），
// Accept 才照草稿改 wiki、Discard 丟掉。
export const wikiTab: TabBody = ctx => {
  const s = ctx.d.wiki

  return s.draft !== '' ? draftView(ctx) : s.open !== '' ? pageView(ctx) : wikiList(ctx)
}

type TreeRow = ReturnType<typeof treeRows<string>>[number]
type DraftTreeRow = ReturnType<typeof treeRows<WikiDraft>>[number]

function wikiList(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const s = d.wiki
  if (!s.isLoaded) return <Text dimColor>Loading…</Text>
  const rows = treeRows(pathTree(s.pages, path => path), path => d.wikiFolders[path] ?? true)
  // 草稿樹從 .drafts/ 長出來再跳過這層：資料夾路徑帶著 .drafts/，開合跟頁面樹分開記（頁面路徑不會以 . 開頭，撞不到）。
  const draftRows = treeRows(pathTree(s.drafts, draft => `${WIKI_DRAFTS_DIR}/${draft.target}`, true), path => d.wikiFolders[path] ?? true)

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
          {draftRows.map(row => draftRow(ctx, row))}
        </Box>
      )}
      {s.pages.length > 0 && (
        <Box flexDirection="column">
          {s.drafts.length > 0 && <Text bold>Pages</Text>}
          {rows.map(row => wikiRow(ctx, row))}
        </Box>
      )}
      {s.pages.length > 0 && (
        <Box gap={1} justifyContent="center">
          <Button key="wiki:send" label={`Send to Claude (${s.checked.length})`} hotkey="s" onPress={w.press(() => a.sendWikiPages())} />
          {s.checked.length > 0 && <Button key="wiki:uncheck" label="Uncheck all" onPress={w.press(() => a.uncheckAllWikiPages())} />}
        </Box>
      )}
    </Box>
  )
}

// 資料夾列「db/ · 3 ▾」，點了開合。
function folderRow({ w, a }: TabContext, row: Extract<TreeRow | DraftTreeRow, { kind: 'folder' }>) {
  const { path, label, count } = row.folder

  return w.pressRow({
    key: `wiki:folder:${path}`,
    label: `${label} · ${count} ${row.isOpen ? '▾' : '▸'}`,
    color: FOLDER_COLOR,
    indent: row.depth * 2,
    onPress: () => a.toggleWikiFolder(path, !row.isOpen),
  })
}

// 頁面列、草稿列最右邊：@ 把檔案路徑插進聊天框，垃圾桶按兩次才刪。path 是 .soap/wiki 底下的（草稿是 .drafts/<id>）。
function fileButtons({ w, d, a }: TabContext, path: string) {
  return (
    <w.Box key={`wiki:trailing:${path}`} gap={1} alignItems="center">
      {w.iconButton(`wiki:mention:${path}`, 'at', '@', false, () => a.mentionPath(wikiPath(path)))}
      {w.deleteButton(`wiki:delete:${path}`, d.wiki.deleteArmed === path, () => a.deleteWikiFile(path))}
    </w.Box>
  )
}

// 樹的一列：資料夾點了開合；頁面是勾選框、名稱（扣掉所在資料夾；點了看內容；這段對話送過的後面標 sent）、@、垃圾桶。
// 跟同一層的其他列一樣縮排。沒給 limit，不會有「… more」那種列。
function wikiRow(ctx: TabContext, row: TreeRow) {
  const { w, d, a } = ctx
  const { Box, Text } = w
  if (row.kind === 'more') return null
  const indent = row.depth * 2
  if (row.kind === 'folder') return folderRow(ctx, row)
  const path = row.item
  const isChecked = d.wiki.checked.includes(path)

  return (
    <Box key={`wiki:line:${path}`} gap={1} alignItems="center" paddingLeft={indent}>
      {w.iconButton(`wiki:check:${path}`, isChecked ? 'boxChecked' : 'box', isChecked ? '[x]' : '[ ]', isChecked, () => a.toggleWikiPage(path))}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {w.pressRow({
          key: `wiki:page:${path}`,
          label: row.label,
          indent: 0,
          isTruncated: true,
          rest: d.wikiSent.includes(path) ? <Text dimColor>sent</Text> : undefined,
          onPress: () => a.openWikiPage(path),
          trailing: fileButtons(ctx, path),
        })}
      </Box>
    </Box>
  )
}

// 草稿做什麼：新頁面、改既有頁面、搬移、刪除。
const DRAFT_BADGES = {
  new: { label: 'new page', color: 'success' },
  edit: { label: 'edit', color: 'warning' },
  move: { label: 'move', color: 'suggestion' },
  delete: { label: 'delete', color: 'error' },
} as const

function draftBadge({ Text }: TabContext['w'], draft: WikiDraft) {
  const badge = DRAFT_BADGES[draft.kind === 'write' ? (draft.isNew ? 'new' : 'edit') : draft.kind]

  return <Text color={badge.color}>{badge.label}</Text>
}

// 打開的草稿上面的名稱：搬移寫「舊 → 新」。
const draftLabel = (draft: WikiDraft) => (draft.kind === 'move' ? `${draft.from} → ${draft.target}` : draft.target)

// 草稿樹的一列：草稿放在它寫到的頁面的資料夾底下，名稱扣掉那個資料夾；搬移的照樣寫完整的「舊 → 新」，才看得出從哪搬來。
// 右邊 @ 把草稿檔的路徑插進聊天框，垃圾桶按兩次丟掉草稿。
function draftRow(ctx: TabContext, row: DraftTreeRow) {
  const { w, a } = ctx
  if (row.kind === 'more') return null
  if (row.kind === 'folder') return folderRow(ctx, row)
  const draft = row.item

  return w.pressRow({
    key: `wiki:draft:${draft.id}`,
    label: draft.kind === 'move' ? draftLabel(draft) : row.label,
    indent: row.depth * 2,
    isTruncated: true,
    onPress: () => a.openWikiDraft(draft.id),
    trailing: fileButtons(ctx, draftPath(draft.id)),
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

// 打開的草稿的內容：寫整頁的看 Markdown 或差異；搬移、刪除先說會怎樣，底下是那頁現在的內容。
function draftBody({ w, d }: TabContext, draft: WikiDraft) {
  const { Box, Markdown, Text } = w
  const s = d.wiki
  if (draft.kind === 'write') {
    if (draft.isNew) return <Markdown text={s.text} />

    return s.diff === '' ? <Text dimColor>Same as the page now.</Text> : <w.Code source={s.diff} format="diff" path={draft.target} />
  }
  const intro =
    draft.kind === 'move' ? (
      <Text>{`Moves ${wikiPath(draft.from)} to ${wikiPath(draft.target)}; the text stays as it is:`}</Text>
    ) : (
      <Text color="error">{`Deletes ${wikiPath(draft.target)}:`}</Text>
    )

  return (
    <Box flexDirection="column" gap={1}>
      {intro}
      {s.readError === '' && (s.text === '' ? <Text dimColor>Empty page.</Text> : <Markdown text={s.text} />)}
    </Box>
  )
}

// 打開的草稿。Accept 只要草稿看得懂（在清單上）就按得到，做不成的原因由套用時說；Discard 一直都在。
function draftView(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const s = d.wiki
  const draft = s.drafts.find(x => x.id === s.draft)

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'wiki', () => a.closeWiki())}
        <Text bold wrap="truncate-start">{draft === undefined ? s.draft : draftLabel(draft)}</Text>
        {draft !== undefined && draftBadge(w, draft)}
      </Box>
      {s.deleteError !== '' && <Text color="error">{s.deleteError}</Text>}
      {s.readError !== '' && <Text color="error">{s.readError}</Text>}
      {draft !== undefined && draftBody(ctx, draft)}
      {s.isTruncated && <Text dimColor>Too long; showing only the beginning.</Text>}
      <Box gap={1} justifyContent="center">
        {draft !== undefined && <Button key="wiki:accept" label="Accept" hotkey="a" onPress={w.press(() => a.acceptWikiDraft())} />}
        <Button key="wiki:discard" label="Discard" hotkey="x" onPress={w.press(() => a.discardWikiDraft())} />
      </Box>
    </Box>
  )
}
