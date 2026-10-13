import { expect, test } from 'claude-code/testing'

import type { ScanResult } from '../../types'
import { SCAN, proc } from '../test-fixtures'
import { findServices, serviceName } from '../../hooks/services/scan'

test('findServices groups each project process tree, skips the engine and other folders, and adds ports', () => {
  // session 資料夾寫成 C:\Proj\（跟程序的 C:\proj 大小寫不同、結尾多一個斜線）：Windows 的路徑比對不分大小寫。
  const services = findServices(SCAN, 'C:\\Proj\\')
  expect(services.map(s => [s.pid, s.ports])).toEqual([
    [70, [8081]],
    [50, [4000]],
    [21, [5000, 5001]],
    [15, [7000]],
    [11, [5173]],
  ])
  expect(services.map(s => `${s.tool} · ${s.name}`)).toEqual([
    'go · go-server',
    'node · proj',
    'dotnet · Api',
    'cargo · app',
    'npm · web',
  ])
  // go -C 自己 cd 進去的那一層要退回來，重跑才不會變成 go-server\go-server。
  expect(services[0]?.dir).toBe('C:\\proj')
  expect(services[4]?.command).toContain('npm-cli.js')
  expect(services[4]?.dir).toBe('C:\\proj\\web')
})

test('a service wrapped in cmd /c shows the real tool, and restart reruns the wrapper as is', () => {
  const WRAPPER = 'cmd.exe /d /s /c "set ASPNETCORE_ENVIRONMENT=Development && dotnet run --project dotnet/InventoryApi"'
  const wrapped: ScanResult = {
    self: [],
    pids: [7, 8, 9, 10],
    procs: [
      proc({ pid: 7, ppid: 1, name: 'Claude.exe' }),
      proc({ pid: 8, ppid: 7, name: 'cmd.exe', cmd: WRAPPER, cwd: 'C:\\proj\\' }),
      proc({ pid: 9, ppid: 8, name: 'dotnet.exe', cmd: '"C:\\Program Files\\dotnet\\dotnet.exe" run --project dotnet/InventoryApi', cwd: 'C:\\proj\\', started: 2000 }),
      proc({
        pid: 10,
        ppid: 9,
        name: 'InventoryApi.exe',
        exe: 'C:\\proj\\dotnet\\InventoryApi\\bin\\Debug\\net10.0\\InventoryApi.exe',
        cwd: 'C:\\proj\\dotnet\\InventoryApi\\',
        started: 3000,
      }),
    ],
    ports: [{ port: 5001, pid: 10 }],
  }
  const [s] = findServices(wrapped, 'C:\\proj')
  // 停止砍的是最上層的 cmd（整棵）；名字取裡面真正的程式；重跑照原樣跑 cmd（set 環境變數那段才不會掉）。
  expect(s?.pid).toBe(8)
  expect(s && `${s.tool} · ${s.name}`).toBe('dotnet · InventoryApi')
  expect(s?.command).toBe(WRAPPER)
  expect(s?.dir).toBe('C:\\proj')
  expect(s?.ports).toEqual([5001])
})

test('serviceName takes the deepest project folder the processes touch, whatever the language', () => {
  const ROOT_DIR = 'C:\\company'
  // 一串程序（最上層在前），只給名稱、指令、工作目錄、執行檔。
  const name = (...procs: [cmd: string, cwd: string | null, exe?: string][]) =>
    serviceName(
      procs.map(([cmd, cwd, exe], i) => proc({ pid: i + 1, ppid: i, name: 'x.exe', cmd, cwd, exe: exe ?? null })),
      ROOT_DIR,
    )
  const GO_TEMP = 'C:\\Temp\\go-build1\\b001\\exe\\inventory-service.exe'
  // go run 指到子資料夾的套件：參數裡的路徑；go run . 就是下指令的資料夾。
  expect(name(['go run ./inventory-service', 'C:\\company\\test2'], [GO_TEMP, 'C:\\company\\test2', GO_TEMP])).toBe('inventory-service')
  expect(name(['go run .', 'C:\\company\\test2'])).toBe('test2')
  // cargo workspace：執行檔都在最外層的 target，名字是執行檔的；--manifest-path 指到更深的資料夾就用它。
  expect(name(['cargo run --bin api', 'C:\\company\\ws'], ['', 'C:\\company\\ws', 'C:\\company\\ws\\target\\debug\\api.exe'])).toBe('api')
  expect(name(['cargo run --manifest-path services/billing/Cargo.toml', 'C:\\company\\ws'])).toBe('billing')
  // dotnet：bin 裡的執行檔。
  expect(name(['dotnet run --project src/Acme.Orders.Api', 'C:\\company\\test'], ['', 'C:\\company\\test\\src\\Acme.Orders.Api', 'C:\\company\\test\\src\\Acme.Orders.Api\\bin\\Debug\\net8.0\\Acme.Orders.Api.exe'])).toBe('Acme.Orders.Api')
  // Java：classpath 裡的 jar 不在專案裡就不算；target/classes 切掉 target。
  expect(name(['"C:\\jdk\\bin\\java.exe" -cp C:\\company\\orders\\target\\classes;C:\\Users\\me\\.m2\\spring-core-6.1.0.jar com.acme.App', 'C:\\company'])).toBe('orders')
  expect(name(['"C:\\jdk\\bin\\java.exe" -classpath "C:\\maven\\boot\\plexus-classworlds-2.8.0.jar" -Dmaven.multiModuleProjectDirectory=C:\\company\\shop org.codehaus.plexus.classworlds.launcher.Launcher spring-boot:run', 'C:\\company\\shop'])).toBe('shop')
  // node：node_modules 裡的腳本算它前面那一層；cmd /c 包裝的參數不看。
  expect(name(['C:\\WINDOWS\\system32\\cmd.exe /d /s /c "pnpm --filter web dev"', 'C:\\company\\mono'], ['node C:\\company\\mono\\apps\\web\\node_modules\\vite\\bin\\vite.js', 'C:\\company\\mono\\apps\\web'])).toBe('web')
  expect(name(['node node/notify-svc/server.js', 'C:\\company\\test3'])).toBe('notify-svc')
  // 不算的：設定檔、網址、模組路徑、.venv 裡的 python。
  expect(name(['app --config conf/dev/app.json --url http://localhost:3000/api', 'C:\\company\\svc'])).toBe('svc')
  expect(name(['python -m uvicorn app.main:app', 'C:\\company\\py-api', 'C:\\company\\py-api\\.venv\\Scripts\\python.exe'])).toBe('py-api')
  // 什麼都沒有就是 session 資料夾的名字。
  expect(name(['node server.js', null])).toBe('company')
})
