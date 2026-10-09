import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitSubTab, GitView, TabId } from '../types'
import { BRANCH_FORMAT, parseBranches, parseStatus, statusLabel, toHunks } from './git'

// ───── 想改面板標題或分頁，改這一區 ─────
const PANE = 'soap-panel'
const PANEL_TITLE = 'Soap Panel'

// 上層 Tab。之後要加新的 Tab，在這裡加一筆，再到畫面區塊補上它的內容。
const TABS: { id: TabId; label: string }[] = [{ id: 'git', label: 'Git' }]

// Git Tab 的子分頁。
const SUB_TABS: { id: GitSubTab; label: string }[] = [
  { id: 'diff', label: 'diff' },
  { id: 'branch', label: 'branch' },
  { id: 'conflict', label: 'conflict' },
]
// ───── 以下是運作邏輯 ─────

const EMPTY: GitView = {
  isLoaded: false,
  isRepo: true,
  head: '',
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

async function git($: EngineInterface, args: string[]) {
  return $.process.run(['git', '-c', 'core.quotepath=false', ...args])
}

async function setView($: EngineInterface, patch: Partial<GitView>) {
  await update($, view, v => ({ ...v, ...patch }))
}

// 讀選中檔案的 diff；已追蹤的對 HEAD，未追蹤的對空檔案。
async function loadDiff($: EngineInterface, path: string) {
  if (path === '') {
    await setView($, { selected: '', diff: '', isDiffTruncated: false })

    return
  }

  const file = (await read($, view)).files.find(f => f.path === path)
  const isUntracked = file !== undefined && file.x === '?'
  let out = ''

  try {
    if (isUntracked) {
      out = (await git($, ['diff', '--no-index', '--', '/dev/null', path])).stdout
    } else {
      const r = await git($, ['diff', 'HEAD', '--', path])
      // 還沒有任何 commit 時沒有 HEAD，改看已暫存的內容。
      out = r.exitCode === 0 ? r.stdout : (await git($, ['diff', '--cached', '--', path])).stdout
    }
  } catch {
    out = ''
  }

  const { source, isTruncated } = toHunks(out)
  await setView($, { selected: path, diff: source, isDiffTruncated: isTruncated })
}

async function loadBranches($: EngineInterface) {
  const r = await git($, ['for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads', 'refs/remotes'])
  await setView($, { branches: r.exitCode === 0 ? parseBranches(r.stdout) : [] })
}

// 重新讀 git 狀態、檔案清單、分支清單，並保留原本選中的檔案。
async function refresh($: EngineInterface) {
  let status
  try {
    status = await git($, ['status', '--porcelain=v1', '-b', '-z', '-uall'])
  } catch {
    await setView($, { isLoaded: true, isRepo: false, error: '找不到 git，請確認已安裝並在 PATH 裡。' })

    return
  }

  if (status.exitCode !== 0) {
    const isNotRepo = status.stderr.includes('not a git repository')
    await setView($, {
      isLoaded: true,
      isRepo: false,
      error: isNotRepo ? '' : status.stderr.trim(),
      head: '',
      files: [],
      diff: '',
      branches: [],
    })

    return
  }

  const { head, files } = parseStatus(status.stdout)
  const current = (await read($, view)).selected
  const selected = files.some(f => f.path === current) ? current : (files[0]?.path ?? '')
  await setView($, { isLoaded: true, isRepo: true, error: '', head, files })
  await loadBranches($)
  await loadDiff($, selected)
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
    await setView($, { error: '找不到 git，請確認已安裝並在 PATH 裡。' })

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
    await refresh($)
    void $.ui.open({ id: PANE, title: PANEL_TITLE })

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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const activeTab = await read($, tab)
    const activeSub = await read($, subTab)
    const v = await read($, view)

    const tabBar = (
      <Box gap={1}>
        {TABS.map(t => (
          <Button
            key={`tab:${t.id}`}
            label={t.label}
            variant={t.id === activeTab ? 'primary' : 'secondary'}
            onPress={() => update($, tab, () => t.id)}
          />
        ))}
      </Box>
    )

    const subBar = (
      <Box gap={1}>
        {SUB_TABS.map(s => (
          <Button
            key={`sub:${s.id}`}
            label={s.label}
            variant={s.id === activeSub ? 'primary' : 'secondary'}
            onPress={() => update($, subTab, () => s.id)}
          />
        ))}
        <Button key="refresh" label="重新整理" dimColor onPress={() => refresh($)} />
      </Box>
    )

    const error = v.error === '' ? null : <Text color="error">{v.error}</Text>

    let body
    if (!v.isLoaded) {
      body = <Text dimColor>讀取中…</Text>
    } else if (!v.isRepo) {
      body = <Text dimColor>這個資料夾不是 git repo。</Text>
    } else if (activeSub === 'diff') {
      body = (
        <Box flexDirection="column">
          <Text dimColor>
            {v.head} · {v.files.length} 個變更
          </Text>
          {v.files.length === 0 && <Text>沒有未提交的變更。</Text>}
          {v.files.map(f => (
            <Button
              key={`file:${f.path}`}
              label={`${statusLabel(f)}  ${f.path}`}
              variant={f.path === v.selected ? 'primary' : 'secondary'}
              onPress={() => loadDiff($, f.path)}
            />
          ))}
          {v.selected !== '' && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{v.selected}</Text>
              {v.diff === '' ? (
                <Text dimColor>沒有可顯示的文字差異（可能是二進位檔，或只改了權限）。</Text>
              ) : (
                <Code source={v.diff} format="diff" path={v.selected} />
              )}
              {v.isDiffTruncated && <Text dimColor>差異太長，只顯示前面一段。</Text>}
            </Box>
          )}
        </Box>
      )
    } else if (activeSub === 'branch') {
      body = (
        <Box flexDirection="column">
          {v.branches.length === 0 && <Text dimColor>沒有分支。</Text>}
          {v.branches.map(b => (
            <Box key={`branch:${b.isRemote ? 'r' : 'l'}:${b.name}`} gap={1}>
              {b.isCurrent ? (
                <Text bold color="success">
                  ● {b.name}
                </Text>
              ) : (
                <Button
                  key={`switch:${b.isRemote ? 'r' : 'l'}:${b.name}`}
                  label={b.name}
                  dimColor={b.isRemote}
                  onPress={() => switchBranch($, b.name, b.isRemote)}
                />
              )}
              <Text dimColor>
                {[b.isRemote ? 'remote' : '', b.track, b.date, b.subject].filter(s => s !== '').join(' · ')}
              </Text>
            </Box>
          ))}
          <Text dimColor>點分支名稱可以切換過去。</Text>
        </Box>
      )
    } else {
      body = <Text dimColor>conflict 還沒做，下一步再來。</Text>
    }

    return (
      <Box flexDirection="column" gap={1}>
        {tabBar}
        {subBar}
        {error}
        {body}
      </Box>
    )
  })
}
