const { admin, db } = require('../utils/firebase');

const ADMIN_LINE_UID = process.env.ADMIN_LINE_UID;
const REPLY_STATE_TTL_MS = 30 * 60 * 1000;
const MAX_OPTIONS = 4;

function truncate(str, max) {
    if (!str) return '';
    const s = String(str);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

async function getOrderSummary(orderId, orderCollection) {
    try {
        const col = orderCollection || 'PendingOrders';
        const doc = await db.collection(col).doc(orderId).get();
        if (!doc.exists) return null;
        const data = doc.data();
        const customer = data.customer || {};
        const rawItems = Array.isArray(data.items) ? data.items : (Array.isArray(data.orderItems) ? data.orderItems : []);
        const items = rawItems.map(item => ({
            model: item.model || item.name || item.product || '',
            qty: Number(item.qty || item.quantity || item.count || 0),
            unitPrice: Number(item.unitPrice || item.price || 0),
            subtotal: Number(item.subtotal || 0),
            reason: item.reason || ''
        }));
        return {
            type: orderId.startsWith('SMP') ? '借樣品' : orderId.startsWith('RMA') ? '派車單' : orderId.startsWith('BCH') ? '行動屋' : orderId.startsWith('RSV') ? '預留' : '訂單',
            customerCode: customer.customerCode || '',
            company: customer.company || '',
            name: customer.name || '',
            phone: customer.phone || '',
            address: customer.address || '',
            logistics: customer.logistics || '',
            deliveryTime: customer.deliveryTime || '',
            projectName: customer.projectName || '',
            returnDate: customer.returnDate || '',
            reserveDeadline: data.reserveDeadline || customer.reserveDeadline || '',
            remark: customer.remark || '',
            items,
            totalAmount: Number(data.totalAmount || 0),
            shippingFee: Number(data.shippingFee || 0),
            status: data.status || ''
        };
    } catch (err) {
        console.error('[getOrderSummary]', err);
        return null;
    }
}

function buildOrderDetailContents(summary) {
    if (!summary) return [];

    const contents = [];
    contents.push({ type: 'separator', margin: 'lg', color: '#E5E7EB' });
    contents.push({ type: 'text', text: `📦 ${summary.type}內容`, size: 'sm', color: '#555555', weight: 'bold', margin: 'md' });

    // 客戶
    const custParts = [];
    if (summary.company) custParts.push(summary.company);
    if (summary.name && summary.name !== summary.company) custParts.push(summary.name);
    const custLine = custParts.join(' / ') || '（未提供）';
    contents.push({
        type: 'box', layout: 'baseline', spacing: 'sm', margin: 'sm',
        contents: [
            { type: 'text', text: '客戶', flex: 2, size: 'xs', color: '#999999' },
            { type: 'text', text: custLine + (summary.customerCode ? `  (${summary.customerCode})` : ''), flex: 7, size: 'xs', color: '#333333', wrap: true }
        ]
    });

    if (summary.phone) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '電話', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.phone, flex: 7, size: 'xs', color: '#333333' }
            ]
        });
    }
    if (summary.address) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '地址', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.address, flex: 7, size: 'xs', color: '#333333', wrap: true }
            ]
        });
    }
    if (summary.logistics) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '物流', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.logistics, flex: 7, size: 'xs', color: '#333333' }
            ]
        });
    }
    if (summary.deliveryTime) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '預期到貨', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.deliveryTime, flex: 7, size: 'xs', color: '#E11D48', wrap: true }
            ]
        });
    }
    if (summary.projectName) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '案名', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.projectName, flex: 7, size: 'xs', color: '#333333', wrap: true }
            ]
        });
    }
    if (summary.returnDate) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '預計歸還', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.returnDate, flex: 7, size: 'xs', color: '#E11D48' }
            ]
        });
    }
    if (summary.reserveDeadline) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '預留期限', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: String(summary.reserveDeadline), flex: 7, size: 'xs', color: '#E11D48' }
            ]
        });
    }
    if (summary.remark) {
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '備註', flex: 2, size: 'xs', color: '#999999' },
                { type: 'text', text: summary.remark, flex: 7, size: 'xs', color: '#E11D48', wrap: true }
            ]
        });
    }

    // 品項
    if (summary.items && summary.items.length > 0) {
        contents.push({ type: 'separator', margin: 'md', color: '#F3F4F6' });
        contents.push({ type: 'text', text: `品項 (${summary.items.length} 項)`, size: 'xs', color: '#555555', weight: 'bold', margin: 'sm' });
        const MAX_ITEMS = 10;
        const shown = summary.items.slice(0, MAX_ITEMS);
        for (const it of shown) {
            const modelText = truncate(it.model || '(未命名)', 30);
            const qtyText = `× ${it.qty}`;
            const priceText = it.unitPrice > 0 ? `  @$${it.unitPrice}` : '';
            const reasonText = it.reason ? `  ${truncate(it.reason, 18)}` : '';
            contents.push({
                type: 'box', layout: 'baseline', spacing: 'sm',
                contents: [
                    { type: 'text', text: modelText, flex: 6, size: 'xs', color: '#333333', wrap: true },
                    { type: 'text', text: qtyText + priceText, flex: 4, size: 'xs', color: '#666666', align: 'end' }
                ]
            });
            if (it.reason) {
                contents.push({ type: 'text', text: '原因：' + it.reason, size: 'xxs', color: '#E11D48', margin: 'none', wrap: true });
            }
        }
        if (summary.items.length > MAX_ITEMS) {
            contents.push({ type: 'text', text: `…還有 ${summary.items.length - MAX_ITEMS} 項，請點 Dashboard 查看完整`, size: 'xxs', color: '#888888', margin: 'xs' });
        }
    }

    // 總計
    if (summary.totalAmount > 0) {
        contents.push({ type: 'separator', margin: 'md', color: '#F3F4F6' });
        contents.push({
            type: 'box', layout: 'baseline', spacing: 'sm',
            contents: [
                { type: 'text', text: '總計', flex: 2, size: 'sm', color: '#999999', weight: 'bold' },
                { type: 'text', text: `$${summary.totalAmount}`, flex: 7, size: 'md', color: '#E11D48', weight: 'bold', align: 'end' }
            ]
        });
    }

    return contents;
}

