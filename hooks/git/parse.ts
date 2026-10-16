import type { CommitFile, FileKind, GitBranch, GitCommit, GitFile, GitView, LogView } from '../../types'
import { cutAtLineEnd } from '../text'
import { filterWords } from '../search'

/** `git status --porcelain=v1 -b -z` output → changed files; the `## branch` line is skipped. */
export function parseStatus(out: string): GitFile[] {
  const parts = out.split('\0')
  const files: GitFile[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry === undefined || entry === '' || entry.startsWith('## ')) continue

    const x = entry[0] ?? ' '
    const y = entry[1] ?? ' '
    files.push({ path: entry.slice(3), x, y })

    // A rename or copy is followed by its source path as an entry of its own.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1
  }

  return files
}

/** Keep what `Code format="diff"` reads: from the first hunk header on. */
export function toHunks(diff: string): { source: string; isTruncated: boolean } {
  const start = diff.indexOf('@@')
  const { text, isTruncated } = cutAtLineEnd(start === -1 ? '' : diff.slice(start))

  return { source: text, isTruncated }
}

// 只要 ref 本身的欄位：不拿 commit 的日期、subject，git 就不用每次 refresh 都去讀上千個 commit。
export const BRANCH_FORMAT = ['%(HEAD)', '%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track)'].join('%09')

// 分支上千個時每次 refresh 都要排；共用一個 Collator 比每次 localeCompare 快很多，順序一樣。
const byName = new Intl.Collator().compare

/** `git for-each-ref --format=BRANCH_FORMAT` output → branches, current first. */
export function parseBranches(out: string): GitBranch[] {
  const branches: GitBranch[] = []

  for (const line of out.split('\n')) {
    if (line === '') continue
    const [head = '', ref = '', name = '', upstream = '', track = ''] = line.split('\t')
    // `origin/HEAD` is a pointer, not a branch.
    if (ref.endsWith('/HEAD')) continue

    branches.push({
      name,
      isCurrent: head === '*',
      isRemote: ref.startsWith('refs/remotes/'),
      upstream,
      track,
    })
  }

  return branches.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1

    return byName(a.name, b.name)
  })
}

