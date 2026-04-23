const { admin, db } = require('../utils/firebase');

async function handleSpecialActions(intentParams, dependencies) {
    const { lineClient, replyToken } = dependencies;
    
    // Extracted logic from index.js
    if (intentParams.action === 'borrow_sample') {
                    console.log(`[特急件] 進入借樣品流程`);
                    const orderData = intentParams;

                    // 檢查是否缺乏必要資訊 (無商品明細 或 無公司/收件人)
                    if (!orderData.items || orderData.items.length === 0 || (!orderData.customer?.company && !orderData.customer?.name)) {
                        const sampleTemplate = `請複製以下模板並填寫完整資訊：\n\n@KINYO挺好的 借樣品\n\n公司：\n收件人：\n聯絡電話：\n送貨地址：\n借樣品案名：\n預計歸還日期：\n=================\n【樣品明細】請依下方格式填寫：\n型號： / 數量：`;
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: sampleTemplate }]
                        });
                        return true;
                    }

                    // 生成商品明細字串
                    let itemsText = '';
                    if (orderData.items && Array.isArray(orderData.items)) {
                        orderData.items.forEach(item => {
                            if (item.model) {
                                itemsText += `${item.model} x${item.quantity || 1}\n`;
                            }
                        });
                    }
                    if (!itemsText) itemsText = '未提供商品明細';

                    // 全域清洗物件：強制剔除所有 undefined，防止 Firestore 報錯
                    const safeOrderData = JSON.parse(JSON.stringify(orderData));
                    // 將資料暫存至 Firestore (沿用既有 tempOrders 邏輯)
                    const tempOrderRef = await db.collection('tempOrders').add(safeOrderData);

                    const flexMessage = {
                        type: 'flex',
                        altText: '樣品申請已建立，請確認',
                        contents: {
                            type: 'bubble',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: '#F59E0B',
                                contents: [{ type: 'text', text: '📦 樣品申請已建立，請確認', color: '#ffffff', weight: 'bold' }]
                            },
                            body: {
                                type: 'box', layout: 'vertical', spacing: 'sm',
                                contents: [
                                    { type: 'text', text: `🏢 公司: ${orderData.customer?.company || '未提供'}`, size: 'sm' },
                                    { type: 'text', text: `👤 收件: ${orderData.customer?.name || '未提供'} (${orderData.customer?.phone || '未提供'})`, size: 'sm' },
                                    { type: 'text', text: `📍 地址: ${orderData.customer?.address || '未提供'}`, size: 'sm' },
                                    { type: 'text', text: `📁 案名: ${orderData.customer?.projectName || '未提供'}`, size: 'sm', color: '#E11D48' },
                                    { type: 'text', text: `📅 預計歸還: ${orderData.customer?.returnDate || '未提供'}`, size: 'sm', color: '#E11D48' },
                                    { type: 'separator', margin: 'md' },
                                    { type: 'text', text: itemsText, size: 'sm', wrap: true, margin: 'md' }
                                ]
                            },
                            footer: {
                                type: 'box', layout: 'horizontal', spacing: 'sm',
                                contents: [
                                    {
                                        type: 'button', style: 'primary', color: '#1DB446',
                                        action: { type: 'postback', label: '✅ 確認無誤', data: `action=confirm_sample&id=${tempOrderRef.id}` }
                                    },
                                    {
                                        type: 'button', style: 'secondary',
                                        action: { type: 'postback', label: '❌ 取消申請', data: `action=cancel_temp_order&id=${tempOrderRef.id}` }
                                    }
                                ]
                            }
                        }
                    };
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [flexMessage]
                    });
                    return true; // 執行完特殊意圖後跳過後續商品查詢邏輯
                } else if (intentParams.action === 'reserve_order') {
                    console.log(`[特急件] 進入預留訂單流程`);
                    const reserveData = intentParams;

                    if (!reserveData.orderItems || reserveData.orderItems.length === 0 || (!reserveData.customer?.company && !reserveData.customer?.name)) {
                        const reserveTemplate = `請複製以下模板並填寫完整資訊：\n\n@KINYO挺好的 預留訂單\n\n採購公司：\n收件人：\n聯絡電話：\n送貨地址：\n預留期限：（例：2026/05/31）\n備註：\n=================\n【預留明細】請依下方格式填寫：\n型號： / 數量： / 單價：`;
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: reserveTemplate }]
                        });
                        return true;
                    }

                    // 生成商品明細字串與加總
                    let itemsText = '';
                    let totalAmount = 0;
                    if (reserveData.orderItems && Array.isArray(reserveData.orderItems)) {
                        reserveData.orderItems.forEach(item => {
                            if (item.model) {
                                const price = Number(item.unitPrice) || 0;
                                const qty = Number(item.qty) || 1;
                                itemsText += `${item.model} x${qty}${price > 0 ? ` @${price}` : ''}\n`;
                                totalAmount += price * qty;
                            }
                        });
                    }
                    if (!itemsText) itemsText = '未提供商品明細';

                    const safeReserveData = JSON.parse(JSON.stringify(reserveData));
                    const tempOrderRef = await db.collection('tempOrders').add(safeReserveData);

                    const deadlineDisplay = reserveData.customer?.reserveDeadline || '未提供';

                    const flexMessage = {
                        type: 'flex',
                        altText: '預留訂單已建立，請確認',
                        contents: {
                            type: 'bubble',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: '#6366F1',
                                contents: [{ type: 'text', text: '📌 預留訂單已建立，請確認', color: '#ffffff', weight: 'bold' }]
                            },
                            body: {
                                type: 'box', layout: 'vertical', spacing: 'sm',
                                contents: [
                                    { type: 'text', text: `🏢 公司: ${reserveData.customer?.company || '未提供'}`, size: 'sm' },
                                    { type: 'text', text: `👤 收件: ${reserveData.customer?.name || '未提供'} (${reserveData.customer?.phone || '未提供'})`, size: 'sm' },
                                    { type: 'text', text: `📍 地址: ${reserveData.customer?.address || '未提供'}`, size: 'sm', wrap: true },
                                    { type: 'text', text: `📅 預留期限: ${deadlineDisplay}`, size: 'sm', color: '#E11D48', weight: 'bold' },
                                    { type: 'text', text: `📝 備註: ${reserveData.customer?.remark || '無'}`, size: 'sm' },
                                    { type: 'separator', margin: 'md' },
                                    { type: 'text', text: itemsText, size: 'sm', wrap: true, margin: 'md' },
                                    { type: 'text', text: totalAmount > 0 ? `💰 總計: $${totalAmount}` : '💰 總計: 待確認', size: 'sm', weight: 'bold', color: '#E11D48' }
                                ]
                            },
                            footer: {
                                type: 'box', layout: 'horizontal', spacing: 'sm',
                                contents: [
                                    {
                                        type: 'button', style: 'primary', color: '#1DB446',
                                        action: { type: 'postback', label: '✅ 確認預留', data: `action=confirm_reserve&id=${tempOrderRef.id}` }
                                    },
                                    {
                                        type: 'button', style: 'secondary',
                                        action: { type: 'postback', label: '❌ 取消', data: `action=cancel_temp_order&id=${tempOrderRef.id}` }
                                    }
                                ]
                            }
                        }
                    };
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [flexMessage]
                    });
                    return true;
                } else if (intentParams.action === 'defective_return') {
                    console.log(`[特急件] 進入新品不良流程`);
                    const rmaData = intentParams;

                    // 檢查是否缺乏必要資訊 (無商品明細 或 無聯絡人/地址)
                    if (!rmaData.items || rmaData.items.length === 0 || (!rmaData.customer?.name && !rmaData.customer?.address)) {
                        const rmaTemplate = `請複製以下模板並填寫完整資訊：\n\n@KINYO挺好的 新品不良 (或 來回件)\n\n採購公司：\n客戶姓名：\n客戶聯絡電話：\n取件與換貨地址：\n備註：\n=================\n【不良品明細】請確實填寫故障原因以利判定：\n型號： / 數量： / 故障原因：`;
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: rmaTemplate }]
                        });
                        return true;
                    }

                    let itemsText = '';
                    if (rmaData.items && Array.isArray(rmaData.items)) {
                        rmaData.items.forEach(item => {
                            if (item.model) {
                                itemsText += `${item.model} x${item.quantity || 1}\n⚠️ 原因: ${item.reason || '未說明'}\n`;
                            }
                        });
                    }
                    if (!itemsText) itemsText = '未提供明細';

                    // 全域清洗物件：強制剔除所有 undefined，防止 Firestore 報錯
                    const safeRmaData = JSON.parse(JSON.stringify(rmaData));
                    const tempOrderRef = await db.collection('tempOrders').add(safeRmaData);

                    const flexMessage = {
                        type: 'flex',
                        altText: '來回件申請已建立，請確認',
                        contents: {
                            type: 'bubble',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: '#E11D48',
                                contents: [{ type: 'text', text: '⚠️ 來回件申請已建立，請確認', color: '#ffffff', weight: 'bold' }]
                            },
                            body: {
                                type: 'box', layout: 'vertical', spacing: 'sm',
                                contents: [
                                    { type: 'text', text: `🏢 公司: ${rmaData.customer?.company || '未提供'}`, size: 'sm' },
                                    { type: 'text', text: `👤 客戶: ${rmaData.customer?.name || '未提供'} (${rmaData.customer?.phone || '未提供'})`, size: 'sm' },
                                    { type: 'text', text: `📍 取件地址: ${rmaData.customer?.address || '未提供'}`, size: 'sm', color: '#E11D48', weight: 'bold' },
                                    { type: 'text', text: `📝 備註: ${rmaData.customer?.remark || '無'}`, size: 'sm' },
                                    { type: 'separator', margin: 'md' },
                                    { type: 'text', text: itemsText, size: 'sm', wrap: true, margin: 'md' }
                                ]
                            },
                            footer: {
                                type: 'box', layout: 'horizontal', spacing: 'sm',
                                contents: [
                                    {
                                        type: 'button', style: 'primary', color: '#1DB446',
                                        action: { type: 'postback', label: '✅ 確認無誤', data: `action=confirm_rma&id=${tempOrderRef.id}` }
                                    },
                                    {
                                        type: 'button', style: 'secondary',
                                        action: { type: 'postback', label: '❌ 取消申請', data: `action=cancel_temp_order&id=${tempOrderRef.id}` }
                                    }
                                ]
                            }
                        }
                    };
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [flexMessage]
                    });
                } else if (intentParams.action === 'batch_order') {
                    console.log(`[特急件] 進入行動屋批次出貨流程`);
                    const batchData = intentParams.orders;
                    
                    if (!batchData || !Array.isArray(batchData) || batchData.length === 0) {
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '無法成功解析批次訂單，請確認您的格式是否正確（使用多個橫線分隔訂單）。' }]
                        });
                        return true;
                    }

                    // 限制最多 10 筆 (LINE Carousel 上限)
                    const maxOrders = batchData.slice(0, 10);
                    const bubbles = [];
                    
                    for (const [index, order] of maxOrders.entries()) {
                        // 1. 產生暫存 ID 並寫入 Firestore
                        const safeOrder = JSON.parse(JSON.stringify(order));
                        const tempOrderRef = await db.collection('tempOrders').add({
                            ...safeOrder,
                            batchIndex: index + 1,
                            isBatch: true,
                            createdAt: admin.firestore.FieldValue.serverTimestamp()
                        });

                        // 2. 組裝商品明細 (轉化為 Box)
                        const itemBoxes = [];
                        if (order.items && Array.isArray(order.items)) {
                            order.items.forEach(item => {
                                // 原始擷取到的型號
                                let rawModel = item.model || item.name || '';

                                // 建立別名對照表 (未來有新規則可直接在此擴充)
                                const modelAlias = {
                                    'HD08': 'MHDP08',
                                    'HD-08': 'MHDP08',
                                    'HD 08': 'MHDP08'
                                };

                                // 將字串轉大寫並去除前後空白，進行比對轉換
                                const upperModel = rawModel.toUpperCase().trim();
                                const finalModel = modelAlias[upperModel] || upperModel;
                                
                                // 後續寫入資料庫或組合 Flex Message 的型號，請全面改用 finalModel
                                item.model = finalModel;

                                if (item.model) {
                                    itemBoxes.push({
                                        type: 'box', layout: 'horizontal', margin: 'sm',
                                        contents: [
                                            { type: 'text', text: `${item.model} x${item.quantity || 1}`, size: 'sm', flex: 3 }
                                        ]
                                    });
                                }
                            });
                        }
                        if (itemBoxes.length === 0) {
                            itemBoxes.push({
                                type: 'box', layout: 'horizontal', margin: 'sm',
                                contents: [ { type: 'text', text: '未提供明細', size: 'sm', flex: 3 } ]
                            });
                        }

                        // 3. 建立單張 Carousel Bubble
                        bubbles.push({
                            type: 'bubble',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: '#E11D48',
                                contents: [{ type: 'text', text: `📝 行動屋訂單 (${index + 1}/${maxOrders.length})`, color: '#ffffff', weight: 'bold' }]
                            },
                            body: {
                                type: 'box', layout: 'vertical', spacing: 'sm',
                                contents: [
                                    { type: 'text', text: `🏢 收件：${order.customer?.name || '無店名'}`, size: 'sm', weight: 'bold' },
                                    { type: 'text', text: `📞 電話：${order.customer?.phone || '未提供'}`, size: 'sm' },
                                    { type: 'text', text: `📍 地址：${order.customer?.address || '無地址'}`, size: 'sm', wrap: true },
                                    { type: 'separator', margin: 'md' },
                                    ...itemBoxes
                                ]
                            },
                            footer: {
                                type: 'box', layout: 'vertical',
                                contents: [
                                    {
                                        type: 'button', style: 'primary', color: '#1DB446',
                                        // 沿用您的 API 邏輯：傳入單筆 ID，後台用 idsStr.split(',') 一樣可以處理單筆
                                        action: { type: 'postback', label: '✅ 單筆確認送出', data: `action=confirm_batch_order&ids=${tempOrderRef.id}` }
                                    },
                                    {
                                        type: 'button', style: 'secondary', margin: 'sm',
                                        action: { type: 'postback', label: '❌ 刪除此筆', data: `action=cancel_batch_order&ids=${tempOrderRef.id}` }
                                    }
                                ]
                            }
                        });
                    }

                    // 4. 打包為 Flex Carousel 訊息
                    const flexMessage = {
                        type: 'flex',
                        altText: `行動屋批次訂單解析 (${maxOrders.length}筆)`,
                        contents: {
                            type: 'carousel',
                            contents: bubbles
                        }
                    };

                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [
                            { type: 'text', text: `✅ 批次解析成功！擷取到 ${batchData.length} 筆，已顯示前 ${maxOrders.length} 筆。請左右滑動確認，並點擊卡片下方按鈕單獨處理出貨。` },
                            flexMessage
                        ]
                    });
                    
                    return true; // 執行完特殊意圖後跳過後續查詢邏輯
                }
    
    return false; // unhandled
}

module.exports = { handleSpecialActions };