function buildQuestionFlex({ questionId, orderId, askerName, questionType, description, options, dashboardToken, orderSummary }) {
    const optionButtons = options.map((opt, idx) => ({
        type: 'button',
        style: 'primary',
        color: '#0055aa',
        height: 'sm',
        margin: 'sm',
        action: {
            type: 'postback',
            label: truncate(`${idx + 1}. ${opt}`, 40),
            data: `action=admin_answer&qid=${encodeURIComponent(questionId)}&idx=${idx}`,
            displayText: `選擇 ${idx + 1}：${truncate(opt, 30)}`
        }
    }));

    const textInputButton = {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        margin: 'sm',
        action: {
            type: 'postback',
            label: '✏️ 自己輸入',
            data: `action=admin_answer&qid=${encodeURIComponent(questionId)}&mode=text`,
            displayText: '我要自己輸入答案'
        }
    };

    const dashboardUrl = `https://asia-east1-kinyo-price.cloudfunctions.net/orderDashboard?token=${encodeURIComponent(dashboardToken)}`;
    const dashboardButton = {
        type: 'button',
        style: 'link',
        height: 'sm',
        margin: 'sm',
        action: { type: 'uri', label: '🔗 打開 Dashboard', uri: dashboardUrl }
    };

    return {
        type: 'flex',
        altText: `${askerName} 問您一個問題（訂單 ${orderId}）`,
        contents: {
            type: 'bubble',
            size: 'mega',
            header: {
                type: 'box',
                layout: 'vertical',
                backgroundColor: '#FFF3CD',
                paddingAll: '14px',
                contents: [
                    { type: 'text', text: `📋 ${askerName} 問您`, weight: 'bold', size: 'lg', color: '#856404' },
                    { type: 'text', text: `訂單 #${orderId}`, size: 'sm', color: '#856404', margin: 'xs' }
                ]
            },
            body: {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                    { type: 'text', text: `【${questionType}】`, weight: 'bold', color: '#E11D48', size: 'md' },
                    { type: 'text', text: description, wrap: true, size: 'sm', color: '#333333' },
                    ...buildOrderDetailContents(orderSummary)
                ]
            },
            footer: {
                type: 'box',
                layout: 'vertical',
                spacing: 'xs',
                paddingAll: '12px',
                contents: [...optionButtons, textInputButton, dashboardButton]
            }
        }
    };
}

async function createQuestion({ orderId, orderCollection, questionType, description, options, askerName, lineClient, dashboardToken }) {
    const docRef = db.collection('AdminQuestions').doc();
    const questionId = docRef.id;
    const cleanAsker = askerName || 'DinDin';

    await docRef.set({
        questionId,
        orderId,
        orderCollection: orderCollection || 'PendingOrders',
        questionType,
        description,
        options,
        askerName: cleanAsker,
        askedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'pending',
        answer: null,
        answerType: null,
        answeredAt: null,
        completedAt: null,
    });

    const orderSummary = await getOrderSummary(orderId, orderCollection);

    const flexMessage = buildQuestionFlex({
        questionId, orderId, askerName: cleanAsker,
        questionType, description, options, dashboardToken, orderSummary
    });

    try {
        await lineClient.pushMessage({
            to: ADMIN_LINE_UID,
            messages: [flexMessage]
        });
    } catch (pushErr) {
        console.error('[AdminQuestion] 推送 Flex 失敗:', pushErr);
        await docRef.delete().catch(() => {});
        throw new Error(`LINE 推送失敗: ${pushErr.message}`);
    }

    return questionId;
}

