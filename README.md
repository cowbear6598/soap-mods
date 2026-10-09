# soap-mods

CptSoap 的 Claude Code Panel mod。

## 目前的功能

面板上方是 Tab：**Git** 和 **Services**。

選到 Git 後有三個子分頁：

- **diff**：列出目前資料夾的未提交變更（含未追蹤檔案），點檔案就在下面看它的差異。
- **branch**：列出本地與遠端分支（目前分支在最上面），點分支名稱可以切換。
- **conflict**：還沒做。

**Services**（目前只支援 Windows）列出 session 資料夾底下正在跑的服務。不管是你自己開的，還是 AI 在背景開的都算，例如 `npm run dev`、`dotnet run`、`bun run dev`。每筆服務顯示指令、所在資料夾、LISTEN 的 port、跑了多久和 PID，右邊有兩顆按鈕：

- **重跑**：砍掉整棵程序樹，在同一個資料夾用同一個指令重開。重開的服務在背景執行、不開視窗，不存 log。新程序 30 秒內就結束的話，面板會顯示重跑失敗（原因要自己跑一次那個指令看）。
- **停止**：砍掉整棵程序樹（`taskkill /T /F`）。

判斷方式：**有開 port**，而且工作目錄或執行檔在 session 資料夾底下，就算一個服務。不看是什麼語言，所以 Node、.NET、Go、Rust、Python…都一樣。父子程序會併成一筆，例如 `npm → cmd /c → node vite`、`go run → go-server.exe`、`cargo run → app.exe`；往上併到你的終端機（shell）、編輯器或 IDE 就停，所以「停止」不會砍到它們。桌面版 `.claude/launch.json` 預覽開的伺服器也會列出。不會列出的有：沒開 port 的程式（language server、背景 script），以及 Claude Code 引擎自己和它直接開的程序（MCP server 等）。分頁開著時每 5 秒掃一次。

面板最底下固定顯示用量，左右各一半：`5h · 93% · 2h 26m` 和 `Weekly · 99% · 2d 18h 5m`（剩餘 %、離重置多久），下面一條剩餘量的 bar。多於 50% 綠、多於 20% 黃、其餘紅。只有訂閱帳號才有數字，送出第一則訊息前會顯示 `—`。

每個回合結束後會自動更新，也可以按「重新整理」。

啟動 session 時自動開啟，也可以輸入 `/soap-panel`。

## 想改的地方

- 加新的 Tab 或子分頁：`hooks/register.tsx` 最上面的 `TABS`、`SUB_TABS`。
- 用量的標題、顏色門檻：`hooks/register.tsx` 最上面的 `USAGE_WINDOWS`、`USAGE_GOOD` / `USAGE_WARN` / `USAGE_LOW`。
- git 輸出的解析：`hooks/git.ts`（有單元測試在 `hooks/register.test.ts`）。
- 往上併時不能併進去的程式（終端機、編輯器、IDE）：`hooks/services.ts` 的 `SHELLS`、`HOSTS`；掃描間隔在 `hooks/register.tsx` 的 `SERVICES_SCAN_MS`。

## 安裝（Claude Desktop，Code 分頁，需 v2.1.286 以上）

### 方法 A：開發用，存檔自動重載
1. 把整個 `soap-mods` 資料夾放到你電腦上，例如 `~/mods/soap-mods`。
2. 在啟動 Claude Desktop 之前設定環境變數（macOS 範例，Windows 用「系統環境變數」）：
   ```
   CLAUDE_CODE_PLUGIN_DIRS=~/mods/soap-mods
   CLAUDE_CODE_PLUGIN_DIR_WATCH=1
   ```
   也可以寫進 `~/.claude/settings.json` 的 `env` 區塊。
3. 重新啟動 Claude Desktop，開一個 Code 分頁的新 session，面板會自動出現。之後改 `register.tsx` 存檔就會重載。

### 方法 B：從 GitHub 安裝
在 Code 分頁輸入：
```
/plugin install soap-mods --marketplace cowbear6598/soap-mods
```
之後有更新，輸入 `/plugin update soap-mods` 再 `/reload-plugins`。

注意：雲端 session 與 WSL 不會載入 mod；mod 沒有沙箱，以你的權限執行。
