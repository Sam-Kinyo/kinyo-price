const { admin, db } = require('../utils/firebase');
const { calculateLevelPrice } = require('../utils/priceCalculator');
const { matchCustomerByCompany } = require('./customerMatcher');

async function processOrder(intentParams, userContext, event, lineClient) {
    console.log(`[訂單處理] 開始處理下單意圖`);
    const { level, lineUid, userEmail, realLevel } = userContext;
    const currentViewLevel = level;

    if (!intentParams.orderItems || !Array.isArray(intentParams.orderItems)) {
        await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: '⚠️ AI 無法正確解析您的訂單內容，請確保符合正規下單格式，並註記每一項商品的明確數量與單位。' }]
        });
        return;
    }

    
    const productsSnapshot = await db.collection('Products').get();
    const products = productsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    let totalAmount = 0;
    const validOrderItems = [];
    const invalidModels = [];
    const abnormalPriceModels = [];
    const outOfStockModels = [];

    for (const item of intentParams.orderItems) {
        let rawModel = item.model || item.name || '';
        const modelAlias = {
            'HD08': 'MHDP08',
            'HD-08': 'MHDP08',
            'HD 08': 'MHDP08'
        };
        const upperModel = rawModel.toUpperCase().trim();
        const finalModel = modelAlias[upperModel] || upperModel;
        item.model = finalModel;

        const sanitizeModel = (str) => str ? str.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() : '';
        const itemSanitized = sanitizeModel(item.model);
        let product = products.find(p => sanitizeModel(p.model) === itemSanitized);

        if (!product) {
            // 處理 Gemini 回傳「KY-2022 藍牙K歌音箱」因為「K」而造成 sanitize 變成 ky2022k 的問題
            const firstWord = item.model.split(' ')[0];
            const firstWordSanitized = sanitizeModel(firstWord);
            if (firstWordSanitized) {
                product = products.find(p => sanitizeModel(p.model) === firstWordSanitized);
            }
        }

        if (!product) {
            // 退回 startsWith 確保更包容的配對
            product = products.find(p => {
                const pSanitized = sanitizeModel(p.model);
                return pSanitized && pSanitized.length >= 3 && itemSanitized.startsWith(pSanitized);
            });
        }

        if (product) {
            if (item.unit === '箱' || item.unit === '件') {
                const boxQty = parseInt(product.cartonQty) || 1;
                if (boxQty > 1) {
                    item.qty = item.qty * boxQty;
                    console.log(`[單位轉換] ${item.model} 單位為 ${item.unit}，箱入數為 ${boxQty}，總數量調整為 ${item.qty}`);
                }
            }

            const currentStock = (product.inventory !== undefined && product.inventory !== null) ? Number(product.inventory) : 99999;
            if (item.qty > currentStock) {
                console.log(`[庫存提示] ${item.model} 轉預購: 需求 ${item.qty} > 庫存 ${currentStock}`);
                outOfStockModels.push(`${product.model} (僅剩 ${currentStock})`);
            }

            // Absolute floor price check
            let bottomDivisor = 0.75;
            if (currentViewLevel === 1) bottomDivisor = 0.75;
            else if (currentViewLevel === 2) bottomDivisor = 0.82;
            else if (currentViewLevel === 3) bottomDivisor = 0.865;
            else if (currentViewLevel >= 4) bottomDivisor = 0.89;

            const absoluteFloorPrice = Math.ceil(((product.cost || 0) / bottomDivisor) * 1.05) * 0.9;

            const systemFinalPrice = calculateLevelPrice(product.cost || 0, currentViewLevel, item.qty);
            let appliedPrice = systemFinalPrice;

            let parsedUnitPrice = null;
            const rawPrice = item.price !== undefined ? item.price : item.unitPrice;
            if (rawPrice !== null && rawPrice !== undefined && rawPrice !== "") {
                parsedUnitPrice = Number(rawPrice.toString().replace(/[^\d.]/g, ""));
            }

            if (parsedUnitPrice === null || isNaN(parsedUnitPrice) || parsedUnitPrice === 0) {
                appliedPrice = 0;
            } else {
                if (parsedUnitPrice >= absoluteFloorPrice) {
                    appliedPrice = parsedUnitPrice;
                } else {
                    console.log(`[剔除原因] ${item.model} 價格破底: 客出 ${parsedUnitPrice} < 底線 ${absoluteFloorPrice} (成本: ${product.cost}, 最終: ${systemFinalPrice})`);
                    abnormalPriceModels.push(item.model);
                    continue;
                }
            }

            const subtotal = appliedPrice * item.qty;
            if (appliedPrice > 0) {
                totalAmount += subtotal;
            } else {
                totalAmount = 0;
            }

            validOrderItems.push({
                model: (product && product.model) ? product.model : '未提供',
                name: (product && product.name) ? product.name : '未知名稱(請確認型號)',
                qty: (item && item.qty) ? item.qty : (Math.max(1, item.qty) || 1),
                unitPrice: (appliedPrice !== undefined && appliedPrice !== null) ? appliedPrice : 0,
                subtotal: (subtotal !== undefined && subtotal !== null) ? subtotal : 0
            });
        } else {
            console.log(`[剔除原因] 找不到型號: ${item.model}`);
            invalidModels.push(item.model);
        }
    }

    if (totalAmount === 0 && validOrderItems.some(i => i.unitPrice === 0)) {
        totalAmount = 0;
    }

    if (validOrderItems.length === 0) {
        const failReasons = [];
        if (invalidModels.length > 0) failReasons.push(`查無型號: ${invalidModels.join(', ')}`);
        if (abnormalPriceModels.length > 0) failReasons.push(`價格異常: ${abnormalPriceModels.join(', ')}`);
        if (outOfStockModels.length > 0) failReasons.push(`庫存不足轉預購: ${outOfStockModels.join(', ')}`);

        const reasonText = failReasons.length > 0 ? failReasons.join('\n') : '您輸入的型號皆查無資料或價格異常。';

        await lineClient.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: `❌ 訂單無法成立\n\n原因：\n${reasonText}` }]
        });
        return;
    }

    const orderId = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`;
    let shippingFee = 0;

    if (totalAmount === 0 && validOrderItems.some(i => i.unitPrice === 0)) {
        totalAmount = 0;
        shippingFee = 0;
    } else {
        shippingFee = (totalAmount >= 3000 || realLevel >= 4) ? 0 : 150;
        totalAmount += shippingFee;
    }

    // 自動比對客戶公司 → 回填 customerCode（若使用者沒在模板裡自己填）
    intentParams.customer = intentParams.customer || {};
    let customerMatchLine = null;
    let customerMatchHit = false;
    if (!intentParams.customer.customerCode) {
        try {
            const matchResult = await matchCustomerByCompany(intentParams.customer.company || intentParams.customer.name);
            if (matchResult.matched) {
                intentParams.customer.customerCode = matchResult.code;
                if (!intentParams.customer.fullName) intentParams.customer.fullName = matchResult.fullName;
                if (!intentParams.customer.shortName) intentParams.customer.shortName = matchResult.shortName;
                customerMatchHit = true;
                customerMatchLine = `🏷️ 客戶編號: ${matchResult.code}（自動比對：${matchResult.shortName || matchResult.fullName}）`;
            } else if (matchResult.ambiguous) {
                const preview = (matchResult.candidates || []).map(c => `${c.code} ${c.shortName}`).join('、');
                customerMatchLine = `🏷️ 客戶編號: (多筆符合，請人工確認：${preview})`;
            } else {
                customerMatchLine = `🏷️ 客戶編號: (未建檔，儀表板會以公司名稱顯示)`;
            }
        } catch (e) {
            console.error('[processOrder customerMatch]', e);
        }
    } else {
        customerMatchHit = true;
        customerMatchLine = `🏷️ 客戶編號: ${intentParams.customer.customerCode}`;
    }

    const orderData = {
        orderId: orderId,
        userId: lineUid,
        userEmail: userEmail,
        orderLevel: currentViewLevel,
        customer: intentParams.customer,
        items: validOrderItems,
        totalAmount: totalAmount,
        shippingFee: shippingFee,
        status: 'waiting',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const { createdAt, ...restData } = orderData;
    const safeOrderData = JSON.parse(JSON.stringify(restData));
    safeOrderData.createdAt = createdAt;

    await db.collection('PendingOrders').doc(orderId).set(safeOrderData);

    const itemBoxes = validOrderItems.map(item => ({
        type: 'box',
        layout: 'horizontal',
        contents: [
            { type: 'text', text: `${item.model} x${item.qty}`, size: 'sm', color: '#111111', flex: 2, wrap: true },
            { type: 'text', text: item.subtotal > 0 ? `$${item.subtotal}` : `待確認`, size: 'sm', color: item.subtotal > 0 ? '#111111' : '#E11D48', align: 'end', flex: 1 }
        ]
    }));

    const totalAmountDisplay = totalAmount > 0 ? `$${totalAmount}` : '待確認';

    const flexMessageObject = {
        type: 'flex',
        altText: '請確認您的訂單明細與總金額',
        contents: {
            type: 'bubble',
            header: {
                type: 'box', layout: 'vertical',
                contents: [{ type: 'text', text: '📝 訂單已建立，請確認', weight: 'bold', size: 'lg', color: '#FFFFFF' }],
                backgroundColor: '#E11D48'
            },
            body: {
                type: 'box', layout: 'vertical',
                contents: [
                    { type: 'text', text: `🏢 公司: ${intentParams.customer?.company || '未提供'}`, size: 'sm', color: '#555555', weight: 'bold' },
                    ...(customerMatchLine ? [{ type: 'text', text: customerMatchLine, size: 'sm', color: customerMatchHit ? '#1DB446' : '#888888', wrap: true }] : []),
                    { type: 'text', text: `👤 收件: ${intentParams.customer?.name || '未提供'} (${intentParams.customer?.phone || '未提供'})`, size: 'sm', color: '#555555' },
                    { type: 'text', text: `📍 地址: ${intentParams.customer?.address || '未提供'}`, size: 'sm', color: '#555555', wrap: true },
                    { type: 'text', text: `⏰ 到貨: ${intentParams.customer?.deliveryTime || '未指定'}`, size: 'sm', color: '#1DB446', wrap: true, margin: 'sm' },
                    { type: 'text', text: `📝 備註: ${intentParams.customer?.remark || '無'}`, size: 'sm', color: '#E11D48', wrap: true, margin: 'sm' },
                    { type: 'separator', margin: 'lg' },
                    { type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm', contents: itemBoxes },
                    { type: 'separator', margin: 'lg' },
                    {
                        type: 'box', layout: 'horizontal', margin: 'lg',
                        contents: [
                            { type: 'text', text: '運費', size: 'sm', color: '#555555' },
                            { type: 'text', text: totalAmount > 0 ? (shippingFee === 0 ? '免運' : `$${shippingFee}`) : '待確認', size: 'sm', color: totalAmount > 0 ? '#111111' : '#E11D48', align: 'end' }
                        ]
                    },
                    {
                        type: 'box', layout: 'horizontal', margin: 'md',
                        contents: [
                            { type: 'text', text: '總計', weight: 'bold', size: 'md', color: '#E11D48' },
                            { type: 'text', text: totalAmountDisplay, weight: 'bold', size: 'md', color: '#E11D48', align: 'end' }
                        ]
                    }
                ]
            },
            footer: {
                type: 'box', layout: 'horizontal', spacing: 'sm',
                contents: [
                    {
                        type: 'button', style: 'primary', color: '#0055aa',
                        action: { type: 'postback', label: '✅ 確認無誤', data: `action=confirm_order&orderId=${orderId}` }
                    },
                    {
                        type: 'button', style: 'secondary',
                        action: { type: 'postback', label: '❌ 取消訂單', data: `action=cancel_order&orderId=${orderId}` }
                    }
                ]
            }
        }
    };

    const warningTexts = [];
    if (invalidModels.length > 0) warningTexts.push(`查無型號: ${invalidModels.join(', ')}`);
    if (abnormalPriceModels.length > 0) warningTexts.push(`價格異常: ${abnormalPriceModels.join(', ')}`);
    if (outOfStockModels.length > 0) warningTexts.push(`庫存不足轉預購: ${outOfStockModels.join(', ')}`);

    if (warningTexts.length > 0) {
        flexMessageObject.contents.body.contents.unshift({
            type: 'text',
            text: `⚠️ 系統提示 - ${warningTexts.join(' | ')}`,
            color: '#E11D48',
            size: 'xs',
            wrap: true,
            margin: 'sm'
        });
    }

    await lineClient.replyMessage({
        replyToken: event.replyToken,
        messages: [flexMessageObject]
    });

    console.log(`✅ [訂單處理] 已回傳確認卡片給使用者`);
}

module.exports = { processOrder };
