import type { HttpDraft, HttpRequest, HttpResult } from '../../../types'
import { HTTP_PAGES } from '../../config'
import { formatSize } from '../../files/list'
import { requestTitle, substitute, variableNames, variableSource } from '../../http/parse'
import { backButton } from '../stepBar'
import type { TabBody, TabContext } from './context'

// Environment 三層：環境清單 → 點一個環境（選它給 Send 用）看它的變數、機密、@capture 取到的 → 點一個變數改名稱和值。
// 手機版沒有輸入框，不能編輯、貼不了機密。
export const httpTab: TabBody = ctx => {
  const { w, d } = ctx
  const { Text } = w
  const hv = d.http
  if (!hv.isLoaded) return <Text dimColor>Loading…</Text>

  return hv.page === 'env' ? envPage(ctx) : hv.open === '' ? requestList(ctx) : requestView(ctx)
}

// API | Environment 那排：panel.tsx 畫在子分頁列正下方（同 Git 的子分頁列，中間不空行），分隔線由它畫。
export const httpPageBar = ({ w, d, a }: TabContext) => w.iconBar('http:page', HTTP_PAGES, d.http.page, id => a.selectHttpPage(id))

const MASK = '••••••'
// 按鈕文字裡補齊欄寬用的空白：不斷行（同 widgets.tsx）。
const NBSP = ' '

// 更長的在框裡捲。
const EDITOR_ROWS = 14

// API 這邊只寫目前的環境，換環境到 Environment。
function envLine({ w, d }: TabContext) {
  const { Text } = w
  const hv = d.http

  return hv.env === '' ? null : <Text dimColor>{`Env: ${hv.env}`}</Text>
}

