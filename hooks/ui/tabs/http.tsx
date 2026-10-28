import type { RenderChildren } from 'claude-code'

import type { HttpDraft, HttpRequest, HttpResult } from '../../../types'
import { FOLDER_COLOR, HTTP_PAGES, NBSP, NEW_FOLDER } from '../../config'
import { formatSize } from '../../files/list'
import { braced, fileTitle, folderOf, httpFolders, promptNames, requestTitle, substitute, variableNames, variableSource, variableValue } from '../../http/parse'
import { filterWords, hasQuery } from '../../search'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// Environment 三層：環境清單 → 點一個環境（選它給 Run 用）看它的變數、機密、@capture 取到的 → 點一個變數改名稱和值。
// 手機版沒有輸入框，不能編輯、貼不了機密。
export const httpTab: TabBody = ctx => {
  const { w, d } = ctx
  const { Text } = w
  const hv = d.http
  if (!hv.isLoaded) return <Text dimColor>Loading…</Text>

  return hv.page === 'env' ? envPage(ctx) : hv.draft !== null ? editPage(ctx, hv.draft) : hv.open === '' ? requestList(ctx) : requestView(ctx)
}

// API | Environment 那排：panel.tsx 畫在子分頁列正下方（同 Git 的子分頁列，中間不空行），分隔線由它畫。
export const httpPageBar = ({ w, d, a }: TabContext) => w.iconBar('http:page', HTTP_PAGES, d.http.page, id => a.selectHttpPage(id))

const MASK = '••••••'

// API 這邊只寫目前的環境，換環境到 Environment。
function envLine({ w, d }: TabContext) {
  const { Text } = w
  const hv = d.http

  return hv.env === '' ? null : <Text dimColor>{`Env: ${hv.env}`}</Text>
}

// 編輯頁左邊的標題欄寬（Folder 最長）。
const LABEL_WIDTH = 7

// 編輯頁的一行（也是 Environment 改變數的那兩行）：左邊固定寬的標題，右邊撐滿。
function formLine({ w }: TabContext, label: string, node: RenderChildren) {
  const { Box, Text } = w

  return (
    <Box gap={1} alignItems="flex-start">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {node}
      </Box>
    </Box>
  )
}

// 「▸ Headers (2)」：點了原地展開、收起（回應的 Headers）。
function foldButton({ w }: TabContext, key: string, label: string, count: number, isOpen: boolean, onToggle: (isOpen: boolean) => unknown) {
  const { Box, Button } = w

  return (
    <Box>
      <Button key={key} label={`${isOpen ? '▾' : '▸'} ${label} (${count})`} plain onPress={w.press(() => onToggle(!isOpen))} />
    </Box>
  )
}

