const { admin, db } = require('../utils/firebase');
const { transporter } = require('../utils/mailer');

// --- Helper Functions ---
const normalize = (s) => String(s).replace(/[-\s]/g, '').toUpperCase().trim();
const APPLY_PRICE_EMAILS = [process.env.GMAIL_USER || 'sam.kuo@kinyo.tw', 'iris.chen@nakay.com.tw'];

/**
 * 處理所有與 LINE 按鈕、卡片互動相關的 Postback 事件
 */
async function handlePostback(event, userContext, lineClient) {
    const lineUid = event.source.userId;
    const groupId = event.source.groupId || event.source.roomId;
    const currentViewLevel = userContext.currentViewLevel;
    const realLevel = userContext.realLevel;
    const userEmail = userContext.userEmail;
    const replyToken = event.replyToken;

    // 強制寫入 Firebase 雲端日誌以供稽核
    console.log(`[Postback 執行] 來源群組: ${groupId || '無'}, 點擊者: ${lineUid}, 繼承等級: ${currentViewLevel}`);

    // 若頂層變數遺失的防呆攔截
    if (!currentViewLevel) {
        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: '⛔ 系統錯誤：無法取得全域報價等級。' }]
        });
        return;
    }

    const postbackData = event.postback.data;
    const params = new URLSearchParams(postbackData);
    const action = params.get('action');

    // ============================================
    // 區塊 1：非立即結束的路由 (管理員/使用者選單切換與文字報價)
    // 原本由 shouldSkipSearch 攔截的部分
    // ============================================
    const isPublicAction = action === 'get_text_quote' || action === 'confirm_order' || action === 'cancel_order';
    if (!isPublicAction && realLevel !== 4 && (action === 'show_level_menu' || action === 'set_level' || action === 'get_text_quote')) {
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '您無權限執行此指令。' }] });
        return;
    }

    if (action === 'show_level_menu') {
        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'text',
                text: '請選擇要切換的報價視角：',
                quickReply: {
                    items: [
                        { type: 'action', action: { type: 'postback', label: 'Level 1', data: 'action=set_level&value=1' } },
                        { type: 'action', action: { type: 'postback', label: 'Level 2', data: 'action=set_level&value=2' } },
                        { type: 'action', action: { type: 'postback', label: 'Level 3', data: 'action=set_level&value=3' } },
                        { type: 'action', action: { type: 'postback', label: '預設自己 (Level 4)', data: 'action=set_level&value=4' } }
                    ]
                }
            }]
        });
        return;
    } else if (action === 'set_level') {
        const newLevel = parseInt(params.get('value'), 10);
        await db.collection('Users').doc(userEmail).update({ currentViewLevel: newLevel });
        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{
                type: 'text',
                text: `模式已切換！目前視角：Level ${newLevel} 經銷商報價。您現在輸入的關鍵字都會套用此費率。`,
                quickReply: {
                    items: [{ type: 'action', action: { type: 'postback', label: '切換視角', data: 'action=show_level_menu' } }]
                }
            }]
        });
        return;
    } else if (action === 'get_text_quote') {
        const quoteModel = decodeURIComponent(params.get('model'));
        const quoteQty = parseInt(params.get('qty'), 10) || 0;
        const evalQty = quoteQty > 0 ? quoteQty : 50;

        try {
            const targetModel = normalize(quoteModel);
            const productSnap = await db.collection('Products').get();
            const allProducts = productSnap.docs.map(doc => doc.data());

            // 尋找資料庫中「型號」或「品名」包含該主型號的任一商品
            const p = allProducts.find(prod => {
                if (!prod) return false;
                const dbModelNorm = prod.model ? normalize(prod.model) : "";
                const dbNameNorm = prod.name ? normalize(prod.name) : "";

                // 只要正規化後的型號或品名「包含」目標字串，立刻命中
                return dbModelNorm.includes(targetModel) || dbNameNorm.includes(targetModel);
            });

            if (!p) {
                console.warn(`[Debug] 搜尋目標: ${targetModel}, 資料庫型號範例: ${allProducts.length > 0 ? allProducts[0].model : '無'}`);
                await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '查無商品資料，無法報價。' }] });
                return;
            }

            const cost = parseInt(p.cost) || 0;

            // 計算特定數量的單價
            // --- 靜默數量天花板 (Stealth Quantity Ceiling) ---
            let calc_qty = evalQty;
            if (currentViewLevel === 1 && calc_qty > 100) calc_qty = 100;
            if (currentViewLevel === 2 && calc_qty > 500) calc_qty = 500;
            if (currentViewLevel === 3 && calc_qty > 1000) calc_qty = 1000;

            // 計算特定數量的單價 (含稅)
            let divisor = 0.73; // 預設防呆
            if (currentViewLevel === 1) {
                if (calc_qty >= 100) divisor = 0.75;
                else divisor = 0.73;
            } else if (currentViewLevel === 2) {
                if (calc_qty >= 500) divisor = 0.82;
                else if (calc_qty >= 300) divisor = 0.80;
                else if (calc_qty >= 100) divisor = 0.76;
                else divisor = 0.74;
            } else if (currentViewLevel >= 3) {
                if (calc_qty >= 3000 && currentViewLevel >= 4) divisor = 0.89;
                else if (calc_qty >= 1000) divisor = 0.865;
                else if (calc_qty >= 500) divisor = 0.845;
                else if (calc_qty >= 300) divisor = 0.825;
                else if (calc_qty >= 100) divisor = 0.79;
                else divisor = 0.76;
            }

            const finalPrice = Math.ceil((cost / divisor) * 1.05);

            const textMsg = `【${p.model}】${p.name || '未命名'}\n賣場售價：${p.marketPrice || '未提供'}\n末售價格：${p.minPrice || '未提供'}\n--------------------\n採購價格：\n${evalQty}個：${finalPrice}\n\n商品連結：${p.productUrl || '無'}`;
            let replyMsgOpt = { type: 'text', text: textMsg };
            if (realLevel === 4) {
                replyMsgOpt.quickReply = {
                    items: [{ type: 'action', action: { type: 'postback', label: '切換查價視角', data: 'action=show_level_menu' } }]
                };
            }

            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [replyMsgOpt]
            });
            console.log(`✅ [文字報價] 已傳送單一數量報價給 ${userEmail} (型號: ${quoteModel}, 數量: ${evalQty})`);
        } catch (err) {
            console.error("文字報價發生錯誤", err);
        }
        return;
    }

    // ============================================
    // 區塊 2：立即處理與返回的路由 (訂單相關)
    // ============================================
    if (action === 'confirm_order' || action === 'cancel_order') {
        const orderId = params.get('orderId');
        const orderRef = db.collection('PendingOrders').doc(orderId);

        try {
            let finalStatus = '';
            await db.runTransaction(async (t) => {
                const doc = await t.get(orderRef);
                if (!doc.exists) throw new Error('找不到該筆訂單');
                if (doc.data().status !== 'waiting') throw new Error('此訂單已處理過');

                finalStatus = action === 'confirm_order' ? '處理中' : 'cancelled';

                const updateData = { status: finalStatus };
                if (finalStatus === '處理中') {
                    updateData.sourceId = event.source.groupId || event.source.userId;
                }
                t.update(orderRef, updateData);

                // 若確認訂單，觸發 SMTP 發送通知信
                if (finalStatus === '處理中') {
                    const orderData = doc.data();
                    const functionUrl = `https://asia-east1-kinyo-price.cloudfunctions.net/markOrderShipped?orderId=${orderId}`;

                    let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
                    itemsHtml += '<tr style="background-color: #f2f2f2;"><th>商品型號</th><th>數量</th><th>單價</th><th>小計</th></tr>';

                    if (orderData.items && Array.isArray(orderData.items)) {
                        orderData.items.forEach(item => {
                            const model = item.model || item.name || item.product || '未知型號';
                            const qty = item.quantity || item.qty || item.count || item.amount || 1;
                            let subtotal = item.subtotal || item.total || item.totalPrice || 0;
                            let price = item.price || item.unitPrice || 0;

                            if (subtotal === 0 && price > 0 && qty > 0) subtotal = price * qty;
                            if (price === 0 && subtotal > 0 && qty > 0) price = Math.round(subtotal / qty);

                            const priceDisplay = price > 0 ? `$${price}` : '<span style="color:red;">待確認</span>';
                            const subtotalDisplay = subtotal > 0 ? `$${subtotal}` : '<span style="color:red;">待確認</span>';
                            itemsHtml += `<tr><td>${model}</td><td align="center">${qty}</td><td align="right">${priceDisplay}</td><td align="right">${subtotalDisplay}</td></tr>`;
                        });
                    }

                    if (orderData.shippingFee) {
                        itemsHtml += `<tr><td colspan="3" align="right">運費</td><td align="right">$${orderData.shippingFee}</td></tr>`;
                    }
                    itemsHtml += '</table>';

                    const totalDisplay = orderData.totalAmount > 0 ? `$${orderData.totalAmount}` : '<span style="color:red;">待確認 (依實際出貨單為準)</span>';

                    const mailOptions = {
                        from: 'KINYO 報價系統 <sam.kuo@kinyo.tw>',
                        to: ['sam.kuo@kinyo.tw', 'iris.chen@nakay.com.tw'],
                        subject: `[新訂單通知] ${orderData.customer?.company || ''} ${orderData.customer?.name} - 總計 ${totalDisplay.replace(/<[^>]+>/g, '')}`,
                        html: `<h2 style="color: #333;">新訂單通知</h2>...[詳見原始邏輯]...` // 將在後續修正以完整保留原本 HTML
                    };
                    
                    mailOptions.html = `
                      <h2 style="color: #333;">新訂單通知</h2>
                      <p><strong>訂單編號:</strong> ${orderId}</p>
                      <p><strong>採購公司:</strong> ${orderData.customer?.company || '未提供'}</p>
                      <p><strong>收件人:</strong> ${orderData.customer?.name}</p>
                      <p><strong>電話:</strong> ${orderData.customer?.phone}</p>
                      <p><strong>地址:</strong> ${orderData.customer?.address || '未提供'}</p>
                      <p><strong>預期到貨:</strong> ${orderData.customer?.deliveryTime || '未指定'}</p>
                      <p><strong>備註:</strong> <span style="color: #E11D48;">${orderData.customer?.remark || '無'}</span></p>
                      <hr>
                      <h3 style="color: #333;">🛒 訂購商品明細：</h3>
                      ${itemsHtml}
                      <h3 style="color: #E11D48;">總計金額: ${totalDisplay}</h3>
                      <hr>
                      <br>
                      <a href="${functionUrl}" style="display:inline-block; padding:14px 28px; color:white; background-color:#28a745; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; margin-right: 10px;">✅ 標記為已出貨</a>
                      <a href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${orderId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#F59E0B; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">⚠️ 訂單異常 / 通知客戶</a>
                    `;

                    transporter.sendMail(mailOptions).catch(err => console.error("SMTP 發信失敗:", err));

                    try {
                        const configDoc = await admin.firestore().collection('SystemConfig').doc('OrderSettings').get();
                        if (configDoc.exists && configDoc.data().notifyGroupId) {
                            const targetGroupId = configDoc.data().notifyGroupId;
                            const companyName = orderData.customer?.company || '未提供';
                            const notifyText = `⚠️ 新訂單通知\n編號：${orderId.substring(0, 8)}\n採購公司：${companyName}\n預期到貨：${orderData.customer?.deliveryTime || '未指定'}\n總金額：$${orderData.totalAmount}\n\n請盡速查看 Email 處理出貨作業。`;
                            await lineClient.pushMessage({ to: targetGroupId, messages: [{ type: 'text', text: notifyText }] });
                        }
                    } catch (pushError) {
                        console.error('[系統警告] 推播至接單總部失敗:', pushError);
                    }
                }
            });

            const replyMsg = finalStatus === '處理中' ? '✅ 訂單已成功送出！我們將盡快為您處理。' : '❌ 訂單已取消。';
            console.log(`[訂單狀態更新] ${orderId} -> ${finalStatus}`);
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: replyMsg }] });
        } catch (err) {
            console.error('[訂單處理錯誤]', err);
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `⚠️ 處理失敗: ${err.message}` }] });
        }
        return;
    } else if (action === 'cancel_temp_order') {
        const tempOrderId = params.get('id');
        try {
            await db.collection('tempOrders').doc(tempOrderId).delete();
            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [{ type: 'text', text: '❌ 已取消此申請。' }]
            });
            console.log(`[操作取消] 暫存單據已移除: ${tempOrderId}`);
        } catch (err) {
            console.error('[取消操作錯誤]', err);
            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [{ type: 'text', text: `⚠️ 取消失敗: ${err.message}` }]
            });
        }
        return;
    } else if (action === 'confirm_sample') {
        const orderId = params.get('id');
        try {
            const tempDocRef = db.collection('tempOrders').doc(orderId);
            const tempDoc = await tempDocRef.get();

            if (!tempDoc.exists) throw new Error('找不到該申請紀錄，可能已處理過或失效。');
            const orderData = tempDoc.data();

            const newOrderId = `SMP${Date.now()}`;
            orderData.orderId = newOrderId;
            orderData.status = '處理中_借樣品';
            orderData.createdAt = admin.firestore.FieldValue.serverTimestamp();
            orderData.userId = lineUid;
            orderData.userEmail = userEmail;
            orderData.sourceId = event.source.groupId || event.source.userId;

            await db.collection('PendingOrders').doc(newOrderId).set(orderData);
            await tempDocRef.delete();

            let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
            itemsHtml += '<tr style="background-color: #f2f2f2;"><th>商品型號</th><th>數量</th></tr>';

            let totalQty = 0;
            if (orderData.items && Array.isArray(orderData.items)) {
                orderData.items.forEach(item => {
                    itemsHtml += `<tr><td>${item.model}</td><td align="center">${item.quantity}</td></tr>`;
                    totalQty += Number(item.quantity) || 0;
                });
            }
            itemsHtml += '</table>';

            const functionUrl = `https://asia-east1-kinyo-price.cloudfunctions.net/markOrderShipped?orderId=${newOrderId}`;

            const mailOptions = {
                from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                to: ['sam.kuo@kinyo.tw', 'iris.chen@nakay.com.tw'],
                subject: `[借樣品通知] ${orderData.customer?.company || ''} ${orderData.customer?.name} - 共 ${totalQty} 件`,
                html: `
                  <h2 style="color: #F59E0B;">📦 借樣品申請通知</h2>
                  <p><strong>申請編號:</strong> ${newOrderId}</p>
                  <p><strong>案名:</strong> <span style="color: #E11D48;">${orderData.customer?.projectName || '未提供'}</span></p>
                  <p><strong>預計歸還:</strong> <span style="color: #E11D48;">${orderData.customer?.returnDate || '未提供'}</span></p>
                  <hr>
                  <p><strong>採購公司:</strong> ${orderData.customer?.company || '未提供'}</p>
                  <p><strong>收件人:</strong> ${orderData.customer?.name}</p>
                  <p><strong>電話:</strong> ${orderData.customer?.phone}</p>
                  <p><strong>地址:</strong> ${orderData.customer?.address || '未提供'}</p>
                  <hr>
                  <h3 style="color: #333;">🛒 借用商品明細：</h3>
                  ${itemsHtml}
                  <hr>
                  <br>
                  <p style="color: #666; font-size: 13px;">※ 若樣品已寄出，可點擊下方按鈕結案；若有缺貨或異常，可點擊通知客戶</p>
                  <a href="${functionUrl}" style="display:inline-block; padding:14px 28px; color:white; background-color:#28a745; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; margin-right: 10px;">✅ 標記為已出貨/結案</a>
                  <a href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${newOrderId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#F59E0B; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">⚠️ 訂單異常 / 通知客戶</a>
                `
            };
            transporter.sendMail(mailOptions).catch(err => console.error("借樣品 SMTP 發信失敗:", err));

            const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
            if (configDoc.exists && configDoc.data().notifyGroupId) {
                const targetGroupId = configDoc.data().notifyGroupId;
                const companyName = orderData.customer?.company || '未提供';
                const projectName = orderData.customer?.projectName || '未提供';
                const notifyText = `📦 [借樣品通知]\n編號：${newOrderId.substring(0, 8)}\n公司：${companyName}\n案名：${projectName}\n項目：共 ${totalQty} 件\n\n請盡速查看 Email 處理樣品寄送作業。`;
                await lineClient.pushMessage({ to: targetGroupId, messages: [{ type: 'text', text: notifyText }] });
            }

            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '✅ 借樣品申請已成功送出！' }] });
            console.log(`[借樣品狀態更新] 成功建立 ${newOrderId}`);
        } catch (err) {
            console.error('[借樣品處理錯誤]', err);
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `⚠️ 申請失敗: ${err.message}` }] });
        }
        return;
    } else if (action === 'confirm_rma') {
        const orderId = params.get('id');
        try {
            const docRef = db.collection('tempOrders').doc(orderId);
            const doc = await docRef.get();

            if (!doc.exists) throw new Error('找不到該申請紀錄，可能已處理過或失效。');
            const rmaData = doc.data();
            const rmaDisplayId = `RMA${Date.now()}`;

            await db.collection('PendingOrders').doc(rmaDisplayId).set({
                ...rmaData,
                orderId: rmaDisplayId,
                userId: lineUid,
                userEmail: userEmail,
                sourceId: event.source.groupId || event.source.userId,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                status: '處理中_來回件'
            });
            await docRef.delete();

            let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
            itemsHtml += '<tr style="background-color: #f2f2f2;"><th>不良品型號</th><th>數量</th><th>故障原因</th></tr>';
            if (rmaData.items && Array.isArray(rmaData.items)) {
                rmaData.items.forEach(item => {
                    itemsHtml += `<tr><td>${item.model}</td><td align="center">${item.quantity}</td><td style="color: #E11D48;">${item.reason || '未提供'}</td></tr>`;
                });
            }
            itemsHtml += '</table>';

            const mailOptions = {
                from: process.env.GMAIL_USER || 'sam.kuo@kinyo.tw',
                to: [process.env.GMAIL_USER || 'sam.kuo@kinyo.tw', 'iris.chen@nakay.com.tw'],
                subject: `[新品不良派車] ${rmaData.customer?.company || ''} - ${rmaData.customer?.name || ''}`,
                html: `
                  <h2 style="color: #E11D48;">⚠️ 新品不良來回件派車單</h2>
                  <p><strong>單號:</strong> ${rmaDisplayId}</p>
                  <p><strong>採購公司:</strong> ${rmaData.customer?.company || '未提供'}</p>
                  <p><strong>客戶姓名:</strong> ${rmaData.customer?.name}</p>
                  <p><strong>聯絡電話:</strong> ${rmaData.customer?.phone}</p>
                  <p><strong>取件/換貨地址:</strong> <span style="color: #E11D48; font-weight: bold;">${rmaData.customer?.address || '未提供'}</span></p>
                  <p><strong>備註:</strong> ${rmaData.customer?.remark || '無'}</p>
                  <hr>
                  <h3 style="color: #333;">📦 不良品明細與原因：</h3>
                  ${itemsHtml}
                  <hr>
                  <br>
                  <p style="color: #666; font-size: 13px;">※ 若不良品已安排派件，可點擊下方按鈕結案並通知客戶</p>
                  <a href="https://asia-east1-kinyo-price.cloudfunctions.net/markRMACompleted?rmaId=${rmaDisplayId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#1DB446; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">✅ 標記為處理完成_已派車</a>
                `
            };
            transporter.sendMail(mailOptions).catch(err => console.error("RMA SMTP 發信失敗:", err));

            const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
            if (configDoc.exists && configDoc.data().notifyGroupId) {
                const targetGroupId = configDoc.data().notifyGroupId;
                const notifyText = `⚠️ [新品不良派車]\n公司：${rmaData.customer?.company || '未提供'}\n客戶：${rmaData.customer?.name}\n取件地址：${rmaData.customer?.address || '未提供'}\n\n請盡速查看 Email 安排物流派車。`;
                await lineClient.pushMessage({ to: targetGroupId, messages: [{ type: 'text', text: notifyText }] });
            }

            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '✅ 來回件申請已成功送出！我們將盡快安排物流派車。' }] });
            console.log(`[RMA狀態更新] 成功建立 ${rmaDisplayId}`);
        } catch (err) {
            console.error('[RMA處理錯誤]', err);
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `⚠️ 申請失敗: ${err.message}` }] });
        }
        return;
    } else if (action === 'confirm_batch_order') {
        const idsStr = params.get('ids');
        if (!idsStr) {
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '無法取得批次訂單 ID，請重新操作。' }] });
            return;
        }
        const orderIds = idsStr.split(',');
        let successCount = 0;
        let errorCount = 0;

        for (const id of orderIds) {
            try {
                const tempDocRef = db.collection('tempOrders').doc(id);
                const tempDoc = await tempDocRef.get();
                if (!tempDoc.exists) continue;

                const orderData = tempDoc.data();
                const newOrderId = `BCH${Date.now()}${Math.floor(Math.random() * 100)}`;

                orderData.orderId = newOrderId;
                orderData.status = '處理中_批次';
                orderData.createdAt = admin.firestore.FieldValue.serverTimestamp();
                orderData.userId = lineUid;
                orderData.userEmail = userEmail;
                orderData.sourceId = event.source.groupId || event.source.userId;

                let totalQty = 0;
                if (orderData.items && Array.isArray(orderData.items)) {
                    orderData.items.forEach(item => {
                        totalQty += Number(item.quantity) || 0;
                        item.unitPrice = 0;
                        item.subtotal = 0;
                    });
                }
                orderData.totalAmount = 0;
                orderData.shippingFee = 0;

                await db.collection('PendingOrders').doc(newOrderId).set(orderData);
                await tempDocRef.delete();
                successCount++;

                let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
                itemsHtml += '<tr style="background-color: #f2f2f2;"><th>商品型號</th><th>數量</th></tr>';

                if (orderData.items && Array.isArray(orderData.items)) {
                    orderData.items.forEach(item => {
                        itemsHtml += `<tr><td>${item.model}</td><td align="center">${item.quantity}</td></tr>`;
                    });
                }
                itemsHtml += '</table>';
                const functionUrl = `https://asia-east1-kinyo-price.cloudfunctions.net/markOrderShipped?orderId=${newOrderId}`;

                const mailOptions = {
                    from: 'KINYO 報價系統 <sam.kuo@kinyo.tw>',
                    to: ['sam.kuo@kinyo.tw', 'iris.chen@nakay.com.tw'],
                    subject: `[行動屋批次出貨] ${orderData.customer?.company || ''} ${orderData.customer?.name} - 共 ${totalQty} 件`,
                    html: `
                      <h2 style="color: #0055aa;">📦 行動屋批次出貨單</h2>
                      <p><strong>訂單編號:</strong> ${newOrderId}</p>
                      <p><strong>採購門市:</strong> ${orderData.customer?.company || ''} ${orderData.customer?.name}</p>
                      <p><strong>電話:</strong> ${orderData.customer?.phone}</p>
                      <p><strong>地址:</strong> ${orderData.customer?.address || '未提供'}</p>
                      <p><strong>備註:</strong> <span style="color: #E11D48;">${orderData.customer?.remark || '無'}</span></p>
                      <hr>
                      <h3 style="color: #333;">🛒 訂購商品明細：</h3>
                      ${itemsHtml}
                      <hr>
                      <br>
                      <a href="${functionUrl}" style="display:inline-block; padding:14px 28px; color:white; background-color:#28a745; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; margin-right: 10px;">✅ 標記為已出貨</a>
                      <a href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${newOrderId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#F59E0B; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">⚠️ 訂單異常 / 通知客戶</a>
                    `
                };
                transporter.sendMail(mailOptions).catch(err => console.error("批次 SMTP 發信失敗:", err));

                const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
                if (configDoc.exists && configDoc.data().notifyGroupId) {
                    const targetGroupId = configDoc.data().notifyGroupId;
                    let notifyItemsText = '';
                    if (orderData.items && Array.isArray(orderData.items)) {
                        orderData.items.forEach(item => {
                            notifyItemsText += `- ${item.model} x${item.quantity}\n`;
                        });
                    }

                    const notifyText = `🚨 [行動屋出貨成立]\n\n🏢 門市：${orderData.customer?.company || ''} ${orderData.customer?.name}\n📍 地址：${orderData.customer?.address || '未提供'}\n📝 備註：${orderData.customer?.remark || '無'}\n\n📦 訂單明細：\n${notifyItemsText}\n(總計 ${totalQty} 件)\n\n信件已發送至助理信箱備查。`;
                    await lineClient.pushMessage({ to: targetGroupId, messages: [{ type: 'text', text: notifyText }] });
                }

            } catch (err) {
                console.error(`[批次處理錯誤] ID: ${id}`, err);
                errorCount++;
            }
        }

        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `✅ 批次訂單已全部確認！成功建立 ${successCount} 筆出貨單。` }] });
        return;

    } else if (action === 'cancel_batch_order') {
        const idsStr = params.get('ids');
        if (!idsStr) {
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '無法取得批次訂單 ID，請重新操作。' }] });
            return;
        }
        const orderIds = idsStr.split(',');
        let deletedCount = 0;

        for (const id of orderIds) {
            try {
                const tempDocRef = db.collection('tempOrders').doc(id);
                await tempDocRef.delete();
                deletedCount++;
            } catch (err) {
                console.error(`[取消批次錯誤] ID: ${id}`, err);
            }
        }

        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `❌ 已成功取消整批 ${deletedCount} 筆訂單。` }] });
        return;

    } else if (action === 'confirm_special') {
        const requestId = params.get('id');
        const requestDoc = await db.collection('SpecialRequests').doc(requestId).get();

        if (!requestDoc.exists || requestDoc.data().status !== 'pending') {
            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '⚠️ 此申請已處理或已失效。' }] });
            return;
        }

        const data = requestDoc.data().data;
        const emailHtml = `
        <h2>廠價申請單</h2>
        <table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px;">
            <tr><th width="30%" align="left" bgcolor="#f3f4f6">單位</th><td>${data.department}</td></tr>
            <tr><th align="left" bgcolor="#f3f4f6">客戶名稱</th><td>${data.customer}</td></tr>
            <tr><th align="left" bgcolor="#f3f4f6">客編</th><td>${data.customerId}</td></tr>
            <tr><th align="left" bgcolor="#f3f4f6">型號</th><td>${data.model}</td></tr>
            <tr><th align="left" bgcolor="#f3f4f6">數量</th><td>${data.quantity} PCS</td></tr>
            <tr><th align="left" bgcolor="#f3f4f6">時間</th><td>${data.time}</td></tr>
            <tr><th align="left" bgcolor="#fee2e2">申請新廠價(未)</th><td style="color:#e11d48; font-weight:bold;">${data.newFactoryPrice}</td></tr>
            <tr><th align="left" bgcolor="#f3f4f6">銷售/回收價格(未)</th><td>${data.salesPrice}</td></tr>
        </table>
        <br>
        <p style="color: #e11d48; font-size: 14px; font-weight: bold;">
            [系統提示] 此為系統自動代發信件。相關佐證圖片與對話紀錄，請審核主管逕行至【KINYO 特販九】LINE 群組查閱。
        </p>
        `;

        const mailOptions = {
            from: 'KINYO 報價系統 <sam.kuo@kinyo.tw>',
            to: APPLY_PRICE_EMAILS,
            subject: `【廠價申請】${data.department} + ${data.customer} + ${data.model}`,
            html: emailHtml
        };

        transporter.sendMail(mailOptions).catch(err => console.error("廠價申請 SMTP 發信失敗:", err));
        await db.collection('SpecialRequests').doc(requestId).update({ status: 'sent' });

        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `✅ 廠價申請信件已成功發送至指定主管信箱。` }] });
        return;

    } else if (action === 'cancel_special') {
        await db.collection('SpecialRequests').doc(params.get('id')).update({ status: 'cancelled' });
        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '❌ 已取消此申請草稿。' }] });
        return;
    }
}

module.exports = {
    handlePostback
};
