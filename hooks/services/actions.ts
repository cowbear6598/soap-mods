// Services 分頁的動作：掃這個資料夾跑著的服務，停掉、重跑。Windows 用 PowerShell，macOS 用 ps、lsof、kill。
// 不碰 $ 和 atom，用 register.tsx 給的 ServicesIo（見 io.ts）。

import type { ScanResult, Service, ServiceAction, ServicePending, ServicesView } from '../../types'
import { RESTART_CHECK_MS, RESTART_GAP_MS } from '../config'
import { errorText, failure, isMissingCommand } from '../errors'
import type { Io } from '../io'
import { coalesce } from '../latest'
import { busyFlag, isConfirmed, isWindows, runOk } from '../shell'
import {
  MAC_ENV,
  MAC_LAUNCH_ARGV,
  MAC_PPIDS_ARGV,
  MAC_SCAN_ARGV,
  descendants,
  isShellSafe,
  macArgsArgv,
  macFilesArgv,
  parseMacArgs,
  parseMacFiles,
  parseMacScan,
  wantedPids,
  withFiles,
} from './mac'
import { KILL_ARGV, LAUNCH_ARGV, SCAN_ARGV, findServices } from './scan'

export type ServicesIo = Io & {
  setServices: (change: Partial<ServicesView>) => Promise<void>
}

async function scanWindows(io: ServicesIo) {
  const r = await runOk(io, SCAN_ARGV, 'Process scan')

  return JSON.parse(r.stdout) as ScanResult
}

// 先用 ps 列出所有程序和 port，再只對用得到的程序讀工作目錄、執行檔和指令。
async function scanMac(io: ServicesIo) {
  const r = await runOk(io, MAC_SCAN_ARGV, 'Process scan', { env: MAC_ENV })
  const all = parseMacScan(r.stdout)
  const want = wantedPids(all)
  // 有讀不到的程序（root 跑的）lsof 會回 1、剛結束的程序 ps 會回 1，照樣用讀到的。
  const [files, args] = await Promise.all([
    io.run(macFilesArgv(want), { env: MAC_ENV }),
    io.run(macArgsArgv(want), { env: MAC_ENV }),
  ])

  return withFiles(all, want, parseMacFiles(files.stdout), parseMacArgs(args.stdout))
}

// 掃一次：這個資料夾的服務，和目前所有活著的 PID（重跑後的檢查用）。
async function scan(io: ServicesIo) {
  const [result, cwd] = await Promise.all([(await isWindows(io)) ? scanWindows(io) : scanMac(io), io.root()])

  return { items: findServices(result, cwd), alive: new Set(result.pids) }
}

// 砍整棵程序樹。子孫要比父程序晚開才算（PID 被重用的不算），兩邊都一樣：
// Windows 交給 KILL_ARGV 的 PowerShell，macOS 先用 ps 找出子孫再一起 kill -9。
async function killTree(io: ServicesIo, pid: number) {
  if (await isWindows(io)) {
    await runOk(io, KILL_ARGV, 'Stop', { env: { SOAP_PID: String(pid) } })

    return
  }
  const ps = await runOk(io, MAC_PPIDS_ARGV, 'ps', { env: MAC_ENV })
  const kill = await io.run(['kill', '-9', ...descendants(ps.stdout, pid).map(String)])
  // 樹裡有程序剛好自己先結束（No such process）不算失敗。
  const errors = kill.stderr.split('\n').filter(l => l.trim() !== '' && !/no such process/i.test(l))
  if (kill.exitCode !== 0 && errors.length > 0) throw failure(kill, 'kill')
}

// 掃到一半又被叫就掃完再補掃一次，畫面才不會停在舊的。
const serviceScans = coalesce()
// 上一次掃到的所有活著的 PID（重跑後的檢查用）；掃不了是 undefined。
let alivePids: Set<number> | undefined

// isQuiet：掃不了不在畫面上說（重跑後的檢查，下一個時間點再看）。
export function refreshServices(io: ServicesIo, isQuiet = false): Promise<void> {
  return serviceScans.run(async () => {
    try {
      const { items, alive } = await scan(io)
      alivePids = alive
      await io.setServices({ isLoaded: true, items, error: '' })
    } catch (err) {
      alivePids = undefined
      if (isQuiet) return
      await io.setServices({
        isLoaded: true,
        error: isMissingCommand(err) ? 'Services needs PowerShell on Windows, or ps and lsof on macOS.' : `Scan failed: ${errorText(err)}`,
      })
    }
  })
}

// 正在停掉／重跑的服務。跟 syncing 一樣放模組變數不放 atom，免得被熱重載中斷後那個 PID 的按鈕永遠按不動。
const servicePending = busyFlag<ServicePending[]>([])

export const pendingServices = servicePending.get

function setPending(io: ServicesIo, pid: number, action: ServiceAction | undefined) {
  servicePending.set(io, [...servicePending.get().filter(p => p.pid !== pid), ...(action === undefined ? [] : [{ pid, action }])])
}

// 停掉／重跑一個服務。動手前重新掃一次，確認還是同一個程序（PID 沒有被別人拿去用），才砍整棵程序樹。
export async function runServiceAction(io: ServicesIo, target: Service, action: ServiceAction) {
  if (servicePending.get().some(p => p.pid === target.pid)) return
  if (action === 'stop' && !isConfirmed(io, `svc:stop:${target.pid}`)) return
  setPending(io, target.pid, action)
  await io.setServices({ actionError: '' })
  try {
    const current = (await scan(io)).items.find(s => s.pid === target.pid && s.startedAt === target.startedAt)
    if (current === undefined) throw new Error(`${target.tool} · ${target.name} already exited.`)
    if (action === 'restart' && current.command === '') throw new Error(`Cannot read the command line of ${current.tool} · ${current.name}.`)
    if (action === 'restart' && !(await isWindows(io)) && !isShellSafe(current.command)) {
      throw new Error(`Cannot rerun ${current.tool} · ${current.name}: its command has quotes or shell characters that ps does not keep. Restart it yourself.`)
    }

    await killTree(io, current.pid)

    if (action === 'restart') {
      await io.sleep(RESTART_GAP_MS)
      const argv = (await isWindows(io)) ? LAUNCH_ARGV : MAC_LAUNCH_ARGV
      const launch = await runOk(io, argv, 'Restart', { env: { SOAP_CMD: current.command, SOAP_DIR: current.dir } })
      watchRestart(io, `${current.tool} · ${current.name}`, Number(launch.stdout.trim()))
      io.toast(`Restarted ${current.tool} · ${current.name}`)
    } else {
      io.toast(`Stopped ${current.tool} · ${current.name}`)
    }
  } catch (err) {
    await io.setServices({ actionError: `${action === 'stop' ? 'Stop' : 'Restart'} failed: ${errorText(err)}` })
  } finally {
    setPending(io, target.pid, undefined)
  }
  await refreshServices(io)
}

// 重跑後的檢查：每個時間點重掃一次（跟定時掃描共用，不會同時跑兩個），新程序已經不在了就算重跑失敗，
// 在面板上提示（沒存 log，原因要自己跑一次看）。掃不了就等下一個時間點。
function watchRestart(io: ServicesIo, name: string, pid: number) {
  let isDone = false
  for (const ms of RESTART_CHECK_MS) {
    io.after(ms, async () => {
      if (isDone) return
      await refreshServices(io, true)
      if (alivePids === undefined || alivePids.has(pid)) return
      isDone = true
      await io.setServices({ actionError: `Restart failed: ${name} exited right after starting. Run its command yourself to see why.` })
    })
  }
}
