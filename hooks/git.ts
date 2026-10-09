import type { GitBranch, GitFile } from '../types'

export const MAX_DIFF_CHARS = 60000

/** `git status --porcelain=v1 -b -z` output → branch line and changed files. */
export function parseStatus(out: string): { head: string; files: GitFile[] } {
  const parts = out.split('\0')
  let head = ''
  const files: GitFile[] = []

  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry === '') continue

    if (entry.startsWith('## ')) {
      head = entry.slice(3)
      continue
    }

    const x = entry[0]
    const y = entry[1]
    files.push({ path: entry.slice(3), x, y })

    // A rename or copy is followed by its source path as an entry of its own.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1
  }

  return { head, files }
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
    const [head, ref, name, upstream, track, date, ...subject] = line.split('\t')
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

/** What happened to a file as a whole: the diff pane header. */
export function fileKind(file: GitFile): FileKind {
  if (isConflict(file)) return 'conflict'

  return letterKind(file.x === ' ' ? file.y : file.x)
}

export type FileGroupId = 'staged' | 'unstaged' | 'untracked'
export type FileKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict'

export type FileEntry = {
  file: GitFile
  /** The one status letter that belongs to this group (X for staged, Y for unstaged). */
  letter: string
  kind: FileKind
}

function isConflict(file: GitFile): boolean {
  return file.x === 'U' || file.y === 'U' || (file.x === 'A' && file.y === 'A') || (file.x === 'D' && file.y === 'D')
}

function letterKind(letter: string): FileKind {
  if (letter === 'A' || letter === '?') return 'added'
  if (letter === 'D') return 'deleted'
  if (letter === 'R' || letter === 'C') return 'renamed'

  return 'modified'
}

/**
 * Files as the source control view groups them: staged (X), unstaged (Y) and
 * untracked. A file changed on both sides is listed in both groups; a
 * conflicted file is listed once, under unstaged.
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

  return groups
}

/** `dir/sub/name.ts` → `{ name: 'name.ts', dir: 'dir/sub' }`. */
export function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')

  return slash === -1 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash) }
}

/** git's `[ahead 1, behind 2]` → `↑1 ↓2`; `[gone]` → `上游已刪除`; '' stays ''. */
export function formatTrack(track: string): string {
  if (track === '[gone]') return '上游已刪除'
  const ahead = /ahead (\d+)/.exec(track)
  const behind = /behind (\d+)/.exec(track)

  return [ahead ? `↑${ahead[1]}` : '', behind ? `↓${behind[1]}` : ''].filter(s => s !== '').join(' ')
}
