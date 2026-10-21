import type { MrDetail, MrItem, MrSuggestion } from '../../types'
import { MR_LIST_LIMIT } from '../config'
import { type GitLabProject, projectUrl } from '../ci/parse'
import { isObject, list, num, obj, parseArray, parseObject, seconds, str } from '../json'

export const mrUrl = (p: GitLabProject, iid: number) => `${projectUrl(p)}/merge_requests/${iid}`

// 開著、Reviewer 有指派 user（token 本人）的。
export const mrListUrl = (p: GitLabProject, user: string) =>
  `${projectUrl(p)}/merge_requests?state=opened&reviewer_username=${encodeURIComponent(user)}&order_by=updated_at&per_page=${MR_LIST_LIMIT}`
export const approvalsUrl = (p: GitLabProject, iid: number) => `${mrUrl(p, iid)}/approvals`
// 一個 MR 最多讀 100 串討論（GitLab 一頁的上限）。
const DISCUSSIONS_LIMIT = 100
export const discussionsUrl = (p: GitLabProject, iid: number) => `${mrUrl(p, iid)}/discussions?per_page=${DISCUSSIONS_LIMIT}`
export const approveUrl = (p: GitLabProject, iid: number, isApprove: boolean) => `${mrUrl(p, iid)}/${isApprove ? 'approve' : 'unapprove'}`
export const mergeUrl = (p: GitLabProject, iid: number) => `${mrUrl(p, iid)}/merge`
export const resolveUrl = (p: GitLabProject, iid: number, discussion: string) => `${mrUrl(p, iid)}/discussions/${encodeURIComponent(discussion)}?resolved=true`
export const rawFileUrl = (p: GitLabProject, path: string, ref: string) => `${projectUrl(p)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`
export const branchUrl = (p: GitLabProject, name: string) => `${projectUrl(p)}/repository/branches/${encodeURIComponent(name)}`
export const commitUrl = (p: GitLabProject) => `${projectUrl(p)}/repository/commits`

export const parseReviewList = (out: string): MrItem[] =>
  parseArray(out).map(m => ({
    iid: num(m.iid),
    title: str(m.title),
    isDraft: m.draft === true || m.work_in_progress === true,
    time: seconds(m.updated_at),
  }))

type Approvals = Pick<MrDetail, 'approvedBy' | 'approvalsLeft' | 'hasApproved' | 'canApprove'>

export function parseApprovals(out: string): Approvals {
  const a = parseObject(out, 'the approvals')

  return {
    approvedBy: list(a.approved_by).map(x => str(obj(x.user).name) || str(obj(x.user).username)).filter(n => n !== ''),
    approvalsLeft: num(a.approvals_left),
    hasApproved: a.user_has_approved === true,
    canApprove: a.user_can_approve === true,
  }
}

export function parseDetail(out: string, approvals: Approvals): MrDetail {
  const m = parseObject(out, 'a merge request')
  const pipeline = isObject(m.head_pipeline) ? m.head_pipeline : isObject(m.pipeline) ? m.pipeline : null

  return {
    iid: num(m.iid),
    title: str(m.title),
    state: str(m.state),
    source: str(m.source_branch),
    target: str(m.target_branch),
    author: str(obj(m.author).name),
    webUrl: str(m.web_url),
    sha: str(m.sha),
    mergeStatus: str(m.detailed_merge_status) || str(m.merge_status),
    hasConflicts: m.has_conflicts === true || str(m.detailed_merge_status) === 'conflict',
    pipeline: pipeline === null ? null : { iid: num(pipeline.iid), status: str(pipeline.status), shortSha: str(pipeline.sha).slice(0, 8) },
    mergedBy: str(obj(m.merged_by).name),
    mergedAt: seconds(m.merged_at),
    mergeCommit: str(m.merge_commit_sha).slice(0, 8),
    ...approvals,
  }
}

export const parseBranchHead = (out: string) => str(obj(parseObject(out, 'a branch').commit).id)

