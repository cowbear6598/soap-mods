# soap-mods

CptSoap 的 Claude Code Panel mod。

## 目前的功能

面板上方是 Tab：**Git** 和 **Services**。

選到 Git 後最上面是一排 repo 按鈕，例如 `a*`　`b`　`c* !`：`*` 是有未提交的變更，`!` 是有衝突。session 資料夾本身是 repo 時只有它一個；不是的話（例如在 `company/` 開，底下 `a`、`b`、`c` 各是一個 repo）列出下一層的 repo，點哪個，下面的 diff／branch／log／conflict 就看哪個。面板不會自己換（一個回合可能動到好幾個 repo），每個回合結束後所有 repo 的數字一起更新。只看下一層，名稱開頭是 `.` 的資料夾不算。

下面有四個子分頁：

- **diff**：列出目前資料夾的未提交變更（含未追蹤檔案），每一組照狀態排（衝突 → 新增 → 修改 → 改名 → 刪除），點檔案就在下面看它的差異。
- **branch**：列出本地與遠端分支（目前分支在最上面、寫全名），點分支名稱可以切換。名稱有 `/` 的照資料夾分組（`feature/x` 放在 `feature/` 底下，`soap/feature/x` 放在 `soap/` → `feature/` 底下；只有一個子資料夾的那層會併成一列，例如 `soap/feature/ · 3`），點資料夾開合，預設收起；那一層只有它一個資料夾時預設打開。只有一個 remote 時不畫 `origin/` 那層（Remote 底下直接是 `feature/`、`main`），有好幾個 remote 才分 `origin/`、`upstream/`。資料夾是天空藍（只有桌面版，終端機的按鈕吃不到顏色）。搜尋時全部打開。每個資料夾直屬的分支最多畫 50 個，超過的在那個資料夾底下寫「… N more」；Local、Remote 各最多畫 200 列（資料夾也算），超過的在最後寫「… N more」。搜尋框右邊有 **Fetch**（`git fetch --all --prune`，抓所有遠端、清掉遠端已刪的分支）和 **Pull**（`git pull --ff-only`，只快轉；跟遠端分岔了會顯示 git 的錯誤，要自己 merge 或 rebase），跑的時候那顆按鈕寫 `Fetching…`／`Pulling…`；需要帳密時 git 不會停下來問，直接失敗（Windows 的認證視窗照常會跳）。搜尋框邊打邊過濾分支名稱（不分大小寫；打好幾個字要全部都有，例如 `login page`），搜尋時 Remote 直接展開。按框旁邊的 **Clear** 或 Enter 清空，換分頁也會清掉。每一列右邊有一顆 log 圖示（時鐘），按了跳到 log 分頁看那個分支。
- **log**：看一個分支的 commit 歷史。預設是目前分支（切分支會跟著換）；在 branch 分頁按某個分支的 log 圖示就固定看那個分支，按目前分支那列的回到跟著目前分支，換 repo 時換成那個 repo 的目前分支。最上面寫正在看的分支和筆數，每筆是 `a9ffcd8  Add Previous/Next…  CptSoap · 3d`（短 sha、subject、作者、多久前）。先列最近 30 筆，底下按 **Load more** 再多 30 筆。最上面有跟 branch 一樣的搜尋框：搜整條分支的歷史（不只列出來的那些），比對 subject、作者、sha，不分大小寫，打好幾個字要全部都有；符合的一樣先列 30 筆。按 **Clear** 或 Enter 清空，換分頁也會清掉。歷史太長（超過 git 一次給的量，大約兩萬多筆）時只搜最新的那些，會有提示。還沒 push 的 commit 在 sha 前面標黃色 `↑`：有 upstream 的跟 upstream 比；沒有的（還沒 push 過的新分支）不在任何遠端分支上的才標。點 commit 換成它改了哪些檔案（**← Back** 回列表），點檔案在差異面板看它在這個 commit 的差異。merge commit 跟第一個 parent 比，也就是這次 merge 帶進來的東西。
- **conflict**：停在 merge／rebase／cherry-pick／revert 時，最上面顯示進行中的操作和 **Abort**（按兩次才會真的 abort）；衝突全部解完後多一顆 **Continue**（merge 直接用預設訊息 commit，其他是 `--continue`，都不開編輯器）。下面列出還沒解的檔案，有衝突時子分頁的圖示變紅。點檔案（diff 分頁裡標 `!` 的也一樣）開合併面板。

合併面板跟 JetBrains 的一樣是三欄：左邊 **Ours**、右邊 **Theirs**、中間是結果。面板不是看檔案裡的衝突標記，而是拿 git 留著的三個版本（`:1:` 共同祖先、`:2:` ours、`:3:` theirs）自己做三方比對，所以左右兩欄是兩邊真正的檔案（行號也是），每一段分成三種：

- **沒動過**：兩邊都沒改，三欄一樣。只留改動前後各 3 行，其餘收成 `⋯ N unchanged lines`。
- **自動合入**（藍框）：只有一邊改（或兩邊改得一模一樣），git 自己就會合進去，不用選。改的那邊標 `changed`，中間寫 `Auto-merged from ours/theirs`；按 **Undo** 可以不要這個改動（結果留原本的樣子），再按 **Apply** 放回來。
- **衝突**（紅框）：兩邊改到同一塊，或緊貼著改。左邊按 **Accept ≫**、右邊按 **≪ Accept** 把那一邊放進中間，也可以選 **Ours + Theirs** 或 **Theirs + Ours**（兩邊都要，順序不同），選好變綠框，可以 **Reset** 重選；沒被選進去的那邊會淡掉。還沒選時中間顯示 Base（兩邊改之前的樣子）。

