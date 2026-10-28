// 不採用的建議沒有按鈕可按（不 Resolve）：直接 Approve。衝突不在這裡解，Open Conflicts 開 GitLab 的頁面。

import type { MrDetail, MrItem, MrSuggestion, MrView } from '../../../types'
import { LOG_AGO_WIDTH } from '../../config'
import { statusStyle } from '../../ci/parse'
import { formatAgo } from '../../git/parse'
import { mergeBlocked, suggestionDiff } from '../../mr/parse'
import { isProd } from '../../text'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

export const mrTab: TabBody = ctx => {
  const mr = ctx.d.mr
  if (mr.isLoaded && mr.host !== '' && !mr.hasToken) return noToken(ctx, mr)
  if (mr.opening !== 0) return detail(ctx, mr)

  return reviewList(ctx, mr)
}

function noToken({ w, a }: TabContext, mr: MrView) {
  const { Box, Button, Text } = w

  return (
    <Box flexDirection="column" gap={1}>
      <Text>{`No GitLab token is saved for ${mr.host}. Save one in the CI tab; the MR tab uses the same.`}</Text>
      <Box>
        <Button key="mr:to-ci" label="Open CI" onPress={w.press(() => a.selectSubTab('git', 'ci'))} />
      </Box>
    </Box>
  )
}

const refreshButton = ({ w, d, a }: TabContext) => w.refreshButton('mr:refresh', { isBusy: d.mrRefreshing, isDone: d.flashed === 'mr:refresh' }, () => a.refreshMr())

function reviewList(ctx: TabContext, mr: MrView) {
  const { w, d, a } = ctx
  const { Box, Text } = w
  const row = (m: MrItem) =>
    w.pressRow({
      key: `mr:item:${m.iid}`,
      label: `${m.isDraft ? 'Draft: ' : ''}${m.title}`,
      isTruncated: true,
      indent: 0,
      isWholePressable: true,
      rest: w.cell(`mr:item:${m.iid}:ago`, formatAgo(m.time, d.now), LOG_AGO_WIDTH, { isDim: true, isEnd: true }),
      onPress: () => a.openMr(m.iid),
    })

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between" alignItems="center">
        <Text bold dimColor>{`Review requests · ${mr.list.length}`}</Text>
        {refreshButton(ctx)}
      </Box>
      {mr.error !== '' && <Text color="error">{mr.error}</Text>}
      {!mr.isLoaded ? (
        <Text dimColor>Loading…</Text>
      ) : (
        mr.error === '' &&
        (mr.list.length === 0 ? (
          <Text dimColor>No open merge requests ask you to review.</Text>
        ) : (
          <Box flexDirection="column">{mr.list.map(row)}</Box>
        ))
      )}
    </Box>
  )
}

const armedButton = ({ w, d }: TabContext, mr: MrView, key: string, armed: string, label: string, action: () => unknown, prod = false) =>
  w.confirmButton(key, label, { isArmed: d.armed === `mr:${mr.open?.iid}:${armed}`, isBusy: d.mrActing, isProd: prod }, action)

function toolbar(ctx: TabContext, open: MrDetail | null) {
  const { w, a } = ctx
  const { Box, Button } = w

  return (
    <Box justifyContent="space-between" alignItems="center">
      {backButton(w, w.press, 'mr', () => a.closeMr())}
      <Box gap={1} alignItems="center">
        {open !== null && open.webUrl !== '' && <Button key="mr:web" label="Open" onPress={w.press(() => a.openMrLink(open.webUrl))} />}
        {refreshButton(ctx)}
      </Box>
    </Box>
  )
}

// 簡介底下那排（置中）：Approve／Unapprove、Merge（不能 merge 時不畫，原因寫在簡介最後一行）。都沒有就不畫。
function decision(ctx: TabContext, mr: MrView, open: MrDetail) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  if (open.state !== 'opened') return null
  if (open.hasConflicts) {
    return (
      <Box justifyContent="center">
        <Button key="mr:conflicts" label="Open Conflicts" variant="primary" onPress={w.press(() => a.openMrLink(`${open.webUrl}/conflicts`))} />
      </Box>
    )
  }
  const canMerge = mergeBlocked(open.mergeStatus) === ''
  const canApprove = !open.hasApproved && open.canApprove
  if (!open.hasApproved && !canApprove && !canMerge) return null
  if (d.mrActing) {
    return (
      <Box justifyContent="center">
        <Text dimColor>Working…</Text>
      </Box>
    )
  }

  return (
    <Box gap={1} alignItems="center" justifyContent="center">
      {open.hasApproved && <Button key="mr:unapprove" label="Unapprove" onPress={w.press(() => a.approveMr(false))} />}
      {canApprove && <Button key="mr:approve" label="Approve" variant="primary" onPress={w.press(() => a.approveMr(true))} />}
      {canMerge && armedButton(ctx, mr, 'mr:merge', 'merge', 'Merge', () => a.mergeMr(), isProd(open.target))}
    </Box>
  )
}

// 「from  : 分支」：名稱補到同寬，冒號對齊；值太長截頭（分支名稱的尾巴才分得出來）。
const FIELD_WIDTH = 6
const field = (w: TabContext['w'], name: string, value: string) => (
  <w.Box key={`mr:field:${name}`} gap={1}>
    <w.Box flexShrink={0}>
      <w.Text dimColor>{`${name.padEnd(FIELD_WIDTH)}:`}</w.Text>
    </w.Box>
    <w.Text wrap="truncate-start">{value}</w.Text>
  </w.Box>
)

