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
    }
  }
}