// 編輯：一個請求一個檔，Folder、Name 就是它的資料夾和檔名（不寫 .http），改了存的時候搬檔；檔案裡有好幾個請求的只寫是哪個檔。
// 那段（### …）的原文只畫出來，按 Edit in vim 在新視窗的 vim 裡改，存了就跟到這裡。Name 按 Enter 或 Save 寫檔，Cancel 不寫。
function editor(ctx: TabContext, draft: HttpDraft, r: HttpRequest | undefined) {
  const { w, d, a } = ctx
  const { Box, Button, Code, Text } = w
  const isOwnFile = r?.isOwnFile ?? true
  const { isNewFolder } = draft
  const folders = httpFolders(d.http.requests)
  if (!isNewFolder && draft.folder !== '' && !folders.includes(draft.folder)) folders.push(draft.folder)

  return (
    <Box flexDirection="column" gap={1}>
      {isOwnFile &&
        formLine(
          ctx,
          'Folder',
          // 開合記在草稿；選了 select 自己收起。
          w.select('http:draft:folder', {
            value: isNewFolder ? NEW_FOLDER : draft.folder,
            options: [{ value: '', label: '(None)' }, ...folders.map(f => ({ value: f, label: f })), { value: NEW_FOLDER, label: '+ New folder' }],
            onSelect: folder => a.pickHttpFolder(folder),
            isOpen: draft.isPickingFolder,
            onToggle: isOpen => a.openHttpFolderPicker(isOpen),
          }),
        )}
      {isOwnFile &&
        isNewFolder &&
        formLine(
          ctx,
          '',
          w.field('http:draft:new-folder', {
            placeholder: 'New folder, like 會員',
            value: draft.folder,
            submitLabel: '',
            onInput: folder => a.typeHttpDraft({ folder }),
            onSubmit: folder => a.typeHttpDraft({ folder }),
          }),
        )}
      {isOwnFile ? (
        formLine(
          ctx,
          'Name',
          w.field('http:draft:file', {
            placeholder: 'Like login',
            value: fileTitle(draft.file),
            submitLabel: 'Save',
            onInput: file => a.typeHttpDraft({ file }),
            onSubmit: async file => {
              await a.typeHttpDraft({ file })
              await a.saveHttpDraft()
            },
          }),
        )
      ) : (
        <Text dimColor>{[draft.folder, fileTitle(draft.file)].filter(x => x !== '').join(' / ')}</Text>
      )}
      <Code source={draft.text} path="request.http" startLine={1} />
      {d.httpBusy === 'draft' ? (
        <Text dimColor>Saving…</Text>
      ) : (
        <Box gap={1} justifyContent="center">
          <Button key="http:draft:vim" label={d.httpVim ? 'Editing in vim…' : 'Edit in vim'} onPress={w.press(() => a.editHttpInVim())} />
          <Button key="http:draft:save" label="Save" variant="primary" onPress={w.press(() => a.saveHttpDraft())} />
          <Button key="http:draft:cancel" label="Cancel" onPress={w.press(() => a.closeHttpRequest())} />
        </Box>
      )}
      {d.http.draftError !== '' && <Text color="error">{d.http.draftError}</Text>}
    </Box>
  )
}

function requestList(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const hv = d.http
  const row = (r: HttpRequest, indent?: number) => {
    const title = requestTitle(r)

    return w.pressRow({
      key: `http:req:${r.id}`,
      label: title,
      indent,
      isTruncated: true,
      rest: title !== `${r.method} ${r.url}` && <Text dimColor>{r.method}</Text>,
      trailing: <Button key={`http:run:${r.id}`} label="Run" onPress={w.press(() => a.runHttpRequest(r.id))} />,
      onPress: () => a.openHttpRequest(r.id),
    })
  }
  // 一個資料夾（或 .soap/http 本身）的請求：一個檔一個請求的一列就是名稱；有好幾個請求的檔案，檔名當標題、底下一列一個。
  const block = (requests: HttpRequest[], indent: number) => {
    const groups = [...new Set(requests.filter(r => !r.isOwnFile).map(r => r.file))]

    return [
      ...requests.filter(r => r.isOwnFile).map(r => row(r, indent)),
      ...groups.map(file => (
        <Box key={`http:file:${file}`} flexDirection="column" paddingLeft={indent}>
          <Text bold dimColor>{fileTitle(file)}</Text>
          {requests.filter(r => r.file === file).map(r => row(r))}
        </Box>
      )),
    ]
  }
  const isSearching = hasQuery(hv.query)
  const shown = filterWords(hv.requests, hv.query, r => `${requestTitle(r)} ${r.method} ${r.url} ${r.file}`)
  const byFolder = new Map<string, HttpRequest[]>()
  for (const r of shown) {
    const folder = folderOf(r.file)
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), r])
  }
  const inFolder = (folder: string) => byFolder.get(folder) ?? []

  return (
    <Box flexDirection="column" gap={1}>
      {hv.error !== '' && <Text color="error">{hv.error}</Text>}
      <Box gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          {envLine(ctx)}
        </Box>
        <Button key="http:open" label="Open" onPress={w.press(() => a.openHttpDir())} />
        <Button key="http:new" label="+ New" onPress={w.press(() => a.newHttpRequest())} />
      </Box>
      {hv.requests.length > 0 && w.searchField('http:search', hv.query, text => a.searchHttp(text))}
      {hv.requests.length === 0 ? (
        <Text dimColor>No requests yet.</Text>
      ) : shown.length === 0 ? (
        <Text dimColor>No requests match.</Text>
      ) : (
        // 資料夾在上面，「▾ 會員 (2)」整列點了收起（記著），顏色同 Files、Wiki 的資料夾；沒放資料夾的在最下面。
        <Box flexDirection="column">
          {httpFolders(shown).map(folder => {
            const isFolded = !isSearching && hv.foldedFolders.includes(folder)

            return (
              <Box key={`http:folder:${folder}:box`} flexDirection="column">
                {w.pressRow({
                  key: `http:folder:${folder}`,
                  label: `${isFolded ? '▸' : '▾'} ${folder} (${inFolder(folder).length})`,
                  color: FOLDER_COLOR,
                  indent: 0,
                  onPress: () => a.foldHttpFolder(folder, !isFolded),
                })}
                {!isFolded && block(inFolder(folder), 2)}
              </Box>
            )
          })}
          {block(inFolder(''), 0)}
        </Box>
      )}
    </Box>
  )
}

