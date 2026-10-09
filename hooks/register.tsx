import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitBranch, GitSubTab, GitView, TabId } from '../types'
import type { FileEntry, FileGroupId, FileKind } from './git'
import { BRANCH_FORMAT, fileKind, formatTrack, groupFiles, parseBranches, parseStatus, splitPath, toHunks } from './git'

// ───── 想改面板標題或分頁，改這一區 ─────
const PANE = 'soap-panel'
const PANEL_TITLE = 'Soap Panel'
const DIFF_PANE = 'soap-diff'

// 檔案狀態的名稱和顏色：檔案列的狀態字母、差異面板的標題都用這張表。
const KIND_STYLE: Record<FileKind, { label: string; theme: string }> = {
  added: { label: '新增', theme: 'success' },
  modified: { label: '修改', theme: 'warning' },
  deleted: { label: '刪除', theme: 'error' },
  renamed: { label: '重新命名', theme: 'suggestion' },
  conflict: { label: '衝突', theme: 'error' },
}

// 變更列表的分組標題，照這個順序畫。
const FILE_GROUPS: { id: FileGroupId; label: string }[] = [
  { id: 'staged', label: '已暫存' },
  { id: 'unstaged', label: '未暫存' },
  { id: 'untracked', label: '未追蹤' },
]

// 圖示：24x24 的線條圖，只放 <svg> 裡面的內容（Lucide 風格）。
const ICONS = {
  git: '<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>',
  diff: '<path d="M12 3v14"/><path d="M5 10h14"/><path d="M5 21h14"/>',
  branch:
    '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  conflict:
    '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
}
type IconName = keyof typeof ICONS

const ICON_PX = 16
// 選中的 tab 恆亮的底色。
const ACTIVE_BG = '#3a3a3a'
// 圖示按鈕的寬度：這串空白撐出按鈕，底色、hover、圖示都對齊這塊區域。
// 用不換行空白（\u00a0），一般空白會被吃掉。
const ICON_BUTTON_LABEL = '\u00a0'.repeat(10)
// 整行按鈕的 label：比任何面板都寬，畫的時候被 max-width 壓回一整行。
const ROW_BUTTON_LABEL = '\u00a0'.repeat(400)

// 沒選中的圖示和分隔線的顏色。
const MUTED = '#8b8b8b'

// 分隔線。桌面版把 Svg 畫成 max-width:100% 的圖，寬度會被壓到面板寬、高度固定 1px；
// preserveAspectRatio="none" 讓線跟著拉伸，不會被等比縮到看不見。終端機沒有 Svg，用一長串橫線字元。
const DIVIDER_PX = 4000
const DIVIDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${DIVIDER_PX}" height="1" viewBox="0 0 ${DIVIDER_PX} 1" preserveAspectRatio="none"><rect width="${DIVIDER_PX}" height="1" fill="${MUTED}"/></svg>`
const DIVIDER_TEXT = '─'.repeat(400)

