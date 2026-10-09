# soap-mods

CptSoap 的 Claude Code Panel mod。

## 目前的功能

面板上方是 Tab，目前只有 **Git**。選到 Git 後有三個子分頁：

- **diff**：列出目前資料夾的未提交變更（含未追蹤檔案），點檔案就在下面看它的差異。
- **branch**：列出本地與遠端分支（目前分支在最上面，附上 ahead/behind、時間、最新 commit 訊息），點分支名稱可以切換。
- **conflict**：還沒做。

每個回合結束後會自動更新，也可以按「重新整理」。

啟動 session 時自動開啟，也可以輸入 `/soap-panel`。

## 想改的地方

- 加新的 Tab 或子分頁：`hooks/register.tsx` 最上面的 `TABS`、`SUB_TABS`。
- git 輸出的解析：`hooks/git.ts`（有單元測試在 `hooks/register.test.ts`）。

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