/** Whether a path can go into a prompt as is: no backtick, line break or other control character to smuggle text in. */
export const isPromptSafePath = (path: string) => !/[`\u0000-\u001f\u007f]/.test(path)

/** A branch's full ref: a local and a remote branch can share a name. */
export const branchRef = (b: GitBranch) => `refs/${b.isRemote ? 'remotes' : 'heads'}/${b.name}`

/** The branch the log tab shows: the one picked with its log button, else (none picked, or gone) the current one; none when detached. */
export function logBranch(v: GitView, l: LogView): GitBranch | undefined {
  return v.branches.find(b => l.ref !== '' && branchRef(b) === l.ref) ?? v.branches.find(b => b.isCurrent)
}

/** Branches whose name holds every word of `query`, ignoring case; all of them when it is blank. */
export function filterBranches(branches: GitBranch[], query: string): GitBranch[] {
  return filterWords(branches, query, b => b.name)
}

/** What happened to a file as a whole: the diff view header. */
export function fileKind(file: GitFile): FileKind {
  if (isConflict(file)) return 'conflict'

  return letterKind(file.x === ' ' ? file.y : file.x)
}

export type FileGroupId = 'staged' | 'unstaged' | 'untracked'

export type FileEntry = {
  file: GitFile
  /** The one status letter that belongs to this group (X for staged, Y for unstaged). */
  letter: string
  kind: FileKind
}

/** Unmerged: both sides changed the file and git left it for the person. */
export function isConflict(file: GitFile): boolean {
  return file.x === 'U' || file.y === 'U' || (file.x === 'A' && file.y === 'A') || (file.x === 'D' && file.y === 'D')
}

/** Whether the diff tab's trash can take back a file's changes: not a conflict, nor a rename or copy (its source path is not kept). */
export const canDiscard = (file: GitFile) => !isConflict(file) && letterKind(file.x) !== 'renamed' && letterKind(file.y) !== 'renamed'

export function letterKind(letter: string): FileKind {
  if (letter === 'A' || letter === '?') return 'added'
  if (letter === 'D') return 'deleted'
  if (letter === 'R' || letter === 'C') return 'renamed'

  return 'modified'
}

/** Order within a group: conflicts first, then added, modified, renamed, deleted. */
const KIND_ORDER: Record<FileKind, number> = { conflict: 0, added: 1, modified: 2, renamed: 3, deleted: 4 }

/**
 * Files as the source control view groups them: staged (X), unstaged (Y) and
 * untracked. A file changed on both sides is listed in both groups; a
 * conflicted file is listed once, under unstaged. Each group is sorted by
 * kind, keeping git's path order within a kind.
 */
export function groupFiles(files: GitFile[]): Record<FileGroupId, FileEntry[]> {
  const groups: Record<FileGroupId, FileEntry[]> = { staged: [], unstaged: [], untracked: [] }

  for (const file of files) {
    if (file.x === '?') {
      groups.untracked.push({ file, letter: 'U', kind: 'added' })
      continue
    }
    if (isConflict(file)) {
      groups.unstaged.push({ file, letter: '!', kind: 'conflict' })
      continue
    }
    if (file.x !== ' ') groups.staged.push({ file, letter: file.x, kind: letterKind(file.x) })
    if (file.y !== ' ') groups.unstaged.push({ file, letter: file.y, kind: letterKind(file.y) })
  }
  for (const entries of Object.values(groups)) entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])

  return groups
}

/**
 * What the diff view's Previous / Next step through for a work tree file: the
 * diff tab's rows in order, a file listed in two groups once, and no conflicts
 * (they open in the merge view).
 */
export function diffSteps(files: GitFile[]): CommitFile[] {
  const seen = new Set<string>()

  return Object.values(groupFiles(files))
    .flat()
    .filter(e => e.kind !== 'conflict' && !seen.has(e.file.path) && seen.add(e.file.path))
    .map(e => ({ path: e.file.path, oldPath: '', letter: e.letter }))
}

/** `dir/sub/name.ts` → `{ name: 'name.ts', dir: 'dir/sub' }`. */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')

  return slash === -1 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

export const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%at', '%s'].join('%x09')

/** `git log --format=LOG_FORMAT` output → commits, newest first. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = []

  for (const line of out.split('\n')) {
    if (line === '') continue
    const [sha = '', shortSha = '', parents = '', author = '', time = '', ...subject] = line.split('\t')

    commits.push({
      sha,
      shortSha,
      parents: parents.split(' ').filter(p => p !== ''),
      author,
      time: Number(time),
      subject: subject.join('\t'),
    })
  }

  return commits
}

/** Commits whose subject, author or sha holds every word of `query`, ignoring case; all of them when it is blank. */
export function filterCommits(commits: GitCommit[], query: string): GitCommit[] {
  return filterWords(commits, query, c => `${c.subject}\n${c.author}\n${c.sha}`)
}

/** git's empty tree: what a root commit is compared with when it is the oldest of several. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/**
 * What commits (newest first) are compared with, as one change: the oldest one's first parent against the newest.
 * A merge commit is compared with its first parent (what the merge brought in), a root commit with nothing.
 */
export function commitRange(commits: GitCommit[]): string[] {
  const newest = commits[0]
  const oldest = commits.at(-1)
  if (newest === undefined || oldest === undefined) return []
  const base = oldest.parents[0]
  if (base !== undefined) return [base, newest.sha]

  return newest === oldest ? ['--root', newest.sha] : [EMPTY_TREE, newest.sha]
}

/** The diff view's `@` for commits (newest first): the short sha, or `oldest…newest` for several. */
export function commitsLabel(commits: GitCommit[]): string {
  const newest = commits[0]?.shortSha ?? ''
  const oldest = commits.at(-1)?.shortSha ?? ''

  return commits.length > 1 ? `${oldest}…${newest}` : newest
}

/** `git diff-tree -r --name-status -z` output → files; a rename or copy carries its source path. */
export function parseCommitFiles(out: string): CommitFile[] {
  const parts = out.split('\0')
  const files: CommitFile[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const status = parts[i]
    if (status === undefined || status === '') continue
    const letter = status[0] ?? 'M'

    if (letter === 'R' || letter === 'C') {
      files.push({ path: parts[i + 2] ?? '', oldPath: parts[i + 1] ?? '', letter })
      i += 2
    } else {
      files.push({ path: parts[i + 1] ?? '', oldPath: '', letter })
      i += 1
    }
  }

  return files
}

/** How long ago, short: `now`, `5m`, `3h`, `3d`, `2w`, `4mo`, `1y`. `time` is epoch seconds, `now` epoch ms. */
export function formatAgo(time: number, now: number): string {
  const seconds = Math.floor(now / 1000) - time
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}w`
  if (days < 365) return `${Math.floor(days / 30)}mo`

  return `${Math.floor(days / 365)}y`
}
