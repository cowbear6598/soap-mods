export type TabId = 'git' | 'files' | 'services' | 'spec' | 'db'
export type GitSubTab = 'diff' | 'branch' | 'log' | 'ci' | 'conflict'
/** The Spec tab's sub tabs: the plans under `.soap/tasks`, and the wiki pages under `.soap/wiki`. */
export type SpecSubTab = 'spec' | 'wiki'
/** The tabs that have sub tabs, and the sub tab each one shows. */
export type SubTabs = { git: GitSubTab; spec: SpecSubTab }
/** The branch tab's Fetch / Pull buttons. */
export type GitSync = 'fetch' | 'pull'

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
}

export type GitView = {
  /** False before the first load. */
  isLoaded: boolean
  /** False when the session folder is not inside a git work tree. */
  isRepo: boolean
  files: GitFile[]
  branches: GitBranch[]
  /** Last git error shown to the person, '' when none. */
  error: string
  /** Why the last branch switch or delete failed, '' when none; cleared on any tab change. */
  branchError: string
  /**
   * Branch whose delete button was pressed once and now asks to confirm, null when none;
   * isForce: the plain delete of a local branch failed for unmerged commits and the next press forces it.
   */
  deleteArmed: { name: string; isRemote: boolean; isForce: boolean } | null
  /** Branch row pressed once and now asks to press again to switch, as `l:<name>` / `r:<name>`; '' when none. */
  switchArmed: string
  /** Branch whose copy button was just pressed and shows a check for COPIED_MS, '' when none. */
  copied: string
  /** The operation stopped for conflicts, '' when none. */
  op: MergeOp
  /** Why the last abort, continue or resolve failed, '' when none; cleared on any tab change. */
  opError: string
  /** The abort button was pressed once and now asks to confirm. */
  isAbortArmed: boolean
  /** `delete:<path>` or `rollback:<path>`: the diff tab button pressed once that now asks to confirm, '' when none. */
  fileArmed: string
  /** Why the last delete or rollback of a diff tab file failed, '' when none; cleared on any tab change. */
  fileError: string
  /**
   * The repo bar: just the session folder's repo when it is one; else the repos one level down
   * (`company/a`, `company/b`), by name. [] when there is none.
   */
  repos: RepoSummary[]
  /** Folder name of the repo the Git tab shows, '' when none. */
  repo: string
}

/** One commit in the log tab. */
export type GitCommit = {
  sha: string
  shortSha: string
  /** Parent shas; the first is the one the commit's files and diff are compared with. [] for a root commit. */
  parents: string[]
  author: string
  /** Author time, epoch seconds. */
  time: number
  subject: string
}

/** A file a commit changed, from `git diff-tree --name-status`. */
export type CommitFile = {
  path: string
  /** Where a rename or copy came from, '' otherwise. */
  oldPath: string
  /** Status letter: A, M, D, R, C or T. */
  letter: string
}

/** What happened to a file as a whole: the diff pane header, a file row's letter color. */
export type FileKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict'

/** What the diff pane shows: a work tree file (diff tab), or a file in a commit (log tab). */
/** Which page of a long diff is drawn (DIFF_PAGE_ROWS a page, from 0), and of which diff: another `id` starts at the top. */
export type DiffPage = { id: string; page: number }

export type DiffPaneView = {
  /** Repo-relative path, '' when nothing is shown. */
  path: string
  kind: FileKind
  diff: string
  isTruncated: boolean
  /** Why reading the diff failed, '' when none. */
  error: string
  /** For a commit file: the commits it was opened from (newest first; the title's `@ sha`), [] for a work tree file. */
  commits: GitCommit[]
  /** What Previous / Next step through: all the files of those commits, or for a work tree file the diff tab's files (diffSteps). */
  files: CommitFile[]
}

/** The log tab: one branch's commits, and the commits opened to their files. */
export type LogView = {
  /** Full ref of the branch picked with a branch row's log button (`refs/heads/dev`); '' follows the current branch. */
  ref: string
  isLoaded: boolean
  commits: GitCommit[]
  /** Shas of the listed commits not pushed yet. */
  unpushed: string[]
  /** Which page of LOG_PAGE commits is listed (from 0); Previous / Next change it. */
  page: number
  /** There are older commits than the listed page (more matches, when searching): Next shows. */
  hasNext: boolean
  /** The search covered only the newest commits: git's output hit the size cap. */
  isTruncated: boolean
  /** Why the last log read failed, '' when none. */
  error: string
  /** Select range is on: pressing a commit picks a range end instead of opening it. */
  isPicking: boolean
  /** Sha of the range's first end, pressed while picking; '' when none yet. Only a listed one. */
  rangeStart: string
  /**
   * The commits whose files are listed instead of the commits, newest first; [] when none.
   * Several are read as one change: from before the oldest to the newest.
   */
  opened: GitCommit[]
  /** The opened commits' files, null while they are read. */
  files: CommitFile[] | null
  /** Why reading the commits' files failed, '' when none. */
  commitError: string
}

