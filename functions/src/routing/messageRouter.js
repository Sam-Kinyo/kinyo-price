const { admin } = require('../utils/firebase'); // 若有用到 serverTimestamp 需引入 admin

/**
 * 處理靜態指令 (如取得群組ID、設定為接單總部、產生訂單模板、查詢訂單、帳號綁定完成)
 * @param {Object} event - LINE Webhook 單一事件
 * @param {Object} userContext - 經過 auth middleware 驗證後的權限上下文
 * @param {Object} lineClient - LINE messaging api client 實例
 * @param {Object} db - Firestore 實例
 * @returns {Promise<boolean>} 若攔截成功並處理完成回傳 true，否則回傳 false 讓主程式接手
 */
async function handleStaticCommands(event, userContext, lineClient, db) {
    const rawUserMessage = event.message.text.trim();
    const replyToken = event.replyToken;
    const lineUid = userContext.uid;
    const groupId = userContext.groupId;
    
    // 1. 取得群組 ID
    if (rawUserMessage === '@KINYO挺好的 取群組ID' || rawUserMessage === '@KINYO挺好的 #取得群組ID') {
        const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'text',
                text: `[系統管理員資訊]\n此來源的 ID 為：\n${sourceId}`
            }]
        });
        return true;
    }

    // 2. 設定為接單總部
    if (rawUserMessage === '@KINYO挺好的 設定為接單總部' || rawUserMessage === '@KINYO挺好的 #設定為接單總部') {
        const adminUid = 'U7043cd6c4576c96ddb23d316fba32a9b'; // 首長 UID
        if (lineUid !== adminUid) {
            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此設定' }]
            });
            return true;
        }

        // 將群組 ID 寫入系統設定表
        await db.collection('SystemConfig').doc('OrderSettings').set({
            notifyGroupId: groupId,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '✅ 已將本群組設定為【接單總部】\n未來新訂單將同步推播至此。' }]
        });
        return true;
    }

    // 3. 訂單模板
    if (rawUserMessage === '訂單' || rawUserMessage === '@KINYO挺好的 訂單') {
        const orderTemplate = `@KINYO挺好的 下單\n\n採購公司：\n收件人：\n聯絡電話：\n送貨地址：\n預期到貨：\n備註：\n=================\n【訂購明細】請依下方格式填寫：\n型號： / 數量： / 單價：  (單價沒有可空白)\n型號： / 數量： / 單價：`;

        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'text',
                text: `請複製以下模板填寫並送出：\n\n${orderTemplate}`
            }]
        });
        return true;
    }

    // 3.5 預留訂單模板 (佔位先留貨)
    if (rawUserMessage === '預留訂單' || rawUserMessage === '留貨' || rawUserMessage === '@KINYO挺好的 預留訂單' || rawUserMessage === '@KINYO挺好的 留貨') {
        const reserveTemplate = `@KINYO挺好的 預留訂單\n\n採購公司：\n收件人：\n聯絡電話：\n送貨地址：\n預留期限：（例：2026/05/31）\n備註：\n=================\n【預留明細】請依下方格式填寫：\n型號： / 數量： / 單價：  (單價沒有可空白)\n型號： / 數量： / 單價：`;

        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'text',
                text: `請複製以下模板填寫並送出：\n\n${reserveTemplate}\n\n📌 預留期限到期前 7 天，系統會自動寄信提醒助理準備出貨。`
            }]
        });
        return true;
    }

    // 4. 查詢訂單
    if (rawUserMessage === '查詢訂單' || rawUserMessage === '@KINYO挺好的 查詢訂單') {
        // 從 Firestore 撈取該群組最近 5 筆訂單
        const ordersSnapshot = await db.collection('PendingOrders')
            .where('sourceId', '==', groupId)
            .orderBy('createdAt', 'desc')
            .limit(5)
            .get();

        if (ordersSnapshot.empty) {
            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [{ type: 'text', text: '📝 目前本群組尚無歷史訂單紀錄。' }]
            });
            return true;
        }

        // 組合 Flex Carousel 輪播卡片
        const bubbles = ordersSnapshot.docs.map(doc => {
            const data = doc.data();
            const orderId = doc.id;
            const statusColor = data.status === '已出貨' ? '#1DB446' : '#F59E0B';
            const dateStr = data.createdAt ? new Date(data.createdAt._seconds * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '未知時間';

            return {
                type: 'bubble',
                size: 'micro',
                header: {
                    type: 'box',
                    layout: 'vertical',
                    contents: [{ type: 'text', text: `狀態：${data.status || '處理中'}`, color: statusColor, weight: 'bold', size: 'sm' }],
                    paddingAll: '10px'
                },
                body: {
                    type: 'box',
                    layout: 'vertical',
                    contents: [
                        { type: 'text', text: `編號: ${orderId.substring(0, 8)}...`, size: 'xs', color: '#888888' },
                        { type: 'text', text: `客戶: ${data.customer.name}`, weight: 'bold', size: 'sm', margin: 'sm' },
                        { type: 'text', text: `金額: $${data.totalAmount}`, size: 'sm', color: '#E11D48' },
                        { type: 'text', text: dateStr, size: 'xxs', color: '#aaaaaa', margin: 'md' }
                    ]
                }
            };
        });

        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'flex',
                altText: '您的訂單查詢結果',
                contents: { type: 'carousel', contents: bubbles }
            }]
        });
        return true;
    }

    // 5. 帳號綁定完成
    if (rawUserMessage === '#帳號綁定完成') {
        console.log(`[綁定成功驗證] 開始反查 UID: ${lineUid}`);

        try {
            const usersRef = db.collection('Users');
            const userSnapshot = await usersRef.where('line_uid', '==', lineUid).limit(1).get();

            // 防呆處理
            if (userSnapshot.empty) {
                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: [{ type: 'text', text: '系統查無綁定紀錄，請重新操作。' }]
                });
                return true;
            }

            // 取得權限
            const userData = userSnapshot.docs[0].data();
            const realLevel = parseInt(userData.level) || 0;
            // 組裝基礎訊息
            let replyMessage = {
                type: 'text',
                text: '✅ 恭喜您綁定成功！\n\n您現在可直接輸入需求（例：預算500-700 數量300）開始查價。'
            };

            // 嚴格權限防線 (Level 4 專屬)
            if (realLevel === 4) {
                replyMessage.quickReply = {
                    items: [{
                        type: "action",
                        action: { type: "postback", label: "切換查價視角", data: "action=show_level_menu" }
                    }]
                };
            }

            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [replyMessage]
            });
            console.log(`[綁定成功驗證] 已發送成功歡迎詞給 Level ${realLevel} 使用者。`);

        } catch (err) {
            console.error('[綁定成功驗證] 發生錯誤:', err);
        }
        return true;
    }

    // 以上皆未命中，回傳 false 將控制權歸還給 index.js
    return false;
}

module.exports = { handleStaticCommands };
