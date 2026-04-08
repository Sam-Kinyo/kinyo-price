# 資安升級風險評估與執行計畫 (Security Upgrade Risk Assessment)

這是一份針對系統底層資安漏洞進行修復時，各項操作對目前穩定運行的系統所帶來的「危險程度（風險破壞力）」評估。我們的核心策略是：「『有策略地分批進行』，以達到 0 停機時間。」

## 綠燈：完全 0 風險、絕不影響運作（建議優先執行）

*   **將 `.env` 和 `*.json` 放入 `.gitignore`**
    *   **影響**：完全不影響任何程式運作。這只是告訴 Git 紀錄檔「以後不要再把這幾個秘密檔案上傳到雲端備份庫」，本地端的檔案都還在，Firebase 也能正常讀取。
    *   **狀態**：已完成 (Commit: e1a050f)

*   **清理遺留敏感檔案**
    *   **影響**：刪除 `functions/credentials.json.bak` 和 `backend_archive/serviceAccountKey.json`，這些都是備份/歸檔檔案，不影響線上運作。
    *   **狀態**：已完成 (2026-04-03)

*   **修復 mailer.js 硬編碼帳密**
    *   **影響**：將 `functions/src/utils/mailer.js` 中直接寫死的 Gmail 帳密改為讀取 `process.env.GMAIL_USER` / `process.env.GMAIL_PASS`。`.env` 已有這些變數，部署後行為完全相同。
    *   **狀態**：已完成 (2026-04-03)

## 黃燈：有中度風險，稍微不注意就會網頁破圖或壞掉（需要謹慎處理）

*   **修改 `storage.rules` (權限規則)**
    *   **風險**：如果「直接移除 `allow read: if true`」，網頁上的所有商品圖片會瞬間變成 「全部破圖（無權限讀取）」！
    *   **安全做法**：已改為「精準限縮」—— `product_images/` 資料夾允許公開讀取，其餘路徑需要登入。圖片不會破圖，未來其他機密檔案也受保護。
    *   **狀態**：已完成 (2026-04-03)，需部署 `firebase deploy --only storage`

*   **將 `innerHTML` 改為安全的 `escapeHtml` 處理**
    *   **風險**：若商品描述中有使用 HTML 標籤（如 `<br>`），escape 後會顯示為純文字。經掃描確認目前商品資料中無此情況。
    *   **安全做法**：在 `js/helpers.js` 新增 `escapeHtml()` 工具函式，並在 `render.js`、`quote.js` 的所有動態資料注入點套用。後端 `index.js` 的 HTML 表單生成也已加入伺服器端 escape。
    *   **狀態**：已完成 (2026-04-03)

## 紅燈：高度危險，做錯一步 LINE Bot 或機器就會立刻停擺（需要操作配合）

*   **撤銷並重新產生所有 API 金鑰** (包含 Google Service Account, LINE Token, Gemini API)
    *   **風險**：如果直接在後台把舊的 Token 刪除，LINE Bot 或自動同步等背景服務會**瞬間死亡（沒有回應）**，直到新 Token 寫入並部署完成為止。
    *   **安全做法**：必須挑一個「沒有客人在使用」的離峰時間。需先取得「新金鑰」，寫入系統、部署上線確認運作正常後，再去後台把「舊金鑰」刪掉（Revoke）。這樣就能做到 **無縫接軌**。
    *   **狀態**：待處理 (經查 `functions/.env` 等機密檔案已在 Commit `017238d` 外洩至 GitHub 上，所有金鑰此時此刻皆處於不安全狀態。)

*   **更改 Cloud Functions 的弱驗證 Token**
    *   **風險**：目前 syncGDrive 的 token 已從硬編碼 `kinyosync` 改為讀取環境變數 `process.env.SYNC_TOKEN`。
    *   **安全做法**：已在 `.env` 中設定新的強密碼 `SYNC_TOKEN`。部署後，舊的 `kinyosync` token 將失效。LINE Bot 觸發同步的程式碼也已同步更新為使用環境變數。
    *   **狀態**：已完成 (2026-04-03)，需部署 `firebase deploy --only functions`
