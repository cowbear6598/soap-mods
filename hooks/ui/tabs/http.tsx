import type { RenderChildren } from 'claude-code'

import type { HttpBodyKind, HttpDraft, HttpForm, HttpFormList, HttpRequest, HttpResult } from '../../../types'
import { FOLDER_COLOR, HTTP_PAGES, NBSP } from '../../config'
import { formatSize } from '../../files/list'
import { FORM_METHODS, NEW_FOLDER } from '../../http/form'
import { fileTitle, folderOf, httpFolders, requestTitle, substitute, variableNames, variableSource } from '../../http/parse'
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

// 更長的在框裡捲。
const EDITOR_ROWS = 14

// API 這邊只寫目前的環境，換環境到 Environment。
function envLine({ w, d }: TabContext) {
  const { Text } = w
  const hv = d.http

  return hv.env === '' ? null : <Text dimColor>{`Env: ${hv.env}`}</Text>
}

// 表單左邊的標題欄寬（Method 最長）。
const LABEL_WIDTH = 7

const JSON_ROWS = 10

const BODY_KINDS: { value: HttpBodyKind; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'json', label: 'JSON' },
  { value: 'form', label: 'Form' },
  { value: 'multipart', label: 'Multipart' },
]

const FIELD_ROW = { noun: 'Field', name: 'Name', value: 'Value' }

// 表單的一行（也是 Environment 改變數的那兩行）：左邊固定寬的標題，右邊撐滿。
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

// 「▸ Headers (2)」：點了原地展開、收起（表單的 Headers、Capture，回應的 Headers）。
function foldButton({ w }: TabContext, key: string, label: string, count: number, isOpen: boolean, onToggle: (isOpen: boolean) => unknown) {
  const { Box, Button } = w

  return (
    <Box>
      <Button key={key} label={`${isOpen ? '▾' : '▸'} ${label} (${count})`} plain onPress={w.press(() => onToggle(!isOpen))} />
    </Box>
  )
}

// 一列一組名稱和值（header、form 欄位、multipart 欄位、capture）：名稱的框固定寬，值撐滿，✕ 拿掉這列；最後一顆 + 加一列。
// multipart 中間多一顆 Text／File 切換，File 的值是檔案路徑（相對那個 .http 檔所在的資料夾）。
function formRows(
  { w, a }: TabContext,
  list: HttpFormList,
  rows: readonly { name: string; value: string; isFile?: boolean }[],
  props: { noun: string; name: string; value: string; file?: string },
) {
  const { Box, Button } = w

  return (
    <Box flexDirection="column" gap={1}>
      {rows.map((r, i) => (
        <Box key={`http:draft:${list}:${i}`} gap={1} alignItems="center" flexWrap="wrap">
          {w.field(`http:draft:${list}:${i}:name`, {
            placeholder: props.name,
            value: r.name,
            submitLabel: '',
            isFixed: true,
            onInput: name => a.changeHttpRow(list, i, { name }),
            onSubmit: name => a.changeHttpRow(list, i, { name }),
          })}
          {list === 'parts' && (
            <Button key={`http:draft:${list}:${i}:kind`} label={r.isFile === true ? 'File' : 'Text'} onPress={w.press(() => a.changeHttpRow(list, i, { isFile: r.isFile !== true }))} />
          )}
          <Box flexGrow={1} flexShrink={1}>
            {w.field(`http:draft:${list}:${i}:value`, {
              placeholder: r.isFile === true ? (props.file ?? props.value) : props.value,
              value: r.value,
              submitLabel: '',
              onInput: value => a.changeHttpRow(list, i, { value }),
              onSubmit: value => a.changeHttpRow(list, i, { value }),
            })}
          </Box>
          <Button key={`http:draft:${list}:${i}:delete`} label="✕" plain onPress={w.press(() => a.deleteHttpRow(list, i))} />
        </Box>
      ))}
      <Box>
        <Button key={`http:draft:${list}:add`} label={`+ ${props.noun}`} onPress={w.press(() => a.addHttpRow(list))} />
      </Box>
    </Box>
  )
}

