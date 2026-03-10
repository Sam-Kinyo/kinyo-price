# SAM-KINYO-WEBSITE (KINYO 企業採購平台)

此專案為 KINYO 的 B2B 企業採購平台，整合：
- 首頁導流與商品展示
- 查價系統（Firebase Auth + Firestore）
- LINE Bot 即時查價（FastAPI 後端）
- 訂單、售後、追蹤（Google Apps Script 串接）

## 技術棧

- 前端：HTML + 原生 JavaScript (ES Modules)、React 18 (CDN)、Tailwind CSS
- 後端：Python FastAPI、Uvicorn
- 資料庫：Firebase Firestore
- 認證：Firebase Authentication
- 外部整合：LINE Messaging API、Google Apps Script
- 部署：GitHub Pages（前端）、GCP Cloud Run（後端）

## 專案結構

```text
kinyo-price/
├── index.html                  # 首頁
├── system.html                 # 查價系統
├── system-v2/system.html       # 舊版入口（轉址到 system.html）
├── order.html                  # 訂單系統（React CDN）
├── tracking.html               # 追蹤系統（React CDN）
├── return_form.html            # 售後表單（React CDN）
├── js/
│   ├── app.js                  # 查價前端入口
│   ├── auth.js                 # 登入/登出
│   ├── search.js               # 搜尋邏輯
│   ├── render.js               # 結果渲染
│   ├── quote.js                # 報價單
│   ├── export.js               # Excel/PPT 匯出
│   ├── import.js               # 商品匯入
│   ├── state.js                # 共用狀態
│   └── firebase-init.js        # Firebase 初始化
├── backend/
│   ├── main.py                 # FastAPI 入口
│   ├── core/config.py          # 環境變數與 Firebase 初始化
│   ├── database/firestore_db.py# 商品快取層
│   ├── routers/
│   │   ├── webhook_api.py      # LINE Webhook
│   │   └── system_api.py       # 快取刷新 API
│   ├── services/pricing_service.py
│   └── utils/
└── modelData.json              # 型號與圖片對照
```

## 核心流程

### 1) Web 查價流程

1. 使用者登入 Firebase Auth
2. 前端載入 Firestore 商品到 `state.productCache`
3. 執行搜尋/排序/加入報價
4. 匯出 Excel/PPT 或歷史報價

### 2) LINE Bot 查價流程

1. LINE 事件進入 `POST /api/webhook`
2. 解析文字（數量、預算、關鍵字）
3. 以快取搜尋商品（必要時模糊比對）
4. 計算階梯報價
5. 回傳 Flex Message（單卡或 Carousel）

### 3) 後端快取流程

1. FastAPI 啟動時載入 Firestore `Products`
2. 快取保存於記憶體，查價以快取為主
3. 管理者可呼叫 `POST /api/refresh?token=...` 重新載入

## API 一覽（後端）

- `GET /health`：健康檢查與快取數量
- `POST /api/webhook`：LINE Webhook
- `POST /api/refresh?token=...`：手動刷新快取
- `GET /api/cache-stats`：快取統計

## 本機開發

### 後端

1. 建立虛擬環境並安裝套件（`backend/requirements.txt`）
2. 準備 `.env` 與 Firebase 憑證
3. 啟動：

```bash
python backend/main.py
```

### 前端

前端是靜態頁面，可直接以本機靜態伺服器啟動後開啟 `index.html` / `system.html`。

## 已知架構特性

- 前端採混合模式（原生 JS 與 React CDN 並存）
- 前端直接連 Firestore（部分路徑未經後端 API）
- `system-v2/system.html` 僅保留相容轉址，實際邏輯統一於 `system.html`

## 建議優化方向

- 統一前端建置流程（例如 Vite）
- 將關鍵資料讀寫收斂到後端 API，強化權限控管
- 維持單一查價系統入口與共用程式碼，避免版本漂移
- 增加後端自動化測試（尤其 pricing 與 parser）
