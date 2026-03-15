# LINE Bot 權限流程

## 權限來源（單一真相）

Line Bot 與網頁版共用 Firebase 權限資料：

1. `LineUsers`：以 `LINE user_id` 對應到 `email`
2. `Users`：以 `email` 讀取 `level` 與 `vipColumn`

流程如下：

`LINE user_id -> LineUsers.email -> Users.level/vipColumn`

## 管理員設定流程

1. 在 `Users` 建立/更新客戶帳號權限（`level`、`vipColumn`）
2. 在 `LineUsers` 建立 `LINE user_id -> email` 綁定
3. 客戶傳訊查價時，後端依上述映射載入權限

## 未綁定或未開通時

若發生以下任一情況，Line Bot 會回覆導引訊息：

- `LineUsers` 無對應 `user_id`
- `LineUsers` 缺少 `email`
- `Users` 無對應帳號

回覆內容會提示聯繫管理員確認 `LineUsers / Users` 權限設定。
