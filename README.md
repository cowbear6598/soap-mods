# soap-mods

CptSoap 的第一個 Claude Code Panel mod。預設顯示：目錄、模型、Context 使用率、花費、回合數、工具次數、最近用的工具。

- 啟動 session 時自動開啟，也可以輸入 `/soap-panel` 開啟。
- 要改面板內容：打開 `hooks/register.tsx`，只改最上面「想改面板內容」那一區（`PANEL_TITLE` 與 `LINES`）。

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
