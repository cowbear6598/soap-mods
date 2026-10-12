import { expect, test } from 'claude-code/testing'

import { MAC_EPOCH, MAC_FILES_OUT, MAC_PPIDS_OUT, MAC_ROOT, MAC_SCAN_OUT } from '../test-fixtures'
import { descendants, parseMacFiles, parseMacScan, wantedPids, withFiles } from './mac'
import { findServices } from './scan'

test('parseMacScan reads processes, ports and the scanner chain from ps and lsof', () => {
  const scan = parseMacScan(MAC_SCAN_OUT)
  expect(scan.self).toEqual([900, 100, 80, 1])
  expect(scan.ports).toEqual([
    { port: 5173, pid: 13 },
    { port: 9999, pid: 30 },
  ])
  const npm = scan.procs.find(p => p.pid === 11)
  expect(npm?.cmd).toBe('npm run dev')
  // 執行檔路徑有空白也切得開；登入 shell 的 - 拿掉。
  expect(scan.procs.find(p => p.pid === 100)?.name).toBe('claude')
  expect(scan.procs.find(p => p.pid === 10)?.name).toBe('zsh')
  // lstart 是本地時間（+8），換算回 epoch。
  expect(npm?.started).toBe(MAC_EPOCH * 1000 - 40 * 60_000)
  expect(wantedPids(scan)).toEqual([10, 11, 12, 13, 30, 80, 100, 900])
})

test('on macOS, npm → sh -c → node is one service, and the engine and its MCP server are not', () => {
  const all = parseMacScan(MAC_SCAN_OUT)
  const want = wantedPids(all)
  const files = parseMacFiles(MAC_FILES_OUT)
  expect(files.get(11)).toEqual({ cwd: `${MAC_ROOT}/web`, exe: '/Users/me/.nvm/versions/node/v24.14.0/bin/node' })
  const services = findServices(withFiles(all, want, files), MAC_ROOT)
  expect(services).toHaveLength(1)
  expect(services[0]).toMatchObject({ pid: 11, tool: 'npm', name: 'web', command: 'npm run dev', dir: `${MAC_ROOT}/web`, ports: [5173] })
})

test('descendants walks the whole tree under a pid', () => {
  expect(descendants(MAC_PPIDS_OUT, 11)).toEqual([11, 12, 13, 99])
  expect(descendants(MAC_PPIDS_OUT, 4242)).toEqual([4242])
})
