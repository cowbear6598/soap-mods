// Git 的 CI 子分頁（GitLab）：分支清單 → 點分支看它的 pipeline → 點開看它的 job（照 stage 分組）→ 點 job 看 log。
// 一層一層蓋過去，← Back 回上一層；跟 log 分頁點開 commit 一樣。
// pipeline 那層能 Retry 失敗的 job，每個 job 旁邊（和它的 log 裡）能 Run manual job、Retry 跑完的；都要按兩次。
// 分支清單最上面有搜尋框（分支名稱），This branch 直接打開目前的分支。
// 這台 GitLab 還沒存 token 時只畫貼 token 的框；存了之後 Refresh 左邊的 Change token 換一組。

import type { RenderChildren } from 'claude-code'

import type { CiBranch, CiJob, CiPipeline, CiView } from '../../../types'
import { CI_PAGE, CI_RECENT, LOG_AGO_WIDTH } from '../../config'
import { JOBS_LIMIT, formatDuration, stageGroups, statusStyle } from '../../ci/parse'
import { formatAgo } from '../../git/parse'
import { hasQuery } from '../../search'
import { isProd } from '../../text'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// 能 Retry 的：pipeline 重跑失敗、取消的 job（全成功的 GitLab 不重跑）；job 跑完了的都能重跑。
const PIPELINE_RETRY_STATUS = new Set(['failed', 'canceled'])
const JOB_RETRY_STATUS = new Set(['failed', 'canceled', 'success'])


// pipeline 編號那欄的寬度（「#20653」再留一格）；sha 那欄（8 個字再留一格）。
const IID_WIDTH = 8
const SHA_WIDTH = 9

export const ciTab: TabBody = ctx => {
  const { Box } = ctx.w
  const ci = ctx.d.ci
  if (ci.isLoaded && ci.host !== '' && !ci.hasToken) return tokenForm(ctx, ci)
  const shown = level(ctx, ci)

  // 換 token（按了 Change token，或存著的被 GitLab 拒絕）：框畫在最上面，底下照常。
  return ci.isTokenOpen ? (
    <Box flexDirection="column" gap={1}>
      {tokenForm(ctx, ci)}
      {shown}
    </Box>
  ) : (
    shown
  )
}

// 看得到的那層：點開的 job 的 log、pipeline 的 job、分支的 pipeline，都沒點開是分支清單。
function level(ctx: TabContext, ci: CiView) {
  if (ci.job !== null) return jobLog(ctx, ci, ci.job)
  if (ci.open !== null) return pipelineJobs(ctx, ci, ci.open)
  if (ci.ref !== null) return refPipelines(ctx, ci, ci.ref)

  return branchList(ctx, ci)
}

// 貼 token 的框：Enter 或 Save 先問 GitLab 能不能用，能用才存。已經有 token 時多一顆 Cancel。
function tokenForm({ w, d, a }: TabContext, ci: CiView) {
  const { Box, Button, Text } = w

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{ci.hasToken ? `Change the GitLab token for ${ci.host}` : `Connect ${ci.host}`}</Text>
      {d.ciSaving ? (
        <Text dimColor>Checking…</Text>
      ) : (
        <Box gap={1} alignItems="center" flexWrap="wrap">
          {w.field('ci:token', { placeholder: 'Paste the token', value: '', submitLabel: 'Save', onSubmit: text => a.saveCiToken(text) })}
          {ci.hasToken && <Button key="ci:token:cancel" label="Cancel" onPress={w.press(() => a.toggleCiToken(false))} />}
        </Box>
      )}
      {ci.tokenError !== '' && <Text color="error">{ci.tokenError}</Text>}
    </Box>
  )
}

// 沒有 pipeline（搜尋找到、最近沒跑的分支）是淡淡的 ·。
const statusMark = ({ w }: TabContext, key: string, status: string | null) => {
  if (status === null) return w.cell(key, '·', 2, { isDim: true })
  const s = statusStyle(status)

  return w.cell(key, s.mark, 2, { color: s.theme })
}

const refreshButton = ({ w, a }: TabContext) => w.iconButton('ci:refresh', 'restart', 'Refresh', false, () => a.refreshCi())

const actButton = ({ w, d }: TabContext, ci: CiView, key: string, armed: string, label: string, action: () => unknown, prod = false) =>
  w.confirmButton(key, label, { isArmed: d.armed === `ci:${armed}`, isBusy: d.ciActing, isProd: prod }, action)

// job 列的 hover 群組：指到右邊的 Run、Retry 時，同一列的名稱跟著亮，看得出按的是哪個 job。
const jobScope = (j: CiJob) => `ci-job-${j.id}`

// 一個 job 能按的：manual 是 Run，跑完了是 Retry；key 前綴分開 job 清單的列和 log 裡的。
const jobButton = (ctx: TabContext, ci: CiView, key: string, j: CiJob) => {
  const prod = isProd(j.name, ci.open?.ref ?? '')
  if (j.status === 'manual') return actButton(ctx, ci, `${key}:run`, `play:job:${j.id}`, 'Run', () => ctx.a.actOnCiJob(j, 'play'), prod)
  if (JOB_RETRY_STATUS.has(j.status)) return actButton(ctx, ci, `${key}:retry`, `retry:job:${j.id}`, 'Retry', () => ctx.a.actOnCiJob(j, 'retry'), prod)

  return undefined
}

