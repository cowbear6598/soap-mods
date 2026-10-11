import type { CommitFile, GitCommit, LogView } from '../../../types'
import { formatAgo, letterKind, logBranch, searchWords } from '../../git/parse'
import type { TabBody, TabContext } from './context'

// log 分頁：點開了 commit 就畫它改了哪些檔案，否則畫 commit 列表。
export const logTab: TabBody = ctx => {
  const lg = ctx.d.log

  return lg.commit === null ? commitList(ctx, lg) : commitFiles(ctx, lg, lg.commit)
}

// 點開的 commit：最上面 ← Back，下面是它改了哪些檔案，點了在 diff 面板看差異。
function commitFiles({ w, d, a }: TabContext, lg: LogView, c: GitCommit) {
  const { Box, Text } = w
  const { now } = d
  const commitFileRow = (f: CommitFile) =>
    w.pathRow(`commit-file:${f.path}`, f.path, f.letter, letterKind(f.letter), () => a.openCommitDiff(c, f))

  return (
    <Box flexDirection="column" gap={1}>
      {w.pressRow({ key: 'log:back', label: '← Back', isDim: true, isBold: true, indent: 0, onPress: () => a.closeCommit() })}
      <Box flexDirection="column">
        <Text bold>{c.subject}</Text>
        <Text dimColor>
          {[c.shortSha, c.author, formatAgo(c.time, now), c.parents.length > 1 ? 'merge, vs first parent' : '']
            .filter(s => s !== '')
            .join(' · ')}
        </Text>
      </Box>
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

// 一筆 commit 一列：短 sha、subject、作者 · 多久前；還沒 push 的在 sha 前面標黃色 ↑（落在縮排的空位裡）。
function commitList({ w, d, a }: TabContext, lg: LogView) {
  const { Box, Button, Text } = w
  const { now, view: v, logQuery: query } = d
  const unpushed = new Set(lg.unpushed)
  const commitRow = (c: GitCommit) => {
    const isUnpushed = unpushed.has(c.sha)

    return w.pressRow({
      key: `commit:${c.sha}`,
      label: c.subject,
      isTruncated: true,
      indent: isUnpushed ? 0 : undefined,
      lead: [
        isUnpushed && (
          <Text key={`commit:${c.sha}:unpushed`} color="warning">
            ↑
          </Text>
        ),
        <Text key={`commit:${c.sha}:sha`} color="suggestion">
          {c.shortSha}
        </Text>,
      ],
      rest: (
        <Box flexShrink={0}>
          <Text dimColor>{`${c.author} · ${formatAgo(c.time, now)}`}</Text>
        </Box>
      ),
      onPress: () => a.openCommit(c),
    })
  }

  // 搜尋時標題的數字是符合的筆數（超過列出的就加 +）。
  const isSearching = searchWords(query).length > 0

  return (
    <Box flexDirection="column" gap={1}>
      {lg.error !== '' && <Text color="error">{lg.error}</Text>}
      {w.searchField('log:search', query, text => a.searchLog(text), () => a.searchLog(''))}
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