// 為什麼還不能 merge（GitLab 的 detailed_merge_status）；能 merge 是 ''。
const MERGE_BLOCKED: Record<string, string> = {
  not_approved: 'needs approval',
  ci_must_pass: 'the pipeline must pass',
  ci_still_running: 'the pipeline is still running',
  discussions_not_resolved: 'threads are not resolved',
  draft_status: 'it is a draft',
  conflict: 'it has conflicts',
  need_rebase: 'it needs a rebase',
  not_open: 'it is not open',
  blocked_status: 'another merge request blocks it',
  requested_changes: 'a reviewer requested changes',
  checking: 'GitLab is still checking it',
  unchecked: 'GitLab is still checking it',
  preparing: 'GitLab is still checking it',
  approvals_syncing: 'GitLab is still checking it',
}

export const mergeBlocked = (status: string) => (status === 'mergeable' ? '' : (MERGE_BLOCKED[status] ?? status.replace(/_/g, ' ')))

type Block = { above: number; below: number; lines: string[] }

// 一則留言裡的 ```suggestion 區塊：```suggestion:-上幾行+下幾行（沒寫是 -0+0），到單獨一行 ``` 結束。
// 其餘的字是留言本身。
function splitSuggestions(body: string): { comment: string; blocks: Block[] } {
  const rest: string[] = []
  const blocks: Block[] = []
  let open: Block | undefined
  for (const line of body.replace(/\r\n/g, '\n').split('\n')) {
    if (open !== undefined) {
      if (line.trim() === '```') {
        blocks.push(open)
        open = undefined
      } else {
        open.lines.push(line)
      }
      continue
    }
    const start = /^\s*```suggestion(?::-(\d+)\+(\d+))?\s*$/.exec(line)
    if (start === null) rest.push(line)
    else open = { above: Number(start[1] ?? 0), below: Number(start[2] ?? 0), lines: [] }
  }

  return { comment: rest.join('\n').trim(), blocks }
}

// 每串討論的第一則：在新檔案某一行上、帶 ```suggestion 的是建議。
export function parseSuggestions(out: string, webUrl: string): MrSuggestion[] {
  const found: MrSuggestion[] = []
  for (const d of parseArray(out)) {
    const note = list(d.notes)[0]
    if (note === undefined || note.system === true) continue
    const position = obj(note.position)
    const line = num(position.new_line)
    const path = str(position.new_path)
    const { comment, blocks } = splitSuggestions(str(note.body))
    const first = blocks[0]
    if (first === undefined || line === 0 || path === '') continue
    found.push({
      discussion: str(d.id),
      note: num(note.id),
      author: str(obj(note.author).name),
      time: seconds(note.created_at),
      path,
      line,
      from: line - first.above,
      to: line + first.below,
      comment,
      lines: first.lines,
      old: null,
      sha: str(position.head_sha),
      isResolved: note.resolved === true,
      isSingle: blocks.length === 1,
      webUrl: webUrl === '' ? '' : `${webUrl}#note_${num(note.id)}`,
    })
  }

  return found.sort((a, b) => a.time - b.time)
}

// 檔案切成行：記得原本的換行是 \r\n 還是 \n，組回去時照用。
export function fileLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'

  return { lines: text.split(eol), eol }
}

export const lineRange = (lines: readonly string[], from: number, to: number) => lines.slice(from - 1, to)

// 把 from..to 換成 replacement；那幾行已經不是 expected（建議之後又被改過）、超出檔案就是 null，不套。
export function applyLines(text: string, from: number, to: number, expected: readonly string[], replacement: readonly string[]): string | null {
  const { lines, eol } = fileLines(text)
  if (from < 1 || to < from - 1 || to > lines.length) return null
  const current = lineRange(lines, from, to)
  if (current.length !== expected.length || current.some((l, i) => l !== expected[i])) return null

  return [...lines.slice(0, from - 1), ...replacement, ...lines.slice(to)].join(eol)
}

// 給 w.diff 畫（改到的字反白）。
export function suggestionDiff(s: Pick<MrSuggestion, 'from' | 'lines' | 'old'>): string {
  const old = s.old ?? []

  return [`@@ -${s.from},${old.length} +${s.from},${s.lines.length} @@`, ...old.map(l => `-${l}`), ...s.lines.map(l => `+${l}`)].join('\n')
}