// 環境檔沒有、還沒 capture 到的變數：存了的寫 saved（Change、垃圾桶），沒存的直接畫貼值的框。
function secretRows({ w, d, a }: TabContext, names: string[]) {
  const { Box, Button, Text } = w
  const hv = d.http
  if (names.length === 0) return null

  const row = (name: string) => {
    const isSaved = hv.secrets.includes(name)
    const isEditing = hv.editing === name

    return (
      <Box key={`http:var:${name}:box`} flexDirection="column">
        <Box gap={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1} gap={1}>
            <Text bold>{`{{${name}}}`}</Text>
            <Text color={isSaved ? 'success' : 'warning'}>{isSaved ? 'saved' : 'no value'}</Text>
          </Box>
          {isSaved && !isEditing && (
            <Box flexShrink={0} gap={1} alignItems="center">
              <Button key={`http:var:change:${name}`} label="Change" onPress={w.press(() => a.editHttpSecret(name))} />
              {w.deleteButton(`http:var:delete:${name}`, d.armed === `http:secret:${hv.env}:${name}`, () => a.deleteHttpSecret(name))}
            </Box>
          )}
        </Box>
        {(!isSaved || isEditing) &&
          (d.httpBusy === 'secret' ? (
            <Text dimColor>Saving…</Text>
          ) : (
            <Box gap={1} alignItems="center" flexWrap="wrap">
              {w.field(`http:var:${name}`, {
                placeholder: `Paste the value of {{${name}}}${hv.env === '' ? '' : ` for ${hv.env}`}`,
                value: '',
                submitLabel: 'Save',
                onSubmit: text => a.saveHttpSecret(name, text),
              })}
              {isEditing && <Button key={`http:var:cancel:${name}`} label="Cancel" onPress={w.press(() => a.editHttpSecret(''))} />}
            </Box>
          ))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold dimColor>Secrets</Text>
      {names.map(row)}
      {hv.secretError !== '' && <Text color="error">{hv.secretError}</Text>}
    </Box>
  )
}

function resultView(ctx: TabContext, res: HttpResult) {
  const { w, d, a } = ctx
  const { Box, Code, Text } = w
  const isOk = res.status >= 200 && res.status < 300
  const isOpen = d.http.showHeaders

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        <Text bold color={isOk ? 'success' : 'error'}>{String(res.status)}</Text>
        <Text dimColor>{`${res.ms} ms · ${formatSize(res.size)}`}</Text>
      </Box>
      {res.captured.length > 0 && <Text color="success">{`Captured ${braced(res.captured)}`}</Text>}
      {res.missed.length > 0 && <Text color="warning">{`Not in the response, not captured: ${braced(res.missed)}`}</Text>}
      <Box flexDirection="column">
        {foldButton(ctx, 'http:headers', 'Headers', res.headers.length, isOpen, open => a.toggleHttpHeaders(open))}
        {isOpen &&
          res.headers.map((x, i) => (
            <Box key={`http:res-header:${i}`} gap={1} paddingLeft={2}>
              <Text dimColor>{`${x.name}:`}</Text>
              <Text>{x.value}</Text>
            </Box>
          ))}
      </Box>
      {res.body === '' ? <Text dimColor>No body.</Text> : <Code source={res.body} path={res.isJson ? 'response.json' : 'response.txt'} startLine={1} />}
      {res.isTruncated && <Text dimColor>The body is too long; showing only the beginning.</Text>}
    </Box>
  )
}

// 編輯頁（點清單的一列、+ New）：Back 不存回清單，右上垃圾桶（按兩次）刪掉這個請求。
function editPage(ctx: TabContext, draft: HttpDraft) {
  const { w, d, a } = ctx
  const { Box, Text } = w
  const hv = d.http
  const r = draft.kind === 'request' ? hv.requests.find(x => x.id === draft.id) : undefined

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'http', () => a.closeHttpRequest())}
        <Box flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{r === undefined ? 'New request' : requestTitle(r)}</Text>
        </Box>
        {r !== undefined && w.deleteButton('http:delete', d.armed === `http:request:${r.id}`, () => a.deleteHttpRequest())}
      </Box>
      {editor(ctx, draft, r)}
    </Box>
  )
}