/** One repo under the session folder, as the repo bar shows it. */
export type RepoSummary = {
  /** Its folder's name. */
  name: string
  /** Absolute path of its work tree, as git prints it. */
  root: string
  /** Has uncommitted changes (untracked files too); the bar marks it with `*`. */
  isDirty: boolean
  hasConflict: boolean
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
  /** Why the last read or apply failed, '' when none. */
  error: string
}

/** What covers the tabs in Soap Panel, one at a time: a diff, a conflicted file's merge, or a file's text; none shows the tabs. */
export type Cover =
  | { kind: 'none' }
  | { kind: 'diff'; data: DiffPaneView }
  | { kind: 'merge'; data: MergeView }
  | { kind: 'file'; data: FileView }

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

/** A stop or restart in flight, by the service's top pid. */
export type ServicePending = { pid: number; action: ServiceAction }

export type ServicesView = {
  /** False before the first scan finishes. */
  isLoaded: boolean
  items: Service[]
  /** Last scan error, '' when none; cleared by the next good scan. */
  error: string
  /** Why the last stop or restart failed, '' when none; kept until the next action or the × that dismisses it. */
  actionError: string
}

/** One entry of the folder the Files tab shows. */
export type FolderEntry = {
  name: string
  /** A symbolic link is `other`. */
  kind: 'file' | 'dir' | 'other'
  /** Bytes, for a file. */
  size: number
}

export type FilesView = {
  /** The folder shown, relative to the session folder with `/`; '' is the session folder itself. */
  dir: string
  /** False before the first listing finishes. */
  isLoaded: boolean
  /** Folders first, then files, each by name; only the first FILES_ROW_LIMIT. */
  entries: FolderEntry[]
  /** How many entries the folder holds, drawn or not. */
  total: number
  /** Why listing the folder failed, '' when none. */
  error: string
  /** Text in the search field, '' when not searching. */
  query: string
  /** Files of the whole session folder matching the search, null when not searching or still walking. */
  found: FoundFiles | null
  /** The entry whose ⋯ menu is open, relative to the session folder; '' when none. */
  menu: string
  /** Delete in the open menu was pressed once and waits for the second press. */
  isDeleteArmed: boolean
  /** Why the open menu's action failed, '' when none. */
  menuError: string
}

export type FoundFiles = {
  /** Relative to the session folder with `/`; only the first FILES_ROW_LIMIT. */
  paths: string[]
  /** How many matched, drawn or not. */
  total: number
  /** The walk stopped at FILES_WALK_LIMIT files: some were not searched. */
  isCapped: boolean
}

/** A file of the Files tab opened to read, drawn over the tabs. */
export type FileView = {
  /** Relative to the session folder with `/`, '' when no file is open. */
  path: string
  /** The text drawn, cut at FILE_VIEW_MAX_CHARS; '' when there is none to draw. */
  text: string
  isTruncated: boolean
  /** Why there is no text (a binary file, too large), '' otherwise. */
  note: string
  /** Why reading the file failed, '' when none. */
  error: string
  /** The file's modified time and size when read (`mtimeMs:size`), '' when it could not be read; unchanged, a reread skips the file. */
  stamp: string
}

/** A plan the plan skill writes to `.soap/tasks/<feature>/plan.yaml`, as read; a missing or wrong field is empty. */
export type Plan = {
  branch: string
  issueNumber: string
  description: string
  goals: string[]
  constraints: string[]
  related: string[]
  verify: string[]
}

/** One feature folder under `.soap/tasks`. */
export type SpecEntry = {
  name: string
  /** plan.yaml's modified time; 0 when the folder has none. */
  mtimeMs: number
  hasPlan: boolean
}

export type SpecView = {
  /** False before the first listing finishes. */
  isLoaded: boolean
  /** Newest plan first; folders without a plan.yaml last. */
  specs: SpecEntry[]
  /** Why listing `.soap/tasks` failed, '' when none (a missing folder is no specs, not an error). */
  error: string
  /** The feature opened, '' for the list. */
  open: string
  /** Feature whose trash button was pressed once and now asks to confirm, '' when none. */
  deleteArmed: string
  /** Why the last delete failed, '' when none. */
  deleteError: string
  plan: Plan
  /** What is wrong with the opened plan.yaml (format, missing keys, reading it); empty when it is fine. */
  problems: string[]
  /** The opened plan.yaml's modified time and size when read (`mtimeMs:size`), '' when it could not be read; unchanged, a reread skips it. */
  stamp: string
}

