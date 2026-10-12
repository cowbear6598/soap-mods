import type { CommitFile, GitCommit, LogView } from '../../../types'
import { LOG_AGO_WIDTH, LOG_AUTHOR_WIDTH, LOG_SHA_WIDTH } from '../../config'
import { commitsLabel, formatAgo, letterKind, logBranch, searchWords } from '../../git/parse'
import type { TabBody, TabContext } from './context'

// log 分頁：點開了 commit 就畫它們改了哪些檔案，否則畫 commit 列表。
export const logTab: TabBody = ctx => {
  const lg = ctx.d.log

  return lg.opened.length === 0 ? commitList(ctx, lg) : commitFiles(ctx, lg, lg.opened)
}

// 點開的 commit：最上面 ← Back，下面是它們改了哪些檔案，點了在 diff 面板看差異。
// 選範圍打開的是合起來的結果（最舊那筆之前 → 最新那筆）：標題只寫筆數和頭尾的 sha；
// 搜尋中選的範圍，夾在中間沒列出來的 commit 也算進去，會提示。
function commitFiles({ w, d, a }: TabContext, lg: LogView, opened: GitCommit[]) {
  const { Box, Text } = w
  const { now } = d
  const commitFileRow = (f: CommitFile, _: number, files: CommitFile[]) =>
    w.pathRow(`commit-file:${f.path}`, f.path, f.letter, letterKind(f.letter), () => a.openCommitDiff(opened, f, files))
  const [c] = opened
  if (c === undefined) return null
  const isSearching = searchWords(d.logQuery).length > 0

  const heading =
    opened.length === 1 ? (
      <Box flexDirection="column">
        <Text bold>{c.subject}</Text>
        <Text dimColor>
          {[c.shortSha, c.author, formatAgo(c.time, now), c.parents.length > 1 ? 'merge, vs first parent' : '']
            .filter(s => s !== '')
            .join(' · ')}
        </Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text bold>{`${opened.length} commits · ${commitsLabel(opened)}`}</Text>
        {isSearching && <Text color="warning">Also includes the commits in between that the search hides.</Text>}
      </Box>
    )

  return (
    <Box flexDirection="column" gap={1}>
      {w.pressRow({ key: 'log:back', label: '← Back', isDim: true, isBold: true, indent: 0, onPress: () => a.closeCommit() })}
      {heading}
      {lg.commitError !== '' && <Text color="error">{lg.commitError}</Text>}
      {lg.files === null ? (
        <Text dimColor>Loading…</Text>
      ) : lg.files.length === 0 ? (
        lg.commitError === '' && <Text dimColor>No files changed.</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold dimColor>{`Files · ${lg.files.length}`}</Text>
          {lg.files.map(commitFileRow)}
        </Box>
      )}
    </Box>
  )
}

// 一筆 commit 一列：短 sha、作者、subject、多久前；作者和時間固定寬，subject 吃掉剩下的寬度、太長截斷，
// 一欄一欄對齊（桌面版字寬不一，每欄都是固定寬的 Box）。還沒 push 的在 sha 前面標黃色 ↑（落在縮排那一格裡）。
// 搜尋框右邊的 Select range：按了之後點一筆當起點（綠色粗體，再點一次取消）、再點一筆當終點，兩筆之間（含）一起打開。
function commitList({ w, d, a }: TabContext, lg: LogView) {
  const { Box, Button, Text } = w
  const { now, view: v, logQuery: query } = d
  const unpushed = new Set(lg.unpushed)
  const commitRow = (c: GitCommit) => {
    const isUnpushed = unpushed.has(c.sha)
    const isStart = lg.rangeStart === c.sha

    return w.pressRow({
      key: `commit:${c.sha}`,
      label: c.subject,
      isTruncated: true,
      isBold: isStart,
      color: isStart ? 'success' : undefined,
      indent: 0,
      lead: [
        <Box key={`commit:${c.sha}:unpushed`} width={1} flexShrink={0}>
          {isUnpushed && <Text color="warning">↑</Text>}
        </Box>,
        <Box key={`commit:${c.sha}:sha`} width={LOG_SHA_WIDTH} flexShrink={0}>
          <Text color="suggestion">{c.shortSha}</Text>
        </Box>,
        <Box key={`commit:${c.sha}:author`} width={LOG_AUTHOR_WIDTH} flexShrink={0} overflow="hidden">
          <Text dimColor wrap="truncate-end">
            {c.author}
          </Text>
        </Box>,
      ],
      rest: (
        <Box width={LOG_AGO_WIDTH} flexShrink={0} justifyContent="flex-end">
          <Text dimColor>{formatAgo(c.time, now)}</Text>
        </Box>
      ),
      onPress: lg.isPicking ? () => a.pickRange(c) : () => a.openCommit(c),
    })
  }

  // 搜尋時標題的數字是符合的筆數（超過列出的就加 +）。
  const isSearching = searchWords(query).length > 0
  const rangeButton = (
    <Button
      key="log:range"
      label={lg.isPicking ? 'Cancel' : 'Select range'}
      variant={lg.isPicking ? 'primary' : 'secondary'}
      onPress={w.press(() => a.toggleRangePick())}
    />
  )

  return (
    <Box flexDirection="column" gap={1}>
      {lg.error !== '' && <Text color="error">{lg.error}</Text>}
      {w.searchField('log:search', query, text => a.searchLog(text), () => a.searchLog(''), rangeButton)}
      {lg.isPicking && (
        <Text color="suggestion">{lg.rangeStart === '' ? 'Press the first commit of the range.' : 'Press the other end of the range.'}</Text>
      )}
      {!lg.isLoaded ? (
        <Text dimColor>Loading…</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold dimColor>{`${logBranch(v, lg)?.name ?? 'HEAD (detached)'} · ${lg.commits.length}${lg.hasMore ? '+' : ''}`}</Text>
          {lg.commits.length === 0 && lg.error === '' && (
            <Box paddingLeft={2}>
              <Text dimColor>{isSearching ? 'No matching commits.' : 'No commits yet.'}</Text>
            </Box>
          )}
          {lg.commits.map(commitRow)}
        </Box>
      )}
      {isSearching && lg.isTruncated && <Text dimColor>History is too long; searched only the newest commits.</Text>}
      {lg.hasMore && <Button key="log:more" label="Load more" onPress={w.press(() => a.loadMoreLog())} />}
    </Box>
  )
}