const toolbar = (ctx: TabContext, back: RenderChildren, buttons: RenderChildren[]) => {
  const { Box } = ctx.w

  return (
    <Box justifyContent="space-between" alignItems="center">
      {back}
      <Box gap={1} alignItems="center">
        {buttons}
        {refreshButton(ctx)}
      </Box>
    </Box>
  )
}

const actionError = ({ w }: TabContext, ci: CiView) => ci.actionError !== '' && <w.Text color="error">{ci.actionError}</w.Text>

// 第一層：最近跑過 pipeline 的分支，每個帶最新那條的狀態和多久前。整份讀好，這裡切頁。
function branchList(ctx: TabContext, ci: CiView) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const isSearching = hasQuery(ci.query)
  const from = ci.page * CI_PAGE
  const shown = ci.branches.slice(from, from + CI_PAGE)
  // This branch：Git 分頁讀到的目前分支（detached HEAD、還沒讀到時沒有）。
  const current = d.view.branches.find(b => b.isCurrent && !b.isRemote)?.name ?? ''
  const row = (b: CiBranch) =>
    w.pressRow({
      key: `ci:ref:${b.name}`,
      label: b.name,
      isTruncated: true,
      indent: 0,
      isWholePressable: true,
      lead: statusMark(ctx, `ci:ref:${b.name}:status`, b.pipeline?.status ?? null),
      rest: w.cell(`ci:ref:${b.name}:ago`, b.pipeline === null ? '' : formatAgo(b.pipeline.time, d.now), LOG_AGO_WIDTH, { isDim: true, isEnd: true }),
      onPress: () => a.openCiRef(b.name),
    })

  return (
    <Box flexDirection="column" gap={1}>
      {w.searchField('ci:search', ci.query, text => a.searchCi(text))}
      <Box gap={1} alignItems="center" justifyContent="space-between">
        <Box>{current !== '' && <Button key="ci:current" label="This branch" onPress={w.press(() => a.openCiRef(current))} />}</Box>
        <Box gap={1} alignItems="center">
          {ci.hasToken && !ci.isTokenOpen && <Button key="ci:token:change" label="Change token" onPress={w.press(() => a.toggleCiToken(true))} />}
          {refreshButton(ctx)}
        </Box>
      </Box>
      {ci.error !== '' && <Text color="error">{ci.error}</Text>}
      {!ci.isLoaded ? (
        <Text dimColor>Loading…</Text>
      ) : (
        ci.error === '' && (
          <Box flexDirection="column">
            <Text bold dimColor>{`${isSearching ? 'Matching branches' : 'Recent branches'} · ${ci.branches.length}`}</Text>
            {ci.branches.length === 0 && (
              <Box paddingLeft={2}>
                <Text dimColor>{isSearching ? 'No matching branches.' : 'No pipelines yet.'}</Text>
              </Box>
            )}
            {shown.map(row)}
          </Box>
        )
      )}
      {ci.isLoaded && !isSearching && <Text dimColor>{`Branches from the newest ${CI_RECENT} pipelines; search to find older ones.`}</Text>}
      {ci.isLoaded && w.pager('ci', { page: ci.page, from, count: shown.length, hasNext: ci.branches.length > from + CI_PAGE }, p => a.showCiPage(p))}
    </Box>
  )
}

// 第二層：一個分支的 pipeline，最新的先；每條寫 commit 的 sha 和標題。
function refPipelines(ctx: TabContext, ci: CiView, ref: string) {
  const { w, d, a } = ctx
  const { Box, Text } = w
  const row = (p: CiPipeline) =>
    w.pressRow({
      key: `ci:pipeline:${p.id}`,
      label: p.title === '' ? p.source : p.title,
      isTruncated: true,
      indent: 0,
      isWholePressable: true,
      lead: [
        statusMark(ctx, `ci:pipeline:${p.id}:status`, p.status),
        w.cell(`ci:pipeline:${p.id}:iid`, `#${p.iid}`, IID_WIDTH, { color: 'suggestion' }),
        w.cell(`ci:pipeline:${p.id}:sha`, p.shortSha, SHA_WIDTH, { isDim: true }),
      ],
      rest: w.cell(`ci:pipeline:${p.id}:ago`, formatAgo(p.time, d.now), LOG_AGO_WIDTH, { isDim: true, isEnd: true }),
      onPress: () => a.openPipeline(p),
    })

  return (
    <Box flexDirection="column" gap={1}>
      {toolbar(ctx, backButton(w, w.press, 'ci-ref', () => a.closeCiRef()), [])}
      <Text bold wrap="truncate-end">
        {ref}
      </Text>
      {ci.pipelinesError !== '' && <Text color="error">{ci.pipelinesError}</Text>}
      {ci.pipelines === null ? (
        <Text dimColor>Loading…</Text>
      ) : ci.pipelines.length === 0 ? (
        ci.pipelinesError === '' && <Text dimColor>No pipelines on this branch.</Text>
      ) : (
        <Box flexDirection="column">{ci.pipelines.map(row)}</Box>
      )}
      {ci.pipelines !== null && w.pager('ci', { page: ci.pipelinePage, from: ci.pipelinePage * CI_PAGE, count: ci.pipelines.length, hasNext: ci.hasNext }, p => a.showCiPage(p))}
    </Box>
  )
}

