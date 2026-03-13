# 多公司模板開通指南（獨立 Firebase）

這份專案已支援以 `company` 參數切換公司設定，例如：

- `system.html?company=kinyo`
- `system.html?company=lingdong`

## 你需要準備的東西

1. 靈動數碼 Firebase Web 設定（`apiKey` 那一組）
2. 靈動數碼 Firestore 初始集合：
   - `Users`
   - `Products`
   - `SiteConfig`
3. 靈動數碼管理員帳號（`Users/{email}.level = 4`）

## 已完成的模板化內容

1. `js/company-config.js`
   - 公司的名稱、PPT 設定、Firebase 設定統一管理。
2. `js/firebase-init.js`
   - 會依 `company` 自動切換 Firebase。
3. `js/app.js` + `system.html`
   - 標題與副標會依公司設定自動替換。
4. `js/export.js`
   - PPT logo、檔名前綴、頁腳公司名可依公司設定變更。
5. `brands/lingdong/system.html`
   - 靈動數碼入口（會導向 `system.html?company=lingdong`）。

## 本機測試

1. 啟動本機靜態站台（任一方式都可）
2. 開啟：
   - `http://127.0.0.1:5500/system.html?company=lingdong`
   - 或 `http://127.0.0.1:5500/brands/lingdong/system.html`
3. 驗證項目：
   - 頁面標題顯示「靈動數碼 查價系統」
   - 登入卡標題已切換成靈動數碼
   - PPT 匯出檔名前綴為 `Lingdong-商品推薦報價`

## 正式切換靈動數碼 Firebase

請修改 `js/company-config.js` 中 `lingdong.firebase`：

```js
firebase: {
  apiKey: "...",
  authDomain: "...",
  projectId: "...",
  storageBucket: "...",
  messagingSenderId: "...",
  appId: "...",
  measurementId: "..."
}
```

完成後重新整理頁面即可。