// 收起來的一區（Headers、Capture），開合記在草稿。
function foldSection(ctx: TabContext, draft: HttpDraft, list: HttpFormList, label: string, rows: readonly { name: string }[], content: RenderChildren) {
  const { w, a } = ctx
  const isOpen = draft.unfolded.includes(list)
  const count = rows.filter(r => r.name.trim() !== '').length

  return (
    <w.Box flexDirection="column" gap={1}>
      {foldButton(ctx, `http:draft:fold:${list}`, label, count, isOpen, open => a.foldHttpDraft(list, open))}
      {isOpen && <w.Box paddingLeft={2}>{content}</w.Box>}
    </w.Box>
  )
}

// 表單的選單（Folder、Method、Body）：開合記在草稿；選了 select 自己收起。
function picker({ w, a }: TabContext, draft: HttpDraft, key: string, value: string, options: { value: string; label: string }[], onSelect: (value: string) => unknown) {
  return w.select(`http:draft:${key}`, { value, options, onSelect, isOpen: draft.unfolded.includes(key), onToggle: isOpen => a.foldHttpDraft(key, isOpen) })
}

function bodyEditor(ctx: TabContext, f: HttpForm, onSave: (json: string) => unknown) {
  const { w, a } = ctx
  if (f.bodyKind === 'json') {
    return w.field('http:draft:json', {
      placeholder: '{ "user": "{{user}}" }',
      value: f.json,
      submitLabel: 'Save',
      rows: JSON_ROWS,
      onInput: json => a.typeHttpForm({ json }),
      onSubmit: onSave,
    })
  }
  if (f.bodyKind === 'form') return formRows(ctx, 'form', f.form, FIELD_ROW)
  if (f.bodyKind === 'multipart') return formRows(ctx, 'parts', f.parts, { ...FIELD_ROW, file: 'Path, like ./avatar.png' })

  return null
}

// 表單：Method、URL、Headers（展開）、Body（種類 + 它的框或欄位）、Capture（展開）；showName 時最上面多一格 Name（### 後面那段，
// 檔案裡有好幾個請求的才有，其他的名稱是檔名）。Name、URL、JSON 按 Enter 就存。
function formEditor(ctx: TabContext, draft: HttpDraft, showName: boolean) {
  const { w, a } = ctx
  const f = draft.form
  const methods = FORM_METHODS.includes(f.method) ? FORM_METHODS : [...FORM_METHODS, f.method]
  const saveWith = async (change: Parameters<typeof a.typeHttpForm>[0]) => {
    await a.typeHttpForm(change)
    await a.saveHttpDraft()
  }

  return (
    <w.Box flexDirection="column" gap={1}>
      {showName &&
        formLine(
          ctx,
          'Name',
          w.field('http:draft:name', {
            placeholder: 'Optional, like Log in',
            value: f.name,
            submitLabel: 'Save',
            onInput: name => a.typeHttpForm({ name }),
            onSubmit: name => saveWith({ name }),
          }),
        )}
      {formLine(
        ctx,
        'Method',
        picker(
          ctx,
          draft,
          'method',
          f.method,
          methods.map(m => ({ value: m, label: m })),
          method => a.typeHttpForm({ method }),
        ),
      )}
      {formLine(
        ctx,
        'URL',
        w.field('http:draft:url', {
          placeholder: 'https://example.com/users or {{host}}/users',
          value: f.url,
          submitLabel: 'Save',
          onInput: url => a.typeHttpForm({ url }),
          onSubmit: url => saveWith({ url }),
        }),
      )}
      {foldSection(ctx, draft, 'headers', 'Headers', f.headers, formRows(ctx, 'headers', f.headers, { noun: 'Header', name: 'Authorization', value: 'Bearer {{token}}' }))}
      {formLine(
        ctx,
        'Body',
        picker(ctx, draft, 'body', f.bodyKind, BODY_KINDS, kind => a.typeHttpForm({ bodyKind: kind as HttpBodyKind })),
      )}
      {bodyEditor(ctx, f, json => saveWith({ json }))}
      {foldSection(ctx, draft, 'captures', 'Capture', f.captures, formRows(ctx, 'captures', f.captures, { noun: 'Capture', name: 'token', value: 'body.data.token' }))}
    </w.Box>
  )
}

