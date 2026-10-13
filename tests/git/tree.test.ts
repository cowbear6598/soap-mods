import { expect, test } from 'claude-code/testing'

import type { GitBranch } from '../../types'
import { branchTree, treeRows } from '../../hooks/git/tree'

const branch = (name: string): GitBranch => ({ name, isCurrent: false, isRemote: false, upstream: '', track: '' })
const labels = (names: string[], open: (path: string, fallback: boolean) => boolean) =>
  treeRows(branchTree(names.map(branch)), open).map(r =>
    r.kind === 'folder'
      ? `${'  '.repeat(r.depth)}${r.folder.label} ${r.folder.count}`
      : r.kind === 'branch'
        ? `${'  '.repeat(r.depth)}${r.label}`
        : `${'  '.repeat(r.depth)}… ${r.hidden}`,
  )

test('branchTree splits names on / into folders, folders before branches, with counts', () => {
  const names = ['dev', 'feature/a', 'feature/b', 'soap/feature/c', 'soap/feature/d']
  expect(labels(names, () => false)).toEqual(['feature/ 2', 'soap/feature/ 2', 'dev'])
  expect(labels(names, () => true)).toEqual(['feature/ 2', '  a', '  b', 'soap/feature/ 2', '  c', '  d', 'dev'])
})

test('a folder alone on its level opens by default, others stay closed', () => {
  expect(labels(['origin/main', 'origin/feature/x'], (_p, fallback) => fallback)).toEqual(['origin/ 2', '  feature/ 1', '  main'])
})

test('skipLoneRoot drops a lone top folder like origin/, but keeps several remotes apart', () => {
  const rows = (names: string[]) =>
    treeRows(branchTree(names.map(branch), true), () => true).map(r => (r.kind === 'folder' ? r.folder.label : r.kind === 'branch' ? r.label : ''))
  expect(rows(['origin/main', 'origin/feature/a'])).toEqual(['feature/', 'a', 'main'])
  expect(rows(['origin/main', 'upstream/main'])).toEqual(['origin/', 'main', 'upstream/', 'main'])
})