const agoText = (time: number, now: number) => {
  const ago = formatAgo(time, now)

  return ago === 'now' ? 'just now' : `${ago} ago`
}

function heading({ w, d }: TabContext, open: MrDetail) {
  const { Box, Text } = w
  const p = open.pipeline
  const s = p === null ? undefined : statusStyle(p.status)
  const blocked = mergeBlocked(open.mergeStatus)
  const approvals = open.approvedBy.length === 0 ? 'none' : open.approvedBy.join(', ')
  const left = open.approvalsLeft > 0 ? ` · ${open.approvalsLeft} more needed` : ''

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">{open.title}</Text>
      {field(w, 'from', open.source)}
      {field(w, 'to', open.target)}
      {open.author !== '' && field(w, 'author', open.author)}
      {p !== null && s !== undefined && (
        <Box gap={1}>
          <Text color={s.theme}>{`${s.mark} Pipeline #${p.iid} ${p.status}`}</Text>
          <Text dimColor>{p.shortSha}</Text>
        </Box>
      )}
      <Text>{`Approved by: ${approvals}${left}`}</Text>
      {open.state === 'merged' ? (
        <Text color="success">{`Merged${open.mergedBy === '' ? '' : ` by ${open.mergedBy}`} ${agoText(open.mergedAt, d.now)} into ${open.target}${open.mergeCommit === '' ? '' : ` with ${open.mergeCommit}`}`}</Text>
      ) : open.state !== 'opened' ? (
        <Text dimColor>{`This merge request is ${open.state}.`}</Text>
      ) : blocked === '' ? (
        <Text color="success">Ready to merge</Text>
      ) : (
        <Text color="warning">{`Can't merge yet: ${blocked}`}</Text>
      )}
    </Box>
  )
}

function suggestionBox(ctx: TabContext, mr: MrView, open: MrDetail, s: MrSuggestion) {
  const { w, d, a } = ctx
  const { Box, Button, Markdown, Text } = w
  const key = `mr:s:${s.note}`
  const isOpen = open.state === 'opened' && !s.isResolved
  const canApply = isOpen && s.isSingle && s.old !== null

  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
      <Box flexDirection="column">
        <Box justifyContent="space-between" gap={1}>
          <Text bold dimColor={s.isResolved} wrap="truncate-end">{`${s.path.split('/').pop() ?? s.path}:${s.line}`}</Text>
          <Text dimColor>{`${s.author} · ${formatAgo(s.time, d.now)}${s.isResolved ? ' · resolved' : ''}`}</Text>
        </Box>
        <Text dimColor wrap="truncate-start">{s.path}</Text>
      </Box>
      {s.comment !== '' && <Markdown text={s.comment} />}
      {s.old === null ? (
        <Text dimColor>{`Couldn't read the lines it replaces. It suggests:\n${s.lines.join('\n')}`}</Text>
      ) : (
        w.diff(suggestionDiff(s), key, `${s.note}`, d.diffPages, a.showDiffPage)
      )}
      {!s.isSingle && isOpen && <Text dimColor>This note has more than one suggestion; apply it on GitLab.</Text>}
      <Box gap={1} justifyContent="flex-end">
        {canApply && armedButton(ctx, mr, `${key}:apply`, `apply:${s.note}`, 'Apply', () => a.applyMrSuggestion(s))}
        {s.webUrl !== '' && <Button key={`${key}:open`} label="Open" onPress={w.press(() => a.openMrLink(s.webUrl))} />}
      </Box>
    </Box>
  )
}

function suggestions(ctx: TabContext, mr: MrView, open: MrDetail) {
  const { w, a } = ctx
  const { Box, Button, Text } = w
  const all = mr.suggestions ?? []
  const pending = all.filter(s => !s.isResolved)
  const resolved = all.filter(s => s.isResolved)

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold dimColor>{`Suggestions · ${pending.length} open${resolved.length === 0 ? '' : ` · ${resolved.length} resolved`}`}</Text>
      {mr.suggestions === null ? (
        <Text dimColor>Loading…</Text>
      ) : (
        pending.length === 0 && <Text dimColor>No open suggestions.</Text>
      )}
      {pending.map(s => suggestionBox(ctx, mr, open, s))}
      {resolved.length > 0 && (
        <Box>
          <Button
            key="mr:resolved"
            label={mr.showResolved ? 'Hide resolved' : `Show ${resolved.length} resolved`}
            onPress={w.press(() => a.toggleMrResolved())}
          />
        </Box>
      )}
      {mr.showResolved && resolved.map(s => suggestionBox(ctx, mr, open, s))}
    </Box>
  )
}

function detail(ctx: TabContext, mr: MrView) {
  const { w } = ctx
  const { Box, Text } = w
  const open = mr.open

  return (
    <Box flexDirection="column" gap={1}>
      {toolbar(ctx, open)}
      {mr.actionError !== '' && <Text color="error">{mr.actionError}</Text>}
      {mr.detailError !== '' && <Text color="error">{mr.detailError}</Text>}
      {open === null ? (
        mr.detailError === '' && <Text dimColor>Loading…</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {heading(ctx, open)}
          {decision(ctx, mr, open)}
          <Box key="mr:div:suggestions">{w.divider}</Box>
          {suggestions(ctx, mr, open)}
        </Box>
      )}
    </Box>
  )
}