// @prompt 的變數一個一格：打字跟著存（重開還在、每個環境共用），Enter 就送出；說明寫在右邊。
function promptFields({ w, d, a }: TabContext, r: HttpRequest) {
  const { Box, Text } = w
  if (r.prompts.length === 0) return null

  return (
    <Box flexDirection="column" gap={1}>
      {r.prompts.map(p => (
        <Box key={`http:prompt:${p.name}:box`} gap={1} alignItems="center">
          <Box flexShrink={0}>
            <Text bold>{p.name}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            {w.field(`http:prompt:${p.name}`, {
              placeholder: 'Value',
              value: d.http.prompted[p.name] ?? '',
              submitLabel: 'Run',
              onInput: value => a.typeHttpPrompt(p.name, value),
              onSubmit: async value => {
                await a.typeHttpPrompt(p.name, value)
                await a.sendHttp()
              },
            })}
          </Box>
          {p.description !== '' && (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">{p.description}</Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  )
}

// 回應頁（清單的 Run）：一行方法和 URL（環境的值代換好，機密畫成 ••••••）、Run 再送一次、Edit，底下是回應。
function requestView(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const hv = d.http
  const r: HttpRequest | undefined = hv.requests.find(x => x.id === hv.open)
  if (r === undefined) return null
  const prompts = promptNames([r])
  const sourceOf = (name: string) => variableSource(hv, d.httpCaptured, name, prompts)
  // 還沒有值的照寫 {{name}}。
  const show = (text: string) =>
    substitute(text, name => {
      const source = sourceOf(name)

      return source === 'secret' ? MASK : variableValue(hv, d.httpCaptured, name, source)
    })
  const missing = variableNames(r).filter(n => sourceOf(n) === 'missing')
  const res = hv.result?.id === r.id ? hv.result : null

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'http', () => a.closeHttpRequest())}
        <Box flexGrow={1} flexShrink={1} gap={1}>
          <Text bold wrap="truncate-end">{requestTitle(r)}</Text>
          {!r.isOwnFile && <Text dimColor wrap="truncate-start">{fileTitle(r.file)}</Text>}
        </Box>
        <Box flexShrink={0} gap={1} alignItems="center">
          <Button key="http:edit" label="Edit" onPress={w.press(() => a.editHttpRequest())} />
          {w.deleteButton('http:delete', d.armed === `http:request:${r.id}`, () => a.deleteHttpRequest())}
        </Box>
      </Box>
      {envLine(ctx)}
      <Box gap={1}>
        <Text bold color="suggestion">{r.method}</Text>
        <Text wrap="truncate-end">{show(r.url)}</Text>
      </Box>
      {promptFields(ctx, r)}
      {missing.length > 0 && (
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Text color="warning">{`No value for ${braced(missing)}: paste it under`}</Text>
          <Button key="http:to-env" label="Environment" onPress={w.press(() => a.openHttpEnv(hv.env))} />
        </Box>
      )}
      <Box justifyContent="center">
        {d.httpBusy === 'send' ? <Text dimColor>Sending…</Text> : <Button key="http:send" label="Run" hotkey="s" onPress={w.press(() => a.sendHttp())} />}
      </Box>
      {hv.sendError !== '' && <Text color="error">{hv.sendError}</Text>}
      {res !== null && w.divider}
      {res !== null && resultView(ctx, res)}
    </Box>
  )
}

// Environment：選環境、環境檔的變數、機密（請求用到、環境檔沒有的變數，加上存了但已經沒用到的，好刪掉）、@capture 取到的值。
function envPage(ctx: TabContext) {
  const hv = ctx.d.http
  if (!hv.isEnvOpen || hv.env === '') return envList(ctx)

  return hv.varDraft === null ? envView(ctx) : varEditor(ctx, hv.varDraft)
}

// 第一層：環境清單，同 API 的請求清單；前面一個方塊，用中的綠色、其他灰色。右上 + New 打開名稱的框（置中，下面 Add、Cancel）。
function envList(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const hv = d.http

  return (
    <Box flexDirection="column" gap={1}>
      {hv.envError !== '' && <Text color="error">{hv.envError}</Text>}
      <Box gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          <Text bold dimColor>Environments</Text>
        </Box>
        {!hv.isAddingEnv && <Button key="http:env-add" label="+ New" onPress={w.press(() => a.openAddHttpEnv(true))} />}
      </Box>
      {hv.isAddingEnv && (
        <Box flexDirection="column" gap={1} alignItems="center">
          {w.field('http:new-env', {
            placeholder: 'Environment name (like dev)',
            value: hv.newEnvName,
            submitLabel: 'Add',
            onInput: name => a.typeHttpEnvName(name),
            onSubmit: name => a.addHttpEnv(name),
          })}
          <Box gap={1} justifyContent="center">
            <Button key="http:new-env:add" label="Add" variant="primary" onPress={w.press(() => a.addHttpEnv())} />
            <Button key="http:new-env:cancel" label="Cancel" onPress={w.press(() => a.openAddHttpEnv(false))} />
          </Box>
        </Box>
      )}
      {hv.envs.length === 0 ? (
        !hv.isAddingEnv && <Text dimColor>No environments yet.</Text>
      ) : (
        <Box flexDirection="column">
          {hv.envs.map(env =>
            w.pressRow({
              key: `http:env:${env}`,
              label: env,
              indent: 0,
              isTruncated: true,
              lead: env === hv.env ? <Text color="success">■</Text> : <Text dimColor>■</Text>,
              trailing: w.deleteButton(`http:env-delete:${env}`, d.armed === `http:env:${env}`, () => a.deleteHttpEnv(env)),
              onPress: () => a.openHttpEnv(env),
            }),
          )}
        </Box>
      )}
      {hv.envFormError !== '' && <Text color="error">{hv.envFormError}</Text>}
    </Box>
  )
}

// 一列一個變數，key 和 value（名稱補空白對齊同一欄寬），跟標題對齊不內縮。整列是同一顆按鈕、撐滿寬度，垃圾桶（按兩次）貼最右邊；
// 自己的變數點了改，只列出來的是淡色。
function varRows(
  { w, d }: TabContext,
  prefix: string,
  vars: [string, string][],
  actions?: { onPress: (name: string) => unknown; onDelete: (name: string) => unknown },
) {
  const width = Math.min(24, Math.max(0, ...vars.map(([name]) => name.length)) + 2)

  return vars.map(([name, value]) =>
    w.pressRow({
      key: `${prefix}:${name}`,
      label: `${name}${NBSP.repeat(Math.max(1, width - name.length))}${value}`,
      indent: 0,
      isTruncated: true,
      isDim: actions === undefined,
      trailing: actions && w.deleteButton(`http:var-delete:${name}`, d.armed === `http:var:${d.http.env}:${name}`, () => actions.onDelete(name)),
      onPress: () => actions?.onPress(name),
    }),
  )
}

// 第二層：點開的環境。它的變數（右上 + New，點一列改），$shared 的（只列出來），機密（在這裡貼），@capture 取到的。
function envView(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const hv = d.http
  // @prompt 的在請求那頁填，不列成要貼的機密。
  const prompts = promptNames(hv.requests)
  const isSecret = (name: string) => ['secret', 'missing'].includes(variableSource(hv, d.httpCaptured, name, prompts))
  const secrets = [...new Set([...hv.requests.flatMap(variableNames), ...hv.secrets])].filter(isSecret).sort()
  const own = Object.entries(hv.ownVars)
  // $shared 的（這個環境沒有自己蓋掉的）。
  const shared = Object.entries(hv.vars).filter(([name]) => !Object.hasOwn(hv.ownVars, name))
  const captured = Object.entries(d.httpCaptured)

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'http:env', () => a.closeHttpEnv())}
        <Box flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">{hv.env}</Text>
        </Box>
        <Button key="http:var-new" label="+ New" onPress={w.press(() => a.newHttpVar())} />
      </Box>
      {hv.envError !== '' && <Text color="error">{hv.envError}</Text>}
      {hv.envFormError !== '' && <Text color="error">{hv.envFormError}</Text>}
      {own.length === 0 ? <Text dimColor>No variables yet.</Text> : <Box flexDirection="column">{varRows(ctx, 'http:var-row', own, { onPress: name => a.editHttpVar(name), onDelete: name => a.deleteHttpVar(name) })}</Box>}
      {shared.length > 0 && (
        <Box flexDirection="column">
          <Text bold dimColor>Shared ($shared)</Text>
          {varRows(ctx, 'http:shared', shared)}
        </Box>
      )}
      {secretRows(ctx, secrets)}
      {captured.length > 0 && (
        <Box flexDirection="column">
          <Text bold dimColor>Captured</Text>
          {varRows(ctx, 'http:captured', captured)}
          <Text dimColor>From responses, kept until the plugin reloads.</Text>
        </Box>
      )}
    </Box>
  )
}