兩邊都新增了這個檔案（沒有共同祖先）時，一樣的部分保留，每一處不一樣都算衝突。讀不到 git 的版本時，退回只看檔案裡的衝突標記。

上面有 **↑ Previous** / **↓ Next**（快捷鍵 `n` / `m`，面板拿著鍵盤時能用）跳到上一段／下一段還沒選的衝突，捲到那一段並把焦點放在 **Accept ≫**；全部選好後改成在所有衝突之間跳。下一排是 **All ours** / **All theirs**（每段衝突都選同一邊，自動合入的改動保留）、**Ask Claude**（請 Claude 解這個檔案並 `git add`），每段衝突都選好才會出現的 **Apply & mark resolved**（寫回檔案並 `git add`）。面板只放當下用得到的按鈕：衝突還沒選時中間是兩個「兩邊都要」，選好之後換成 **Reset**。rebase 時 ours／theirs 跟直覺相反（ours 是你要接上去的那條分支），面板上會提醒。

沒有衝突標記可以一段一段選的檔案（一邊刪掉了、二進位檔、標記已經被你手動清掉）改成整個檔案選：**Use ours**、**Use theirs**（那一邊把檔案刪了就 `git rm`）、**Mark resolved as is**（照目前的樣子 `git add`）。

中間那欄不能直接打字修改（引擎沒有多行編輯器）。結果是從 git 的三個版本算出來的，**你在編輯器裡手動改過的內容不會顯示，按 Apply 會蓋掉**；要手動解的話，自己改完把衝突標記都清掉，面板就會改成整個檔案選，按 **Mark resolved as is**。面板會在回合結束或輸入 `/soap-panel` 時重讀，沒變的段落保留已經做的選擇。

**Services**（Windows 和 macOS）列出 session 資料夾底下正在跑的服務。不管是你自己開的，還是 AI 在背景開的都算，例如 `npm run dev`、`dotnet run`、`bun run dev`。每筆服務顯示指令、所在資料夾、LISTEN 的 port、跑了多久和 PID，右邊有兩顆按鈕：

- **重跑**：砍掉整棵程序樹，在同一個資料夾用同一個指令重開。重開的服務在背景執行、不開視窗，不存 log。新程序 30 秒內就結束的話，面板會顯示重跑失敗（原因要自己跑一次那個指令看）。
- **停止**：砍掉整棵程序樹（Windows 用 `taskkill /T /F`，macOS 用 `ps` 找出子孫再 `kill -9`）。

macOS 用 `ps` 和 `lsof` 掃描。重跑的指令是 `ps` 讀到的那行，原本的引號已經不見了，所以參數裡有空白的路徑重跑會壞（Windows 沒這個問題）。

服務照 repo 分組（跟 diff 分頁的 Staged／Unstaged 一樣），組的順序跟 Git 分頁那排 repo 一樣；不在任何 repo 裡的放在最後的 **Other**。

判斷方式：**有開 port**，而且工作目錄或執行檔在 session 資料夾底下，就算一個服務。不看是什麼語言，所以 Node、.NET、Go、Rust、Python…都一樣。父子程序會併成一筆，例如 `npm → cmd /c → node vite`（macOS 是 `npm → sh -c → node vite`）、`go run → go-server.exe`、`cargo run → app.exe`；往上併到你的終端機（shell）、編輯器或 IDE 就停，所以「停止」不會砍到它們。桌面版 `.claude/launch.json` 預覽開的伺服器也會列出。不會列出的有：沒開 port 的程式（language server、背景 script），以及 Claude Code 引擎自己和它直接開的程序（MCP server 等）。分頁開著時每 5 秒掃一次。

面板最底下固定顯示用量，左右各一半：`5h · 93% · 2h 26m` 和 `Weekly · 99% · 2d 18h 5m`（剩餘 %、離重置多久），下面一條剩餘量的 bar。多於 50% 綠、多於 20% 黃、其餘紅。只有訂閱帳號才有數字，送出第一則訊息前會顯示 `—`。

每個回合結束後會自動更新，也可以按「重新整理」。

啟動 session 時自動開啟，也可以輸入 `/soap-panel`。

## 想改的地方

檔案結構：

- `hooks/register.tsx`：狀態（atom）、所有碰到 `$` 的動作（跑 git、開關面板）、事件接線。引擎只讓這個檔案碰 `$` 和 atom，所以這些不能拆出去。
- `hooks/config.ts`：常數（標題、分頁、顏色、時間）。
- `hooks/git/`、`hooks/merge/algo.ts`、`hooks/services/scan.ts`：純邏輯（解析 git 輸出、三方合併、找服務），旁邊的 `*.test.ts` 是單元測試。
- `hooks/ui/`：畫面，都是純函式，拿到資料和 `Actions`（`ui/actions.ts`）畫出樹；`ui/tabs/` 一個分頁一個檔案。

常改的地方：

- 加新的 Tab 或子分頁：`hooks/config.ts` 的 `TABS`、`SUB_TABS` 加一筆，`hooks/ui/panel.tsx` 的 `TAB_BODIES`、`SUB_TAB_BODIES` 加它的內容。
- 用量的標題、顏色：`hooks/config.ts` 的 `USAGE_WINDOWS`、`GOOD` / `WARN` / `DANGER`；門檻在 `hooks/ui/usage.tsx`。
- 合併面板的寬度、收起段落前後留幾行：`hooks/config.ts` 的 `MERGE_COLUMNS`、`MERGE_CONTEXT`。
- 往上併時不能併進去的程式（終端機、編輯器、IDE）：`hooks/services/scan.ts` 的 `SHELLS`、`HOSTS`；掃描間隔在 `hooks/config.ts` 的 `SERVICES_SCAN_MS`。

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