// 編輯框：一個請求那段（### …）的原文；新請求多一格檔名。Enter 或 Save 寫檔，Cancel 不寫。
function editor({ w, d, a }: TabContext, draft: HttpDraft) {
  const { Box, Button, Text } = w

  return (
    <Box flexDirection="column" gap={1}>
      {draft.kind === 'new' && (
        <Box gap={1} alignItems="center">
          <Text dimColor>File</Text>
          {w.field('http:draft:file', {
            placeholder: 'requests.http',
            value: draft.file,
            submitLabel: '',
            onInput: file => a.typeHttpDraft({ file }),
            onSubmit: () => undefined,
          })}
        </Box>
      )}
      {draft.kind === 'request' && <Text dimColor>{draft.file}</Text>}
      {w.field('http:draft:text', {
        placeholder: 'GET https://example.com',
        value: draft.text,
        submitLabel: 'Save',
        rows: EDITOR_ROWS,
        onInput: text => a.typeHttpDraft({ text }),
        onSubmit: text => a.saveHttpDraft(text),
      })}
      {d.httpBusy === 'draft' ? (
        <Text dimColor>Saving…</Text>
      ) : (
        <Box gap={1} justifyContent="center">
          <Button key="http:draft:save" label="Save" variant="primary" onPress={w.press(() => a.saveHttpDraft())} />
          <Button key="http:draft:cancel" label="Cancel" onPress={w.press(() => a.cancelHttpDraft())} />
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
  const files = [...new Set(hv.requests.map(r => r.file))]
  const draft = hv.draft?.kind === 'new' ? hv.draft : null

  return (
    <Box flexDirection="column" gap={1}>
      {hv.error !== '' && <Text color="error">{hv.error}</Text>}
      <Box gap={1} alignItems="center">
        <Box flexGrow={1} flexShrink={1}>
          {envLine(ctx)}
        </Box>
        {draft === null && <Button key="http:new" label="+ New" onPress={w.press(() => a.newHttpRequest())} />}
      </Box>
      {draft !== null ? (
        editor(ctx, draft)
      ) : hv.requests.length === 0 ? (
        <Text dimColor>No requests yet.</Text>
      ) : (
        files.map(file => (
          <Box key={`http:file:${file}`} flexDirection="column">
            <Text bold dimColor>{file}</Text>
            {hv.requests
              .filter(r => r.file === file)
              .map(r =>
                w.pressRow({
                  key: `http:req:${r.id}`,
                  label: requestTitle(r),
                  isTruncated: true,
                  rest: r.name !== '' && <Text dimColor>{r.method}</Text>,
                  onPress: () => a.openHttpRequest(r.id),
                }),
              )}
          </Box>
        ))
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

function resultView({ w, d, a }: TabContext, res: HttpResult) {
  const { Box, Button, Code, Text } = w
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
        <Box>
          <Button key="http:headers" label={`${isOpen ? '▾' : '▸'} Headers (${res.headers.length})`} plain onPress={w.press(() => a.toggleHttpHeaders(!isOpen))} />
        </Box>
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

function requestView(ctx: TabContext) {
  const { w, d, a } = ctx
  const { Box, Button, Code, Text } = w
  const hv = d.http
  const r: HttpRequest | undefined = hv.requests.find(x => x.id === hv.open)
  if (r === undefined) return null
  const names = variableNames(r)
  const sourceOf = (name: string) => variableSource(hv, d.httpCaptured, name)
  // 畫面上的代換：機密不讀出來，畫成 ••••••；還沒有值的照寫 {{name}}。
  const show = (text: string) =>
    substitute(text, name => {
      const source = sourceOf(name)
      if (source === 'captured') return d.httpCaptured[name]
      if (source === 'env') return hv.vars[name]

      return source === 'secret' ? MASK : undefined
    })
  const missing = names.filter(n => sourceOf(n) === 'missing')
  const captured = names.filter(n => sourceOf(n) === 'captured')
  const res = hv.result?.id === r.id ? hv.result : null
  const body = show(r.body)
  const draft = hv.draft?.kind === 'request' && hv.draft.id === r.id ? hv.draft : null
  const header = (
    <Box gap={1} alignItems="center">
      {backButton(w, w.press, 'http', () => a.closeHttpRequest())}
      <Box flexGrow={1} flexShrink={1} gap={1}>
        <Text bold wrap="truncate-end">{requestTitle(r)}</Text>
        <Text dimColor wrap="truncate-start">{r.file}</Text>
      </Box>
      {draft === null && (
        <Box flexShrink={0} gap={1} alignItems="center">
          <Button key="http:edit" label="Edit" onPress={w.press(() => a.editHttpRequest())} />
          {w.deleteButton('http:delete', d.armed === `http:request:${r.id}`, () => a.deleteHttpRequest())}
        </Box>
      )}
    </Box>
  )
  if (draft !== null) {
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {editor(ctx, draft)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      {header}
      {envLine(ctx)}
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold color="suggestion">{r.method}</Text>
          <Text>{show(r.url)}</Text>
        </Box>
        {r.headers.map((x, i) => (
          <Box key={`http:req-header:${i}`} gap={1}>
            <Text dimColor>{`${show(x.name)}:`}</Text>
            <Text>{show(x.value)}</Text>
          </Box>
        ))}
      </Box>
      {body !== '' && <Code source={body} path={/^\s*[[{]/.test(body) ? 'request.json' : 'request.txt'} startLine={1} />}
      {captured.length > 0 && <Text dimColor>{`From earlier responses: ${captured.map(n => `{{${n}}}`).join(', ')}`}</Text>}
      {missing.length > 0 && (
        <Box gap={1} alignItems="center" flexWrap="wrap">
          <Text color="warning">{`No value for ${missing.map(n => `{{${n}}}`).join(', ')}: paste it under`}</Text>
          <Button key="http:to-env" label="Environment" onPress={w.press(() => a.openHttpEnv(hv.env))} />
        </Box>
      )}
      <Box justifyContent="center">
        {d.httpBusy === 'send' ? <Text dimColor>Sending…</Text> : <Button key="http:send" label="Send" hotkey="s" onPress={w.press(() => a.sendHttp())} />}
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
function varEditor({ w, a, d }: TabContext, draft: { from: string; name: string; value: string }) {
  const { Box, Button, Text } = w
  const hv = d.http
  const line = (label: string, field: ReturnType<typeof w.field>) => (
    <Box gap={1} alignItems="center">
      <Box width={6} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {field}
      </Box>
    </Box>
  )

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