// 編輯：表單，或一個請求那段（### …）的原文（表單留不住的請求一打開就是這個）。
// 一個請求一個檔：Folder、Name 就是它的資料夾和檔名（不寫 .http），改了存的時候搬檔；檔案裡有好幾個請求的只寫是哪個檔。
// Enter 或 Save 寫檔，Cancel 不寫；Edit raw／Form 在兩種之間換。
function editor(ctx: TabContext, draft: HttpDraft, r: HttpRequest | undefined) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const isOwnFile = r?.isOwnFile ?? true
  const isNewFolder = draft.unfolded.includes('new-folder')
  const folders = httpFolders(d.http.requests)
  if (!isNewFolder && draft.folder !== '' && !folders.includes(draft.folder)) folders.push(draft.folder)

  return (
    <Box flexDirection="column" gap={1}>
      {isOwnFile &&
        formLine(
          ctx,
          'Folder',
          picker(
            ctx,
            draft,
            'folder',
            isNewFolder ? NEW_FOLDER : draft.folder,
            [{ value: '', label: '(None)' }, ...folders.map(f => ({ value: f, label: f })), { value: NEW_FOLDER, label: '+ New folder' }],
            folder => a.pickHttpFolder(folder),
          ),
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
      {draft.isRaw
        ? w.field('http:draft:text', {
            placeholder: 'GET https://example.com',
            value: draft.text,
            submitLabel: 'Save',
            rows: EDITOR_ROWS,
            onInput: text => a.typeHttpDraft({ text }),
            onSubmit: text => a.saveHttpDraft(text),
          })
        : formEditor(ctx, draft, !isOwnFile)}
      {d.httpBusy === 'draft' ? (
        <Text dimColor>Saving…</Text>
      ) : (
        <Box gap={1} justifyContent="center">
          <Button key="http:draft:save" label="Save" variant="primary" onPress={w.press(() => a.saveHttpDraft())} />
          <Button key="http:draft:cancel" label="Cancel" onPress={w.press(() => a.closeHttpRequest())} />
          <Button key="http:draft:raw" label={draft.isRaw ? 'Form' : 'Edit raw'} onPress={w.press(() => a.rawHttpDraft(!draft.isRaw))} />
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
  const byFolder = new Map<string, HttpRequest[]>()
  for (const r of hv.requests) byFolder.set(folderOf(r.file), [...(byFolder.get(folderOf(r.file)) ?? []), r])
  const inFolder = (folder: string) => byFolder.get(folder) ?? []

  return (
    <Box flexDirection="column" gap={1}>
      {hv.error !== '' && <Text color="error">{hv.error}</Text>}
      <Box gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          {envLine(ctx)}
        </Box>
        <Button key="http:new" label="+ New" onPress={w.press(() => a.newHttpRequest())} />
      </Box>
      {hv.requests.length === 0 ? (
        <Text dimColor>No requests yet.</Text>
      ) : (
        // 資料夾在上面，「▾ 會員 (2)」整列點了收起（記著），顏色同 Files、Wiki 的資料夾；沒放資料夾的在最下面。
        <Box flexDirection="column">
          {httpFolders(hv.requests).map(folder => {
            const isFolded = hv.foldedFolders.includes(folder)

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
      {res.captured.length > 0 && <Text color="success">{`Captured ${res.captured.map(n => `{{${n}}}`).join(', ')}`}</Text>}
      {res.missed.length > 0 && <Text color="warning">{`Not in the response, not captured: ${res.missed.map(n => `{{${n}}}`).join(', ')}`}</Text>}
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

// 回應頁（清單的 Run）：一行方法和 URL（環境的值代換好，機密畫成 ••••••）、Run 再送一次、Edit，底下是回應。
function requestView(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Text } = w
  const hv = d.http
  const r: HttpRequest | undefined = hv.requests.find(x => x.id === hv.open)
  if (r === undefined) return null
  const sourceOf = (name: string) => variableSource(hv, d.httpCaptured, name)
  // 還沒有值的照寫 {{name}}。
  const show = (text: string) =>
    substitute(text, name => {
      const source = sourceOf(name)
      if (source === 'captured') return d.httpCaptured[name]
      if (source === 'env') return hv.vars[name]

      return source === 'secret' ? MASK : undefined
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
      {missing.length > 0 && (
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Text color="warning">{`No value for ${missing.map(n => `{{${n}}}`).join(', ')}: paste it under`}</Text>
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
  const sourceOf = (name: string) => variableSource(hv, d.httpCaptured, name)
  const used = new Set([...hv.requests.flatMap(variableNames), ...hv.secrets])
  const secrets = [...used].filter(n => sourceOf(n) === 'secret' || sourceOf(n) === 'missing').sort()
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
