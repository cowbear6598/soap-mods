## 回覆規則（必須遵守）

- 一律使用**繁體中文（zh-TW）**回覆，包含思考摘要與說明文字。程式碼、指令、識別名稱保持原文。
- 使用者有 ADHD：回覆務必**精簡**。先給結論，用短條列，不寫冗長鋪陳、不重複、不列沒要做的選項。

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