function iconSvg(name: IconName, isActive: boolean) {
  const color = isActive ? '#ffffff' : MUTED

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`
}

// 上層 Tab。之後要加新的 Tab，在這裡加一筆，再到畫面區塊補上它的內容。
const TABS: { id: TabId; label: string; icon: IconName }[] = [{ id: 'git', label: 'Git', icon: 'git' }]

// Git Tab 的子分頁。
const SUB_TABS: { id: GitSubTab; label: string; icon: IconName }[] = [
  { id: 'diff', label: 'diff', icon: 'diff' },
  { id: 'branch', label: 'branch', icon: 'branch' },
  { id: 'conflict', label: 'conflict', icon: 'conflict' },
]
// ───── 以下是運作邏輯 ─────

const EMPTY: GitView = {
  isLoaded: false,
  isRepo: true,
  files: [],
  selected: '',
  diff: '',
  isDiffTruncated: false,
  branches: [],
  error: '',
}

const tab = atom({ plugin: 'soap-mods', key: 'tab' } as const, 'git')
const subTab = atom({ plugin: 'soap-mods', key: 'subTab' } as const, 'diff')
const view = atom({ plugin: 'soap-mods', key: 'view' } as const, EMPTY)
const showRemote = atom({ plugin: 'soap-mods', key: 'showRemote' } as const, false)

async function git($: EngineInterface, args: string[]) {
  return $.process.run(['git', '-c', 'core.quotepath=false', ...args])
}

async function setView($: EngineInterface, patch: Partial<GitView>) {
  await update($, view, v => ({ ...v, ...patch }))
}

const NO_DIFF: Partial<GitView> = { selected: '', diff: '', isDiffTruncated: false }
const NO_GIT = '找不到 git，請確認已安裝並在 PATH 裡。'

// 讀一個檔案的 diff，回傳要寫進 view 的那幾欄；已追蹤的對 HEAD，未追蹤的對空檔案。
async function readDiff($: EngineInterface, files: GitView['files'], path: string): Promise<Partial<GitView>> {
  if (path === '') return NO_DIFF

  const file = files.find(f => f.path === path)
  const isUntracked = file !== undefined && file.x === '?'
  const flags = ['--no-color', '--no-ext-diff', '--no-textconv']
  let out = ''
  let error = ''

  try {
    if (isUntracked) {
      out = (await git($, ['diff', ...flags, '--no-index', '--', '/dev/null', path])).stdout
    } else {
      const r = await git($, ['diff', ...flags, 'HEAD', '--', path])
      if (r.exitCode === 0) {
        out = r.stdout
      } else {
        // 還沒有任何 commit 時沒有 HEAD，改看已暫存的內容。
        const cached = await git($, ['diff', ...flags, '--cached', '--', path])
        out = cached.stdout
        if (cached.exitCode !== 0) error = cached.stderr.trim() || r.stderr.trim()
      }
    }
  } catch (err) {
    error = `讀取差異失敗：${err instanceof Error ? err.message : String(err)}`
  }

  const { source, isTruncated } = toHunks(out)

  return { selected: path, diff: source, isDiffTruncated: isTruncated, error }
}

// 點檔案：一定開一個獨立的 diff 面板並切過去；關掉面板交給面板自己的關閉鈕。
async function openDiff($: EngineInterface, path: string) {
  const [panes, v] = await Promise.all([$.ui.panes(), read($, view)])
  const isOpen = panes.some(p => p.id === DIFF_PANE)
  await setView($, await readDiff($, v.files, path))
  // 已經開著的話先關再開，才會跳到最前面，而不是躲在別的分頁後面。
  if (isOpen) await $.ui.close({ id: DIFF_PANE })
  await $.ui.open({ id: DIFF_PANE, title: path, focus: true })
}

// 重新讀 git 狀態、檔案清單、分支清單，保留原本點開的檔案；最後只寫一次 view，只重畫一次。
async function refresh($: EngineInterface) {
  let status
  let refs
  try {
    ;[status, refs] = await Promise.all([
      git($, ['status', '--porcelain=v1', '-b', '-z', '-uall']),
      git($, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes']),
    ])
  } catch {
    await setView($, { isLoaded: true, isRepo: false, error: NO_GIT })

    return
  }

  if (status.exitCode !== 0) {
    const isNotRepo = status.stderr.includes('not a git repository')
    await setView($, {
      ...NO_DIFF,
      isLoaded: true,
      isRepo: false,
      error: isNotRepo ? '' : status.stderr.trim(),
      files: [],
      branches: [],
    })

    return
  }

  const { files } = parseStatus(status.stdout)
  const current = (await read($, view)).selected
  // 原本點開的檔案還在清單裡才保留。
  const selected = files.some(f => f.path === current) ? current : ''
  await setView($, {
    isLoaded: true,
    isRepo: true,
    error: '',
    files,
    branches: refs.exitCode === 0 ? parseBranches(refs.stdout) : [],
    ...(await readDiff($, files, selected)),
  })
  // 原本看的檔案已經沒有變更了，把它的面板也關掉。
  if (current !== '' && selected === '') await $.ui.close({ id: DIFF_PANE })
}

// 桌面版的面板沒有焦點時，按下滑鼠會先拿焦點、整個面板重畫，按到的按鈕被換掉，那一下就不算。
// 點分頁標籤切回 Soap Panel 時引擎不會通知、也不給焦點，所以定時看一下：
// 它「剛被切到前面」又沒焦點，就先把焦點給它，第一下點擊才點得到。
// 只在從看不見變成看得見的那一刻給，平常在輸入框打字不會被搶。
const FOCUS_WATCH_MS = 200
let wasShown = true
let isWatching = false

async function focusWhenShown($: EngineInterface) {
  if (isWatching) return
  isWatching = true
  try {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    const isShown = pane?.isShown === true
    if (isShown && !wasShown && pane?.isFocused === false) {
      await $.ui.open({ id: PANE, title: PANEL_TITLE, focus: true })
    }
    wasShown = isShown
  } catch {
    // 讀不到就等下一輪。
  } finally {
    isWatching = false
  }
}

async function switchBranch($: EngineInterface, name: string, isRemote: boolean) {
  const args = isRemote ? ['switch', '--track', name] : ['switch', name]
  try {
    const r = await git($, args)
    if (r.exitCode !== 0) {
      await setView($, { error: r.stderr.trim() || `切換到 ${name} 失敗` })

      return
    }
  } catch {
    await setView($, { error: NO_GIT })

    return
  }

  $.ui.toast(`已切換到 ${name}`)
  await refresh($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'soap-panel',
      description: '開啟 Soap Panel（Git 面板）',
    })
    // 先開面板（畫「讀取中…」），git 在背景讀，不擋住 session 開始。
    void $.ui.open({ id: PANE, title: PANEL_TITLE })
    void refresh($).catch(() => undefined)
    $.clock.every(FOCUS_WATCH_MS, () => void focusWhenShown($))

    return next(e)
  })

  on('command.run', { command: 'soap-panel' }, async $ => {
    await refresh($)
    await $.ui.open({ id: PANE, title: PANEL_TITLE })

    return { text: 'Soap Panel 已開啟。' }
  })

  // 每個回合結束後，檔案可能已經變了，順手更新。
  on('turn.complete', async ($, e, next) => {
    try {
      await refresh($)
    } catch {
      // 讀不到就維持舊畫面，不要擋住回合結束。
    }

    return next(e)
  })

  // 自己按掉 diff 面板時：清掉選中的檔案，並把焦點交回 Soap Panel。
  // 桌面版的面板沒有焦點時，按下滑鼠會先拿焦點、整個面板重畫，按到的按鈕被換掉，那一下就不算；
  // 先把焦點給它，回來的第一下才點得到。
  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === DIFF_PANE && e.origin.kind === 'person') {
      await setView($, NO_DIFF)
      await $.ui.open({ id: PANE, title: PANEL_TITLE, focus: true })
    }

    return result
  }).catch(($, e, next) => next(e)) // 清不掉就算了，絕不能擋住關面板。

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    // 終端機沒有 Svg，那邊退回文字按鈕。
    const Svg = 'Svg' in ui ? ui.Svg : undefined
    const isTerminal = e.surface === 'terminal'
    const activeTab = await read($, tab)
    const activeSub = await read($, subTab)
    const v = await read($, view)
    const isRemoteOpen = await read($, showRemote)

    // 只有圖示的按鈕，三層疊起來（後畫的 absolute 疊在上面）：
    // 1. 墊底的 Button 撐出外框大小，選中的底色畫在外框上；它被蓋住，點不到；
    // 2. Svg 那層鋪滿外框、置中；
    // 3. 最上層是一模一樣的 Button，剛好蓋滿外框，接點擊，hover 的亮底也就是外框大小。
    const iconButton = (key: string, icon: IconName, label: string, isActive: boolean, onPress: () => void) =>
      Svg === undefined ? (
        <Button key={key} label={label} variant={isActive ? 'primary' : 'secondary'} onPress={onPress} />
      ) : (
        <Box key={`${key}:box`} position="relative" backgroundColor={isActive ? ACTIVE_BG : undefined}>
          <Button key={`${key}:spacer`} label={ICON_BUTTON_LABEL} plain onPress={onPress} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0} justifyContent="center" alignItems="center">
            <Svg source={iconSvg(icon, isActive)} alt={label} width={ICON_PX} height={ICON_PX} />
          </Box>
          <Box position="absolute" top={0} left={0}>
            <Button key={key} label={ICON_BUTTON_LABEL} plain onPress={onPress} />
          </Box>
        </Box>
      )

    // 整行都能點的列表項目。
    // 桌面版：內容照常排，上面疊一顆透明按鈕。按鈕本身是 fit-content，靠一長串不換行空白撐到
    // max-width:100%，剛好整行寬，hover 的亮底也就是整行。
    // 終端機：疊上去的空白會蓋掉底下的字，所以只有名稱是按鈕。
    const pressRow = (row: {
      key: string
      label: string
      onPress: () => void
      isDim?: boolean
      lead?: unknown
      rest?: unknown
    }) =>
      isTerminal ? (
        <Box key={`${row.key}:row`} gap={1} paddingLeft={2} hover={{ backgroundColor: ACTIVE_BG }}>
          {row.lead}
          <Button key={row.key} label={row.label} plain dimColor={row.isDim} onPress={row.onPress} />
          {row.rest}
        </Box>
      ) : (
        <Box key={`${row.key}:row`} position="relative">
          <Box gap={1} paddingLeft={2}>
            {row.lead}
            <Text dimColor={row.isDim}>{row.label}</Text>
            {row.rest}
          </Box>
          <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
            <Button key={row.key} label={ROW_BUTTON_LABEL} plain onPress={row.onPress} />
          </Box>
        </Box>
      )

    // 項目之間插入直線分隔。
    const withDividers = (items: unknown[], prefix: string) =>
      items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${prefix}:div:${i}`} dimColor>│</Text>, item]))

    // 一排置中的圖示分頁，中間用直線隔開。
    const iconBar = <T extends string>(
      prefix: string,
      items: { id: T; label: string; icon: IconName }[],
      active: T,
      select: (id: T) => void,
    ) => (
      <Box gap={1} alignItems="center" justifyContent="center" width="100%">
        {withDividers(
          items.map(t => iconButton(`${prefix}:${t.id}`, t.icon, t.label, t.id === active, () => select(t.id))),
          prefix,
        )}
      </Box>
    )

    // 分隔線：線落在這一列的正中間，夾在兩條線中間的東西就會上下對稱。
    const divider =
      Svg === undefined ? (
        <Box width="100%" height={1} overflow="hidden">
          <Text dimColor>{DIVIDER_TEXT}</Text>
        </Box>
      ) : (
        <Box width="100%" height={1} overflow="hidden" alignItems="center">
          <Svg source={DIVIDER_SVG} alt="分隔線" width={DIVIDER_PX} height={1} />
        </Box>
      )

    const error = v.error === '' ? null : <Text color="error">{v.error}</Text>

    let body
    if (!v.isLoaded) {
      body = <Text dimColor>讀取中…</Text>
    } else if (!v.isRepo) {
      body = <Text dimColor>這個資料夾不是 git repo。</Text>
    } else if (activeSub === 'diff') {
      const groups = groupFiles(v.files)
      // 一個檔案一列：彩色狀態字母、檔名（點了看差異）、淡色資料夾。
      const fileRow = (group: FileGroupId, entry: FileEntry) => {
        const { name, dir } = splitPath(entry.file.path)

        return pressRow({
          key: `file:${group}:${entry.file.path}`,
          label: name,
          onPress: () => openDiff($, entry.file.path),
          lead: (
            <Text bold color={KIND_STYLE[entry.kind].theme}>
              {entry.letter}
            </Text>
          ),
          rest:
            dir === '' ? null : (
              <Text dimColor wrap="truncate-start">
                {dir}
              </Text>
            ),
        })
      }

      body =
        v.files.length === 0 ? (
          <Text dimColor>沒有未提交的變更。</Text>
        ) : (
          <Box flexDirection="column" gap={1}>
            {FILE_GROUPS.filter(g => groups[g.id].length > 0).map(g => (
              <Box key={`group:${g.id}`} flexDirection="column">
                <Text bold dimColor>{`${g.label} · ${groups[g.id].length}`}</Text>
                {groups[g.id].map(entry => fileRow(g.id, entry))}
              </Box>
            ))}
          </Box>
        )
    } else if (activeSub === 'branch') {
      const current = v.branches.find(b => b.isCurrent)
      const locals = v.branches.filter(b => !b.isCurrent && !b.isRemote)
      const remotes = v.branches.filter(b => b.isRemote)
      const meta = (b: GitBranch) => [formatTrack(b.track), b.date, b.subject].filter(s => s !== '').join(' · ')
      const currentMeta = current === undefined ? '' : meta(current)
      const branchRow = (b: GitBranch) => {
        const id = `${b.isRemote ? 'r' : 'l'}:${b.name}`

        return pressRow({
          key: `switch:${id}`,
          label: b.name,
          isDim: b.isRemote,
          onPress: () => switchBranch($, b.name, b.isRemote),
          rest: (
            <Text dimColor wrap="truncate-end">
              {meta(b)}
            </Text>
          ),
        })
      }

      body = (
        <Box flexDirection="column" gap={1}>
          {current === undefined ? (
            <Text dimColor>沒有目前分支（detached HEAD？）。</Text>
          ) : (
            <Box flexDirection="column">
              <Text bold color="success">{`● ${current.name}`}</Text>
              {currentMeta !== '' && (
                <Box paddingLeft={2}>
                  <Text dimColor wrap="truncate-end">
                    {currentMeta}
                  </Text>
                </Box>
              )}
            </Box>
          )}
          {locals.length > 0 && (
            <Box flexDirection="column">
              <Text bold dimColor>{`本地 · ${locals.length}`}</Text>
              {locals.map(branchRow)}
            </Box>
          )}
          {remotes.length > 0 && (
            <Box flexDirection="column">
              <Button
                key="remote:toggle"
                label={`${isRemoteOpen ? '▾' : '▸'} 遠端 · ${remotes.length}`}
                plain
                dimColor
                onPress={() => update($, showRemote, open => !open)}
              />
              {isRemoteOpen && remotes.map(branchRow)}
            </Box>
          )}
          <Text dimColor>點分支名稱可以切換過去。</Text>
        </Box>
      )
    } else {
      body = <Text dimColor>conflict 還沒做，下一步再來。</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          {iconBar('tab', TABS, activeTab, id => update($, tab, () => id))}
          {divider}
          {iconBar('sub', SUB_TABS, activeSub, id => update($, subTab, () => id))}
          {divider}
        </Box>
        {error}
        {body}
      </Box>
    )
  })

  // 選中檔案的差異，開在自己的面板裡。
  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Code, Text } = $.ui.resolve(e)
    const v = await read($, view)
    const file = v.files.find(f => f.path === v.selected)

    if (file === undefined) return <Text dimColor>沒有選中的檔案。</Text>

    const kind = KIND_STYLE[fileKind(file)]

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={1}>
          <Text bold color={kind.theme}>
            {kind.label}
          </Text>
          <Text bold>{file.path}</Text>
        </Box>
        {v.error !== '' && <Text color="error">{v.error}</Text>}
        {v.diff === '' ? (
          <Text dimColor>沒有可顯示的文字差異（可能是二進位檔，或只改了權限）。</Text>
        ) : (
          <Code source={v.diff} format="diff" path={file.path} />
        )}
        {v.isDiffTruncated && <Text dimColor>差異太長，只顯示前面一段。</Text>}
      </Box>
    )
  })
}