async function handleOptionAnswer({ questionId, optionIdx, lineClient, replyToken }) {
    const docRef = db.collection('AdminQuestions').doc(questionId);
    const doc = await docRef.get();
    if (!doc.exists) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '⚠️ 找不到這則問題，可能已失效。' }] });
        return;
    }
    const data = doc.data();
    if (data.status !== 'pending') {
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `⚠️ 這則問題已於 ${data.answeredAt ? data.answeredAt.toDate().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '稍早'} 回覆過了。\n答案：${data.answer || '（無）'}` }]
        });
        return;
    }
    const option = data.options?.[optionIdx];
    if (option == null) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '⚠️ 選項無效。' }] });
        return;
    }

    await docRef.update({
        status: 'answered',
        answer: option,
        answerType: 'option',
        answeredAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await clearReplyState();

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✓ 已回覆給 ${data.askerName}\n訂單 #${data.orderId}\n選擇：${option}`
        }]
    });
}

async function handleTextModeRequest({ questionId, lineClient, replyToken }) {
    const docRef = db.collection('AdminQuestions').doc(questionId);
    const doc = await docRef.get();
    if (!doc.exists) {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '⚠️ 找不到這則問題。' }] });
        return;
    }
    const data = doc.data();
    if (data.status !== 'pending') {
        await lineClient.replyMessage({ replyToken, messages: [{ type: 'text', text: '⚠️ 這則問題已回覆過了。' }] });
        return;
    }

    const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + REPLY_STATE_TTL_MS);
    await db.collection('AdminReplyState').doc(ADMIN_LINE_UID).set({
        questionId,
        orderId: data.orderId,
        askerName: data.askerName,
        expiresAt
    });

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✏️ 請直接打字回覆\n您輸入的下一句話會當作 #${data.orderId} 的答案（30 分鐘內有效）。\n\n若想改按選項，請重新檢視上方訊息。`
        }]
    });
}

async function tryHandleAdminTextReply({ lineUid, text, lineClient, replyToken }) {
    if (lineUid !== ADMIN_LINE_UID) return false;
    const stateRef = db.collection('AdminReplyState').doc(ADMIN_LINE_UID);
    const stateDoc = await stateRef.get();
    if (!stateDoc.exists) return false;

    const state = stateDoc.data();
    const expiresAt = state.expiresAt?.toMillis?.() || 0;
    if (expiresAt < Date.now()) {
        await stateRef.delete().catch(() => {});
        return false;
    }

    const questionId = state.questionId;
    const qRef = db.collection('AdminQuestions').doc(questionId);
    const qDoc = await qRef.get();
    if (!qDoc.exists || qDoc.data().status !== 'pending') {
        await stateRef.delete().catch(() => {});
        return false;
    }

    const qData = qDoc.data();

    await qRef.update({
        status: 'answered',
        answer: text,
        answerType: 'text',
        answeredAt: admin.firestore.FieldValue.serverTimestamp()
    });
    await stateRef.delete().catch(() => {});

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✓ 已回覆給 ${qData.askerName}\n訂單 #${qData.orderId}\n內容：${text}`
        }]
    });
    return true;
}

async function clearReplyState() {
    try {
        await db.collection('AdminReplyState').doc(ADMIN_LINE_UID).delete();
    } catch (e) { /* ignore */ }
}

async function getLatestQuestionsForOrders(orderIds) {
    if (!orderIds || orderIds.length === 0) return {};
    const chunks = [];
    for (let i = 0; i < orderIds.length; i += 10) {
        chunks.push(orderIds.slice(i, i + 10));
    }
    const result = {};
    for (const chunk of chunks) {
        const snap = await db.collection('AdminQuestions')
            .where('orderId', 'in', chunk)
            .where('status', 'in', ['pending', 'answered'])
            .get();
        snap.docs.forEach(doc => {
            const d = doc.data();
            const ts = d.askedAt?.toMillis?.() || 0;
            const existing = result[d.orderId];
            if (!existing || ts > (existing._ts || 0)) {
                result[d.orderId] = {
                    questionId: doc.id,
                    status: d.status,
                    questionType: d.questionType,
                    description: d.description,
                    options: d.options,
                    askerName: d.askerName,
                    answer: d.answer,
                    answerType: d.answerType,
                    askedAt: d.askedAt?.toDate?.()?.toISOString() || null,
                    answeredAt: d.answeredAt?.toDate?.()?.toISOString() || null,
                    _ts: ts
                };
            }
        });
    }
    for (const k of Object.keys(result)) delete result[k]._ts;
    return result;
}

async function markQuestionDone(questionId) {
    const docRef = db.collection('AdminQuestions').doc(questionId);
    await docRef.update({
        status: 'done',
        completedAt: admin.firestore.FieldValue.serverTimestamp()
    });
}

module.exports = {
    createQuestion,
    handleOptionAnswer,
    handleTextModeRequest,
    tryHandleAdminTextReply,
    getLatestQuestionsForOrders,
    markQuestionDone,
    MAX_OPTIONS
};
