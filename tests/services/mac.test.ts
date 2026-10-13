import { expect, test } from 'claude-code/testing'

import { MAC_ARGS_OUT, MAC_EPOCH, MAC_FILES_OUT, MAC_ROOT, MAC_SCAN_OUT } from '../test-fixtures'
import { isShellSafe, parseMacArgs, parseMacFiles, parseMacScan, wantedPids, withFiles } from '../../hooks/services/mac'
import { findServices } from '../../hooks/services/scan'

test('on macOS, ps and lsof read into processes and ports, and npm → sh -c → node is one service while the engine and its MCP server are not', () => {
  const all = parseMacScan(MAC_SCAN_OUT)
  expect(all.self).toEqual([900, 100, 80, 1])
  expect(all.ports).toEqual([
    { port: 5173, pid: 13 },
    { port: 9999, pid: 30 },
  ])
  // 執行檔路徑有空白也切得開；登入 shell 的 - 拿掉。
  expect(all.procs.find(p => p.pid === 100)?.name).toBe('claude')
  expect(all.procs.find(p => p.pid === 10)?.name).toBe('zsh')
  // lstart 是本地時間（+8），換算回 epoch。
  expect(all.procs.find(p => p.pid === 11)?.started).toBe(MAC_EPOCH * 1000 - 40 * 60_000)
  const want = wantedPids(all)
  expect(want).toEqual([10, 11, 12, 13, 30, 80, 100, 900])
  const files = parseMacFiles(MAC_FILES_OUT)
  expect(files.get(11)).toEqual({ cwd: `${MAC_ROOT}/web`, exe: '/Users/me/.nvm/versions/node/v24.14.0/bin/node' })
  const services = findServices(withFiles(all, want, files, parseMacArgs(MAC_ARGS_OUT)), MAC_ROOT)
  expect(services).toHaveLength(1)
  expect(services[0]).toMatchObject({ pid: 11, tool: 'npm', name: 'web', command: 'npm run dev', dir: `${MAC_ROOT}/web`, ports: [5173] })
})

test('isShellSafe lets plain commands through and stops anything sh would read differently', () => {
  expect(isShellSafe('npm run dev')).toBe(true)
  expect(isShellSafe('node /Users/me/專案/web/server.js --port=5173')).toBe(true)
  expect(isShellSafe('node server.js --banner $(whoami)')).toBe(false)
  expect(isShellSafe('sh -c vite; rm -rf x')).toBe(false)
  expect(isShellSafe('echo "hi"')).toBe(false)
  expect(isShellSafe('ls *')).toBe(false)
})
