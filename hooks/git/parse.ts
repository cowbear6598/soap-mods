import type { CommitFile, FileKind, GitBranch, GitCommit, GitFile, GitView, LogView } from '../../types'

export const MAX_DIFF_CHARS = 60000

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
  const hunks = start === -1 ? '' : diff.slice(start)
  if (hunks.length <= MAX_DIFF_CHARS) return { source: hunks, isTruncated: false }

  // Cut at a line end so the last hunk line is whole.
  const cut = hunks.lastIndexOf('\n', MAX_DIFF_CHARS)

  return { source: hunks.slice(0, cut === -1 ? MAX_DIFF_CHARS : cut), isTruncated: true }
}

export const BRANCH_FORMAT = [
  '%(HEAD)',
  '%(refname)',
  '%(refname:short)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:relative)',
  '%(contents:subject)',
].join('%09')

/** `git for-each-ref --format=BRANCH_FORMAT` output → branches, current first. */
export function parseBranches(out: string): GitBranch[] {
  const branches: GitBranch[] = []

  for (const line of out.split('\n')) {
    if (line === '') continue
    const [head = '', ref = '', name = '', upstream = '', track = '', date = '', ...subject] = line.split('\t')
    // `origin/HEAD` is a pointer, not a branch.
    if (ref.endsWith('/HEAD')) continue

    branches.push({
      name,
      isCurrent: head === '*',
      isRemote: ref.startsWith('refs/remotes/'),
      upstream,
      track,
      date,
      subject: subject.join('\t'),
    })
  }

  return branches.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1
    if (a.isRemote !== b.isRemote) return a.isRemote ? 1 : -1

    return a.name.localeCompare(b.name)
  })
}

/** The lowercased words of a search; none when it is blank. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(w => w !== '')
}

/** Items whose `text` holds every word of `query`, ignoring case; all of them when it is blank. */
function filterWords<T>(items: T[], query: string, text: (item: T) => string): T[] {
  const words = searchWords(query)
  if (words.length === 0) return items

  return items.filter(item => {
    const haystack = text(item).toLowerCase()

    return words.every(w => haystack.includes(w))
  })
}

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

/** What happened to a file as a whole: the diff pane header. */
export function fileKind(file: GitFile): FileKind {
  if (isConflict(file)) return 'conflict'

  return letterKind(file.x === ' ' ? file.y : file.x)
}

export type FileGroupId = 'staged' | 'unstaged' | 'untracked'
export type { FileKind }

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

/** What a commit is compared with: a merge commit its first parent (what the merge brought in), a root commit nothing. */
export function commitRange(c: GitCommit): string[] {
  return c.parents[0] === undefined ? ['--root', c.sha] : [c.parents[0], c.sha]
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