// pipeline 的標題：#編號 · 狀態，下一行 commit 標題，再下一行分支 · sha · 怎麼開始的 · 多久前。
function pipelineHeading({ w, d }: TabContext, p: CiPipeline) {
  const { Box, Text } = w
  const s = statusStyle(p.status)

  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>{`#${p.iid}`}</Text>
        <Text color={s.theme}>{`${s.mark} ${p.status}`}</Text>
      </Box>
      {p.title !== '' && <Text wrap="truncate-end">{p.title}</Text>}
      <Text dimColor wrap="truncate-end">
        {[p.ref, p.shortSha, p.source, formatAgo(p.time, d.now)].filter(t => t !== '').join(' · ')}
      </Text>
    </Box>
  )
}

// job 右邊寫的：跑過的寫多久，沒跑的（manual、skipped、pending）寫狀態；允許失敗的失敗加註。
const jobNote = (j: CiJob) =>
  [j.duration === null ? j.status : formatDuration(j.duration), j.status === 'failed' && j.allowFailure ? 'allowed' : ''].filter(t => t !== '').join(' · ')

function pipelineJobs(ctx: TabContext, ci: CiView, p: CiPipeline) {
  const { w, a } = ctx
  const { Box, Text } = w
  const row = (j: CiJob) =>
    w.pressRow({
      key: `ci:job:${j.id}`,
      label: j.name,
      isTruncated: true,
      indent: 0,
      isWholePressable: true,
      lead: statusMark(ctx, `ci:job:${j.id}:status`, j.status),
      rest: <Text key={`ci:job:${j.id}:note`} dimColor>{jobNote(j)}</Text>,
      trailing: <w.Box hover={{ scope: jobScope(j) }}>{jobButton(ctx, ci, `ci:job:${j.id}`, j)}</w.Box>,
      labelHover: { scope: jobScope(j), color: 'suggestion', bold: true },
      onPress: () => a.openCiJob(j),
    })

  return (
    <Box flexDirection="column" gap={1}>
      {toolbar(ctx, backButton(w, w.press, 'ci-pipeline', () => a.closeCiPipeline()), [
        PIPELINE_RETRY_STATUS.has(p.status) && actButton(ctx, ci, 'ci:retry', `retry:pipeline:${p.id}`, 'Retry', () => a.retryCiPipeline(), isProd(p.ref)),
      ])}
      {actionError(ctx, ci)}
      {pipelineHeading(ctx, p)}
      {ci.jobsError !== '' && <Text color="error">{ci.jobsError}</Text>}
      {ci.jobs === null ? (
        <Text dimColor>Loading…</Text>
      ) : ci.jobs.length === 0 ? (
        ci.jobsError === '' && <Text dimColor>No jobs.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {stageGroups(ci.jobs).map(g => (
            <Box key={`ci:stage:${g.stage}`} flexDirection="column">
              <Text bold dimColor>{g.stage}</Text>
              {g.jobs.map(row)}
            </Box>
          ))}
          {ci.jobs.length >= JOBS_LIMIT && <Text dimColor>{`Showing the first ${JOBS_LIMIT} jobs.`}</Text>}
        </Box>
      )}
    </Box>
  )
}

function jobLog(ctx: TabContext, ci: CiView, j: CiJob) {
  const { w, a } = ctx
  const { Box, Code, Text } = w
  const s = statusStyle(j.status)

  return (
    <Box flexDirection="column" gap={1}>
      {toolbar(ctx, backButton(w, w.press, 'ci-job', () => a.closeCiJob()), [jobButton(ctx, ci, 'ci', j)])}
      {actionError(ctx, ci)}
      <Box flexDirection="column">
        <Text bold>{j.name}</Text>
        <Box>
          <Text color={s.theme}>{`${s.mark} ${j.status}`}</Text>
          <Text dimColor>{` · ${j.stage}${j.duration === null ? '' : ` · ${formatDuration(j.duration)}`}`}</Text>
        </Box>
      </Box>
      {ci.traceError !== '' && <Text color="error">{ci.traceError}</Text>}
      {ci.isTraceTruncated && <Text dimColor>Log is too long; showing only the end.</Text>}
      {ci.trace === null ? (
        <Text dimColor>Loading…</Text>
      ) : ci.trace === '' ? (
        ci.traceError === '' && <Text dimColor>No log yet.</Text>
      ) : (
        <Code source={ci.trace} />
      )}
    </Box>
  )
}