/** Which model family Summary Conversation asks; the one the conversation runs on reads the conversation's own cache. */
export type WikiModel = 'opus' | 'sonnet' | 'haiku'

/**
 * One draft Distill or the wiki skill wrote to `.soap/wiki/.drafts`, waiting to be accepted or discarded: it writes a
 * whole page (new, or replacing one), moves (renames) a page, or deletes one. Page paths are relative to `.soap/wiki`.
 */
export type WikiDraft = {
  /** The draft's file name under `.soap/wiki/.drafts`. */
  id: string
} & (
  | {
      kind: 'write'
      target: string
      /** No page is at `target` yet: accepting creates it rather than replacing one. */
      isNew: boolean
    }
  | { kind: 'move'; from: string; target: string }
  | { kind: 'delete'; target: string }
)

export type WikiView = {
  /** False before the first listing finishes. */
  isLoaded: boolean
  /** Page paths relative to `.soap/wiki` with `/`, `.md` included; by path. */
  pages: string[]
  /** Paths of the checked pages that exist, as the mod's store keeps them for this session root. */
  checked: string[]
  /** Oldest first. */
  drafts: WikiDraft[]
  /** Why listing `.soap/wiki` or saving the checked pages failed, '' when none (a missing folder is no pages, not an error). */
  error: string
  /** Path under `.soap/wiki` (a page, or a draft as `.drafts/<id>`) whose trash button was pressed once and now asks to confirm, '' when none. */
  deleteArmed: string
  /** Why the last delete, accept or discard failed, '' when none. */
  deleteError: string
  /** The page opened, '' when none. */
  open: string
  /** The draft opened (its id), '' when none. */
  draft: string
  /** The opened page's Markdown, or the opened draft's. */
  text: string
  /** For an opened draft that changes a page: the page's lines against the draft's, as diff hunks; '' otherwise. */
  diff: string
  /** `text` or `diff` was cut to fit. */
  isTruncated: boolean
  /** Why reading the opened page or draft failed, '' when none. */
  readError: string
  /** The model Summary Conversation asks, as picked in the tab (kept in the mod's store); '' before one is picked: the conversation's own. */
  model: WikiModel | ''
  /** The terminal's model menu (drawn by the mod, not Select) is open. */
  isModelOpen: boolean
  /** What the last Distill came to when it made no drafts (nothing to keep, an API error; said nothing when Claude has not replied yet); '' otherwise. */
  distillNote: string
}

/** Which checked pages the current conversation already carries, so each reaches Claude once. */
export type WikiSent = {
  /** The session id the pages went to; '' before any did. */
  conversation: string
  pages: string[]
}

/** A saved SQL Server connection, as the DB tab lists it; the password is not here (Keychain or DPAPI). */
export type DbConnection = {
  id: string
  /** As the connection string gave it: `tcp:host,1433`, `host\instance`. */
  server: string
  /** '' for the login's default database. */
  database: string
  /** '' with Windows integrated security. */
  user: string
  isIntegrated: boolean
  /** TrustServerCertificate=True: sqlcmd -C. */
  trustCert: boolean
}

/** A table or view of the open connection. */
export type DbTable = { schema: string; name: string; isView: boolean }

export type DbColumn = { name: string; type: string; isNullable: boolean }

/** What a SELECT returned: only the first DB_ROW_LIMIT rows are kept. */
export type DbResult = {
  columns: string[]
  rows: string[][]
  /** Rows sqlcmd printed, kept or not. */
  total: number
  /** sqlcmd's output hit the size cap: there may be more rows than total. */
  isTruncated: boolean
}

export type DbView = {
  /** False before the saved connections are read. */
  isLoaded: boolean
  connections: DbConnection[]
  /** Id of the connection opened, '' for the list. */
  open: string
  /** The open connection's tables and views, null while they are read. */
  tables: DbTable[] | null
  /** The table expanded to its columns, as `schema.name`; '' when none. */
  table: string
  columns: DbColumn[]
  /** Text in the query field. */
  query: string
  /** The last query's rows, null before one ran. */
  result: DbResult | null
  /** Why reading, adding or deleting connections or tables failed, '' when none. */
  error: string
  /** Why the last query was refused or failed, '' when none. */
  queryError: string
  /** Connection whose trash button was pressed once and now asks to confirm, '' when none. */
  deleteArmed: string
}

/** A GitLab pipeline or job status, as the API gives it: `running`, `success`, `failed`, `manual`, `skipped`… */
export type CiStatus = string

/** One pipeline of the repo's GitLab project. */
export type CiPipeline = {
  id: number
  /** The project-wide number GitLab shows as `#20653`. */
  iid: number
  /** The branch or tag it ran for. */
  ref: string
  sha: string
  shortSha: string
  /** The commit's title, '' when unknown. */
  title: string
  status: CiStatus
  /** What started it: `push`, `web`, `schedule`, `merge_request_event`… */
  source: string
  /** Created time, epoch seconds. */
  time: number
  webUrl: string
}

