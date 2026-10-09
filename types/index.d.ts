export type TabId = 'git'
export type GitSubTab = 'diff' | 'branch' | 'conflict'

export type GitFile = {
  path: string
  /** Index status letter (X of `git status --porcelain`), ' ' when none. */
  x: string
  /** Work-tree status letter (Y), ' ' when none. */
  y: string
}

export type GitBranch = {
  name: string
  isCurrent: boolean
  isRemote: boolean
  upstream: string
  /** `[ahead 1, behind 2]` style text from git, '' when in sync or none. */
  track: string
  date: string
  subject: string
}

export type GitView = {
  /** False before the first load. */
  isLoaded: boolean
  /** False when the session folder is not inside a git work tree. */
  isRepo: boolean
  files: GitFile[]
  /** Path of the file whose diff is drawn, '' when none. */
  selected: string
  diff: string
  isDiffTruncated: boolean
  branches: GitBranch[]
  /** Last git error shown to the person, '' when none. */
  error: string
}

declare module 'claude-code' {
  interface PluginState {
    'soap-mods': {
      tab: TabId
      subTab: GitSubTab
      view: GitView
      /** Whether the remote branches section is expanded. */
      showRemote: boolean
    }
  }
}