// 第三層：新增、修改一個變數，名稱、值兩行的框；任一格 Enter 或 Save 寫檔，Cancel、Back 不寫。修改時右上有垃圾桶（按兩次）。
function varEditor(ctx: TabContext, draft: { from: string; name: string; value: string }) {
  const { w, a, d } = ctx
  const { Box, Button, Text } = w
  const hv = d.http
  const line = (label: string, field: RenderChildren) => formLine(ctx, label, field)

  return (
    <Box flexDirection="column" gap={1}>
      <Box gap={1} alignItems="center">
        {backButton(w, w.press, 'http:var', () => a.cancelHttpVar())}
        <Box flexGrow={1} />
        {draft.from !== '' && w.deleteButton(`http:var-delete:${draft.from}`, d.armed === `http:var:${hv.env}:${draft.from}`, () => a.deleteHttpVar(draft.from))}
      </Box>
      {line(
        'Name',
        w.field('http:var-draft:name', {
          placeholder: 'host',
          value: draft.name,
          submitLabel: 'Save',
          onInput: name => a.typeHttpVar({ name }),
          onSubmit: name => a.saveHttpVar({ name }),
        }),
      )}
      {line(
        'Value',
        w.field('http:var-draft:value', {
          placeholder: 'http://localhost:3000',
          value: draft.value,
          submitLabel: 'Save',
          onInput: value => a.typeHttpVar({ value }),
          onSubmit: value => a.saveHttpVar({ value }),
        }),
      )}
      <Box gap={1} justifyContent="center">
        <Button key="http:var-draft:save" label="Save" variant="primary" onPress={w.press(() => a.saveHttpVar())} />
        <Button key="http:var-draft:cancel" label="Cancel" onPress={w.press(() => a.cancelHttpVar())} />
      </Box>
      {hv.envFormError !== '' && <Text color="error">{hv.envFormError}</Text>}
    </Box>
  )
}
