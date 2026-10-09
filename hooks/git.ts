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

/** Two-letter status as a short label for a file row. */
export function statusLabel(file: GitFile): string {
  if (file.x === '?' && file.y === '?') return '??'
  if (file.x === 'U' || file.y === 'U' || (file.x === 'A' && file.y === 'A') || (file.x === 'D' && file.y === 'D')) {
    return 'UU'
  }

  return `${file.x}${file.y}`.replace(/ /g, '·')
}
