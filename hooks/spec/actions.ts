// Spec 分頁（.soap/tasks/<feature>/plan.yaml）的動作：列 feature、看計劃、Do、刪除，和檢查 Claude 寫的 plan.yaml。
// 不碰 $ 和 atom，用 register.tsx 給的 SpecIo（見 io.ts）。

import type { SpecEntry, SpecView } from '../../types'
import { SPEC_DIR } from '../config'
import { EMPTY_PLAN } from '../defaults'
import { errorText } from '../errors'
import { absPath } from '../files/list'
import { isPromptSafePath } from '../git/parse'
import type { Io } from '../io'
import { latestOnly } from '../latest'
import { type ArmSlot, isConfirmed, removePath } from '../shell'
import { planFixNote, planPath, readPlan, sortSpecs } from './parse'

export type SpecIo = Io & {
  getSpec: () => Promise<SpecView>
  setSpec: (change: Partial<SpecView>) => Promise<void>
}

// 連點兩個 feature、讀到一半按了 Back，晚到的舊清單、舊計劃不寫。
const specLoads = latestOnly()
const planReads = latestOnly()

// 列出 .soap/tasks 底下的 feature 資料夾，每個看它的 plan.yaml 改過的時間（最新的排上面）。
// 還沒有 .soap/tasks 是還沒寫過計劃，不是錯誤：列不出來時才看它在不在。
async function loadSpecs(io: SpecIo) {
  const isStale = specLoads.start()
  const root = await io.root()
  const dir = `${root}/${SPEC_DIR}`
  const listed = await (async () => {
    const folders = (await io.list(dir)).filter(e => e.kind === 'dir')
    const specs = await Promise.all(
      folders.map(async (f): Promise<SpecEntry> => {
        const stat = await io.stat(`${root}/${planPath(f.name)}`).catch(() => undefined)
        const hasPlan = stat?.kind === 'file'

        return { name: f.name, mtimeMs: hasPlan ? stat.mtimeMs : 0, hasPlan }
      }),
    )

    return { specs: sortSpecs(specs), error: '' }
  })().catch(async (err: unknown) => ({
    specs: [],
    error: (await io.exists(dir).catch(() => true)) ? `Couldn't list ./${SPEC_DIR}: ${errorText(err)}` : '',
  }))
  if (isStale()) return
  await io.setSpec({ isLoaded: true, ...listed })
}

// 讀一份 plan.yaml 畫出來；格式哪裡不對一起列出來。畫面上已經是它、修改時間和大小都沒變就不讀（回合結束重讀時常常沒變）。
export async function openSpec(io: SpecIo, name: string) {
  const isStale = planReads.start()
  const prev = await io.getSpec()
  const path = planPath(name)
  const shown = await (async () => {
    const full = absPath(await io.root(), path)
    const stat = await io.stat(full)
    const stamp = `${stat.mtimeMs}:${stat.size}`
    if (prev.open === name && prev.stamp === stamp) return null

    return { ...readPlan(await io.readFile(full)), stamp }
  })().catch((err: unknown) => ({ plan: EMPTY_PLAN, problems: [`Couldn't read ${path}: ${errorText(err)}`], stamp: '' }))
  if (isStale() || shown === null) return
  await io.setSpec({ open: name, ...shown })
  if (prev.open !== name) await io.scrollTop()
}

export async function closeSpec(io: SpecIo) {
  planReads.drop()
  await io.setSpec({ open: '', plan: EMPTY_PLAN, problems: [], stamp: '' })
  await loadSpecs(io)
}

// Spec 分頁看得到的那個：清單，或打開的計劃（清單這時畫不到，不用重列）。
export async function reloadSpec(io: SpecIo) {
  const s = await io.getSpec()
  await (s.open === '' ? loadSpecs(io) : openSpec(io, s.open))
}

// Do：叫 Claude 照打開的那份 plan.yaml 做（像使用者自己打的一樣送出）。
// 格式不對的先不送，免得照著缺東缺西的計劃做；資料夾名稱有反引號、控制字元的也不送（會弄壞提示裡的路徑）。
export async function doSpec(io: SpecIo) {
  const s = await io.getSpec()
  if (s.open === '') return
  const path = planPath(s.open)
  if (s.problems.length > 0) return void io.toast(`Fix ${path} first: ${s.problems[0]}`)
  if (!isPromptSafePath(path)) return void io.toast('Do is off for this plan: its folder name has a backtick or a control character.')
  await io.submit({
    text: `Implement the plan in \`${path}\`. Read it first, then reach every item under goals, keep to the constraints, start from the related files, and finish by running every verify command until each one passes.`,
    asUser: true,
  })
  io.toast('Sent to Claude')
}

const specArm: ArmSlot = {}

// 刪 Spec 要按兩次：垃圾桶按了換成打勾，DELETE_ARM_MS 內再按才刪掉整個 .soap/tasks/<feature>/；按別的垃圾桶，原本的就收回。
// 名稱是 fs.list 列出來的資料夾名稱，含斜線的不刪（不是一個 feature 資料夾）；空的、. 和 .. 由 removePath 擋。
export async function deleteSpec(io: SpecIo, name: string) {
  const arm = () => io.setSpec({ deleteArmed: name, deleteError: '' })
  if (!(await isConfirmed(io, specArm, (await io.getSpec()).deleteArmed === name, arm, () => io.setSpec({ deleteArmed: '' })))) return
  await io.setSpec({ deleteArmed: '' })
  try {
    if (/[\\/]/.test(name)) throw new Error('not a feature folder name')
    await removePath(io, `${await io.root()}/${SPEC_DIR}/${name}`)
  } catch (err) {
    await io.setSpec({ deleteError: `Couldn't delete ${name}: ${errorText(err)}` })
    await loadSpecs(io)

    return
  }
  await io.leaveRow()
  await io.setSpec({ deleteError: '' })
  await loadSpecs(io)
}

// Claude 用 Write／Edit 寫了 .soap/tasks/<feature>/plan.yaml：寫完讀回整份檢查格式，
// 不對就把哪裡不對塞進工具結果後面（只有 Claude 看得到，它會自己修），也跳個 toast 讓人知道。
// Edit 只帶改的那一段，所以不在寫之前擋，寫完看整份。
export async function checkPlanWrite(io: Io, path: string) {
  const { problems } = readPlan(await io.readFile(path))
  if (problems.length === 0) return undefined
  void io.toast(`plan.yaml has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems[0]}`)

  return planFixNote(path, problems)
}
