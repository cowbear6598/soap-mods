export type TabId = 'git' | 'services'
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
  /** Why the last branch switch failed, '' when none; cleared on any tab change. */
  branchError: string
  /** The operation stopped for conflicts, '' when none. */
  op: MergeOp
  /** Why the last abort, continue or resolve failed, '' when none; cleared on any tab change. */
  opError: string
  /** The abort button was pressed once and now asks to confirm. */
  isAbortArmed: boolean
}

export type MergeOp = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | ''

/** How one conflict is resolved: a side, both in either order, or not yet. */
export type MergeChoice = 'none' | 'ours' | 'theirs' | 'ours-theirs' | 'theirs-ours'

/**
 * A piece of a conflicted file: lines neither side changed, a change only one
 * side made (or both made alike) that merges by itself, or one conflict.
 */
export type MergeChunk =
  | { kind: 'same'; lines: string[] }
  | {
      kind: 'auto'
      /** Which side changed it: `both` when the two made the same change. */
      from: 'ours' | 'theirs' | 'both'
      base: string[]
      ours: string[]
      theirs: string[]
      /** The change is in the result; false when the person undid it (the result keeps the base). */
      isApplied: boolean
    }
  | {
      kind: 'conflict'
      ours: string[]
      /** The common ancestor's lines when the markers carry them (diff3 / zdiff3), else null. */
      base: string[] | null
      theirs: string[]
      choice: MergeChoice
    }

/** A conflicted file as pieces, and what writing it back needs: its line end, final newline and marker labels. */
export type MergeText = {
  chunks: MergeChunk[]
  eol: '\n' | '\r\n'
  hasFinalEol: boolean
  /** The text after `<<<<<<<` and `>>>>>>>` on the first conflict: `HEAD`, `feature`. */
  oursLabel: string
  theirsLabel: string
}

/** The file open in the merge pane. */
export type MergeView = MergeText & {
  /** Repo-relative path, '' when no file is open. */
  path: string
  /** False when the file has no conflict markers to resolve line by line (delete/modify, binary). */
  hasMarkers: boolean
  /** The pieces come from a three-way merge of the versions git kept (`:1:` `:2:` `:3:`), not the markers on disk. */
  hasStages: boolean
  /** Why the last read or apply failed, '' when none. */
  error: string
  /** An apply or take-a-side is running. */
  isBusy: boolean
}

/** One process as the scan script reports it. */
export type ScanProc = {
  pid: number
  ppid: number
  name: string
  cmd: string | null
  exe: string | null
  /** Working directory; null when unreadable (elevated or system processes). */
  cwd: string | null
  /** Creation time, epoch ms; 0 when unknown. */
  started: number
}

export type ScanResult = {
  /** The scanner and its ancestors (the engine among them): never listed, never stopped. */
  self: number[]
  /** Only the processes that matter: port owners, their ancestors, and `self`. */
  procs: ScanProc[]
  ports: { port: number; pid: number }[]
  /** Every live PID on the machine. */
  pids: number[]
}

/** A service running under the session folder: one process tree, keyed by its top process. */
export type Service = {
  pid: number
  startedAt: number
  /** The tool that runs it: `dotnet`, `npm`, `go`. */
  tool: string
  /** The project it runs: `InventoryApi` from `--project dotnet/InventoryApi`, else its folder's name. */
  name: string
  /** The top process's raw command line, rerun as is on restart; '' when unknown. */
  command: string
  /** Absolute folder the command was started in, where a restart runs it. */
  dir: string
  ports: number[]
}

export type ServiceAction = 'stop' | 'restart'

export type ServicesView = {
  /** False before the first scan finishes. */
  isLoaded: boolean
  items: Service[]
  /** Last scan error, '' when none; cleared by the next good scan. */
  error: string
  /** Why the last stop or restart failed, '' when none; kept until the next action. */
  actionError: string
  /** Services with an action in flight, by top pid. */
  pending: { pid: number; action: ServiceAction }[]
}

declare module 'claude-code' {
  interface PluginState {
    'soap-mods': {
      tab: TabId
      subTab: GitSubTab
      view: GitView
      /** Whether the remote branches section is expanded. */
      showRemote: boolean
      services: ServicesView
      merge: MergeView
    }
  }
}
