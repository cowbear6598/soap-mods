# soap-mods

CptSoap 的 Claude Code Panel mod。

## 目前的功能

面板上方是 Tab：**Git** 和 **Services**。

選到 Git 後有三個子分頁：

- **diff**：列出目前資料夾的未提交變更（含未追蹤檔案），點檔案就在下面看它的差異。
- **branch**：列出本地與遠端分支（目前分支在最上面），點分支名稱可以切換。
- **conflict**：停在 merge／rebase／cherry-pick／revert 時，最上面顯示進行中的操作和 **Abort**（按兩次才會真的 abort）；衝突全部解完後多一顆 **Continue**（merge 直接用預設訊息 commit，其他是 `--continue`，都不開編輯器）。下面列出還沒解的檔案，有衝突時子分頁的圖示變紅。點檔案（diff 分頁裡標 `!` 的也一樣）開合併面板。

合併面板跟 JetBrains 的一樣是三欄：左邊 **Ours**、右邊 **Theirs**、中間是結果。面板不是看檔案裡的衝突標記，而是拿 git 留著的三個版本（`:1:` 共同祖先、`:2:` ours、`:3:` theirs）自己做三方比對，所以左右兩欄是兩邊真正的檔案（行號也是），每一段分成三種：

- **沒動過**：兩邊都沒改，三欄一樣。只留改動前後各 3 行，其餘收成 `⋯ N unchanged lines`。
- **自動合入**（藍框）：只有一邊改（或兩邊改得一模一樣），git 自己就會合進去，不用選。改的那邊標 `changed`，中間寫 `Auto-merged from ours/theirs`；按 **Undo** 可以不要這個改動（結果留原本的樣子），再按 **Apply** 放回來。
- **衝突**（紅框）：兩邊改到同一塊，或緊貼著改。左邊按 **Accept ≫**、右邊按 **≪ Accept** 把那一邊放進中間，也可以選 **Ours + Theirs** 或 **Theirs + Ours**（兩邊都要，順序不同），選好變綠框，可以 **Reset** 重選；沒被選進去的那邊會淡掉。還沒選時中間顯示 Base（兩邊改之前的樣子）。

兩邊都新增了這個檔案（沒有共同祖先）時，一樣的部分保留，每一處不一樣都算衝突。讀不到 git 的版本時，退回只看檔案裡的衝突標記。

上面有 **All ours** / **All theirs**（每段衝突都選同一邊，自動合入的改動保留）、**Ask Claude**（請 Claude 解這個檔案並 `git add`），每段衝突都選好才會出現的 **Apply & mark resolved**（寫回檔案並 `git add`）。面板只放當下用得到的按鈕：衝突還沒選時中間是兩個「兩邊都要」，選好之後換成 **Reset**。rebase 時 ours／theirs 跟直覺相反（ours 是你要接上去的那條分支），面板上會提醒。

沒有衝突標記可以一段一段選的檔案（一邊刪掉了、二進位檔、標記已經被你手動清掉）改成整個檔案選：**Use ours**、**Use theirs**（那一邊把檔案刪了就 `git rm`）、**Mark resolved as is**（照目前的樣子 `git add`）。

中間那欄不能直接打字修改（引擎沒有多行編輯器）。結果是從 git 的三個版本算出來的，**你在編輯器裡手動改過的內容不會顯示，按 Apply 會蓋掉**；要手動解的話，自己改完把衝突標記都清掉，面板就會改成整個檔案選，按 **Mark resolved as is**。面板會在回合結束或輸入 `/soap-panel` 時重讀，沒變的段落保留已經做的選擇。

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
- 衝突標記的解析、合併結果的組合：`hooks/merge.ts`；合併面板的寬度、收起段落前後留幾行：`hooks/register.tsx` 最上面的 `MERGE_COLUMNS`、`MERGE_CONTEXT`。
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