/** One job of an opened pipeline. */
export type CiJob = {
  id: number
  name: string
  stage: string
  status: CiStatus
  /** Seconds it ran, null before it starts. */
  duration: number | null
  allowFailure: boolean
}

/** What a job's button asks GitLab: run a manual job, or rerun a finished one. */
export type CiJobAction = 'play' | 'retry'

/** A branch (or tag, merge request ref) on the CI tab's first level, with its newest pipeline. */
export type CiBranch = {
  name: string
  /** Its newest pipeline, null when none ran among the newest ones read (found by search). */
  pipeline: CiPipeline | null
}

/** The Git tab's CI sub tab: the GitLab pipelines of the repo the Git tab shows, read through the GitLab API with a token the mod keeps. */
export type CiView = {
  /** False before the first read finishes. */
  isLoaded: boolean
  /** The GitLab host of the repo's remote, '' when the remote is not one the tab can read. */
  host: string
  /** A token is saved for `host` (the Keychain or DPAPI holds it; never here). */
  hasToken: boolean
  /** The GitLab account the saved token signs in as, '' when unknown. */
  user: string
  /** The form to paste a new token is open (always drawn when there is no token). */
  isTokenOpen: boolean
  /** Why the last token save failed or the saved token was refused, '' when none. */
  tokenError: string
  /** The branch search box's text. */
  query: string
  /** The checked out branch (This branch opens it); '' when unknown (detached HEAD, not read yet). */
  branch: string
  /** The branches that ran pipelines lately, newest first; while searching, those that match. */
  branches: CiBranch[]
  /** Which page of CI_PAGE branches is listed (from 0). */
  page: number
  /** Why reading the branches failed (not a GitLab repo, no access), '' when none. */
  error: string
  /** The branch opened to its pipelines, null for the branch list. */
  ref: string | null
  /** The opened branch's pipelines, newest first; null while they are read. */
  pipelines: CiPipeline[] | null
  /** Which page of CI_PAGE pipelines of the opened branch is listed (from 0). */
  pipelinePage: number
  hasNext: boolean
  /** Why reading the opened branch's pipelines failed, '' when none. */
  pipelinesError: string
  /** The Run or Retry button pressed once and waiting for a second press (`retry:pipeline:<id>`, `play:job:<id>`, `retry:job:<id>`), '' when none. */
  armed: string
  /** Why the last Run or Retry failed, '' when none. */
  actionError: string
  /** The pipeline opened to its jobs, null for the list. */
  open: CiPipeline | null
  /** The opened pipeline's jobs, oldest first; null while they are read. */
  jobs: CiJob[] | null
  /** Why reading the jobs failed, '' when none. */
  jobsError: string
  /** The job opened to its log, null when none. */
  job: CiJob | null
  /** The opened job's log, colors and section markers taken out; its end when it is long. null while it is read. */
  trace: string | null
  /** Only the end of the log is shown. */
  isTraceTruncated: boolean
  /** Why reading the log failed, '' when none. */
  traceError: string
}

declare module 'claude-code' {
  interface PluginState {
    'soap-mods': {
      tab: TabId
      /** The sub tab each tab with sub tabs shows. */
      subTabs: SubTabs
      /** Shaped, like wiki. */
      view: Shaped<GitView>
      /** Whether the remote branches section is expanded. */
      showRemote: boolean
      /** Branch tab folders opened or closed by hand, keyed `l:<path>` / `r:<path>`; the rest use their default. */
      branchFolders: Record<string, boolean>
      /** Text in the branch tab's search field, '' when not searching. */
      branchQuery: string
      /** Text in the log tab's search field, '' when not searching. */
      logQuery: string
      /** Which page of files the diff tab draws (from 0); Previous / Next change it. */
      filePage: number
      services: ServicesView
      /** Shaped, like wiki. */
      files: Shaped<FilesView>
      spec: SpecView
      /** Shaped: the atom's shape changes with WikiView, so a hot reload drops what older code kept. */
      wiki: Shaped<WikiView>
      wikiSent: WikiSent
      /** Wiki tab folders opened or closed by hand, keyed by the folder's path (`db/`); the rest are open. */
      wikiFolders: Record<string, boolean>
      db: DbView
      /** Shaped, like wiki. */
      ci: Shaped<CiView>
      log: LogView
      /** Shaped, like wiki. */
      cover: Shaped<Cover>
      /** The page each diff place (`diffpage`, `wikidiff`) shows, keyed by that place. */
      diffPages: Record<string, DiffPage>
    }
  }
}
