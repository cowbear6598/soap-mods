import type { Service } from '../../../types'
import { DANGER } from '../../config'
import { isInFolder } from '../../services/scan'
import type { TabBody } from './context'

// Services 分頁。
export const servicesTab: TabBody = ({ w, d, a }) => {
  const { Box, Text } = w
  const { view: v, services: sv } = d

  // 一個服務一行：● 工具 · 專案名 · port，右邊重跑、停止（紅色）。
  const serviceRow = (s: Service) => {
    const pending = sv.pending.find(p => p.pid === s.pid)
    const dot = <Text dimColor>{' · '}</Text>

    return (
      <Box key={`svc:${s.pid}`} gap={1} alignItems="center" paddingLeft={2}>
        <Text color={pending === undefined ? 'success' : 'warning'}>●</Text>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text>{s.tool}</Text>
          {dot}
          <Text bold wrap="truncate-end">
            {s.name}
          </Text>
          {s.ports.length > 0 && dot}
          {s.ports.length > 0 && <Text color="suggestion">{s.ports.map(p => `:${p}`).join(' ')}</Text>}
        </Box>
        {pending === undefined ? (
          <Box flexShrink={0}>
            {w.iconButton(`svc:restart:${s.pid}`, 'restart', 'Restart', false, () => a.runServiceAction(s, 'restart'))}
            {w.iconButton(`svc:stop:${s.pid}`, 'stop', 'Stop', false, () => a.runServiceAction(s, 'stop'), DANGER)}
          </Box>
        ) : (
          <Text dimColor>{pending.action === 'stop' ? 'Stopping…' : 'Restarting…'}</Text>
        )}
      </Box>
    )
  }

  // 照 repo 分組，跟 diff 分頁的 Staged／Unstaged 一樣：標題是 repo 名（不寫數量），下面是它的服務。
  // 組的順序跟上面那排 repo 一樣；不在任何 repo 裡的放最後的 Other。還沒讀到 repo 時全部放在 Running。
  const groupOf = new Map(sv.items.map(s => [s, v.repos.find(r => isInFolder(s.dir, r.root))?.name ?? 'Other']))
  const groups =
    v.repos.length === 0
      ? [{ name: 'Running', items: sv.items }]
      : [...v.repos.map(r => r.name), 'Other']
          .map(name => ({ name, items: sv.items.filter(s => groupOf.get(s) === name) }))
          .filter(g => g.items.length > 0)

  return (
    <Box flexDirection="column" gap={1}>
      {sv.error !== '' && <Text color="error">{sv.error}</Text>}
      {sv.actionError !== '' && <Text color="error">{sv.actionError}</Text>}
      {!sv.isLoaded ? (
        <Text dimColor>Scanning…</Text>
      ) : sv.items.length === 0 ? (
        <Text dimColor>No services running in this folder.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          {groups.map(g => (
            <Box key={`svc-group:${g.name}`} flexDirection="column">
              <Text bold dimColor>{g.name}</Text>
              {g.items.map(serviceRow)}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
