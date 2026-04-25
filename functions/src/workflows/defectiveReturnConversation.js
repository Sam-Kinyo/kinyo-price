/**
 * defectiveReturnConversation.js
 * 來回件 / 新品不良 對話式 flow
 *
 * 狀態機：
 *   (start) → waiting_customer → waiting_items → waiting_remark → (完成，送 Flex 確認卡)
 *   任何階段輸入「取消」都會中止並清 state
 */

const { db } = require('../utils/firebase');
const { setState, clearState, TTL_MINUTES } = require('../services/conversationState');

const CODE_PATTERN = /^[A-Za-z]{2,4}\d{3,6}(-\d+)?$/;

// 商品行格式：`型號 x 數量 / 故障原因`，故障原因可省略
function tryParseDefectiveItem(input) {
    const raw = String(input).trim();
    if (!raw) return null;

    // 切出故障原因（用 / ／ 分隔）
    let itemPart = raw;
    let reason = '';
    const slashIdx = raw.search(/[\/／]/);
    if (slashIdx > 0) {
        itemPart = raw.slice(0, slashIdx).trim();
        reason = raw.slice(slashIdx + 1).trim();
    }

    const cleaned = itemPart
        .replace(/[＊✕×*]/g, 'x')
        .replace(/[個件台箱組盒支瓶罐袋包片條顆]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*x\s*(\d+)/i);
    if (m) {
        return { model: m[1].toUpperCase(), quantity: parseInt(m[2], 10), reason: reason || '未說明' };
    }
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s+(\d+)/i);
    if (m) {
        return { model: m[1].toUpperCase(), quantity: parseInt(m[2], 10), reason: reason || '未說明' };
    }
    return null;
}

// ==========================================
// QuickReply 按鈕組
// ==========================================
const cancelBtn = { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } };
const submitBtn = { type: 'action', action: { type: 'message', label: '✅ 送出', text: '送出' } };
const skipBtn   = { type: 'action', action: { type: 'message', label: '⏭️ 跳過', text: '跳過' } };
const modifyItemsBtn = { type: 'action', action: { type: 'message', label: '🔧 修改', text: '修改商品' } };

function quickReply(items) { return { items }; }

function itemsStepQuickReply(hasItems) {
    const btns = [];
    if (hasItems) {
        btns.push(submitBtn);
        btns.push(modifyItemsBtn);
    }
    btns.push(cancelBtn);
    return quickReply(btns);
}

// ==========================================
// 進入點 - 使用者打「來回件」/「新品不良」
// ==========================================
async function startDefectiveReturnFlow(lineUid, groupId, replyToken, lineClient) {
    await setState(lineUid, {
        flow: 'defective_return',
        step: 'waiting_customer',
        data: { items: [] },
        groupId: groupId || null,
        startedAt: new Date().toISOString(),
    });

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `⚠️ 進入「來回件 / 新品不良」對話模式\n\n請輸入客戶編號或簡稱\n(例：耐嘉 或 耐嘉股份有限公司)\n\n💡 ${TTL_MINUTES} 分鐘未回應自動過期`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// 主分派
// ==========================================
async function handleConversationInput(state, userText, event, lineClient) {
    const lineUid = event.source.userId;
    const replyToken = event.replyToken;
    const input = userText.replace(/@KINYO挺好的\s*/g, '').trim();

    if (input === '取消' || input === '@KINYO挺好的 取消') {
        await clearState(lineUid);
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 已取消來回件對話。' }]
        });
        return;
    }

    if (state.step === 'waiting_customer') {
        await handleCustomerStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_items') {
        await handleItemsStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_remark') {
        await handleRemarkStep(state, input, lineUid, replyToken, lineClient);
    } else {
        await clearState(lineUid);
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '⚠️ 對話狀態異常，已清除。請重新開始。' }]
        });
    }
}

// ==========================================
// Step 1: 客戶
// ==========================================
async function handleCustomerStep(state, input, lineUid, replyToken, lineClient) {
    if (CODE_PATTERN.test(input)) {
        const code = input.toUpperCase();
        const doc = await db.collection('Customers').doc(code).get();
        if (doc.exists) {
            return advanceToItems(state, doc.data(), lineUid, replyToken, lineClient);
        }
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `⚠️ 查無客戶編號「${code}」\n請重新輸入，或打「取消」中止。` }]
        });
    }

    const snap = await db.collection('Customers').get();
    const matches = [];
    snap.forEach(d => {
        const data = d.data();
        if ((data.shortName || '').includes(input) || (data.fullName || '').includes(input)) {
            matches.push({ id: d.id, ...data });
        }
    });

    if (matches.length === 0) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `⚠️ 查無符合「${input}」的客戶\n請換一個關鍵字或輸入客戶編號。`,
                quickReply: quickReply([cancelBtn])
            }]
        });
    }

    if (matches.length === 1) {
        return advanceToItems(state, matches[0], lineUid, replyToken, lineClient);
    }

    if (matches.length > 5) {
        const preview = matches.slice(0, 5).map(m => `• ${m.code} ${m.shortName}`).join('\n');
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🔍 找到 ${matches.length} 筆符合，請輸入更精確的關鍵字或客戶編號：\n\n${preview}\n...(還有 ${matches.length - 5} 筆)`
            }]
        });
    }

    const items = matches.map(m => ({
        type: 'action',
        action: {
            type: 'message',
            label: `${m.code} ${m.shortName}`.substring(0, 20),
            text: m.code
        }
    }));
    items.push(cancelBtn);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `🔍 找到 ${matches.length} 筆符合，請點選：`,
            quickReply: quickReply(items)
        }]
    });
}

async function advanceToItems(state, customerData, lineUid, replyToken, lineClient) {
    const customer = {
        code: customerData.code || customerData.id || '',
        shortName: customerData.shortName || '',
        fullName: customerData.fullName || '',
        phone: customerData.phone || '',
        address: customerData.address || '',
        taxId: customerData.taxId || '',
    };
    state.data.customer = customer;
    state.step = 'waiting_items';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✅ 已識別\n━━━━━━━━━\n【${customer.code}】${customer.shortName}\n${customer.fullName}\n📞 ${customer.phone || '未提供'}\n📍 取件地址：${customer.address || '未提供'}\n━━━━━━━━━\n\n請輸入不良品明細（一行一個）\n格式：型號 x 數量 / 故障原因\n例：KHS3104 x2 / 按鈕失靈`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// Step 2: 商品明細
// ==========================================
async function handleItemsStep(state, input, lineUid, replyToken, lineClient) {
    if (input === '修改商品' || input === '修改明細' || input === '重填商品') {
        state.data.items = [];
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🔧 已清空不良品明細\n\n請重新輸入（一行一個）\n格式：型號 x 數量 / 故障原因\n例：KHS3104 x2 / 按鈕失靈`,
                quickReply: itemsStepQuickReply(false)
            }]
        });
    }

    if (input === '送出' || input === '完成') {
        if (!state.data.items || state.data.items.length === 0) {
            return lineClient.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: '⚠️ 尚未輸入任何商品，請至少輸入一筆。',
                    quickReply: quickReply([cancelBtn])
                }]
            });
        }
        state.step = 'waiting_remark';
        await setState(lineUid, state);
        const itemsPreview = state.data.items.map(it =>
            `• ${it.model} x${it.quantity}\n   ⚠️ 原因: ${it.reason}`
        ).join('\n');
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🛠️ 目前共 ${state.data.items.length} 筆：\n${itemsPreview}\n\n是否要加備註？\n• 有 → 請直接輸入備註內容\n• 無 → 點「跳過」`,
                quickReply: quickReply([skipBtn, cancelBtn])
            }]
        });
    }

    const lines = input.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const added = [];
    const failed = [];
    for (const line of lines) {
        const item = tryParseDefectiveItem(line);
        if (item) {
            state.data.items.push(item);
            added.push(item);
        } else {
            failed.push(line);
        }
    }

    if (added.length === 0) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `⚠️ 無法解析「${input}」\n請用：型號 x 數量 / 故障原因\n例：KHS3104 x2 / 按鈕失靈`,
                quickReply: itemsStepQuickReply(state.data.items.length > 0)
            }]
        });
    }

    await setState(lineUid, state);

    const addedMsg = added.map(it => `• ${it.model} x${it.quantity}\n   ⚠️ 原因: ${it.reason}`).join('\n');
    let msg = `✅ 已加入 ${added.length} 筆：\n${addedMsg}\n\n目前累積 ${state.data.items.length} 筆\n繼續輸入、或點「送出」完成`;
    if (failed.length > 0) {
        msg += `\n\n⚠️ 以下無法解析（已略過）：\n${failed.map(l => `• ${l}`).join('\n')}`;
    }
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: msg,
            quickReply: itemsStepQuickReply(true)
        }]
    });
}

// ==========================================
// Step 3: 備註 → 完成 → Flex 確認卡
// ==========================================
async function handleRemarkStep(state, input, lineUid, replyToken, lineClient) {
    const remark = (input === '跳過' || input === '無' || input === '否') ? '' : input;
    state.data.remark = remark;

    const customer = state.data.customer;

    // 寫入 tempOrders（與 specialActionWorkflow 的 defective_return 同 schema）
    const tempData = {
        action: 'defective_return',
        customer: {
            company: customer.fullName || customer.shortName,
            name: customer.shortName,
            phone: customer.phone,
            address: customer.address,
            remark: remark,
            customerCode: customer.code,
            customerShortName: customer.shortName,
        },
        items: state.data.items.map(it => ({
            model: it.model,
            quantity: it.quantity,
            reason: it.reason,
        })),
    };

    const tempOrderRef = await db.collection('tempOrders').add(tempData);
    await clearState(lineUid);

    let itemsText = '';
    tempData.items.forEach(item => {
        itemsText += `${item.model} x${item.quantity}\n⚠️ 原因: ${item.reason}\n`;
    });
    if (!itemsText) itemsText = '未提供明細';

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
                    { type: 'text', text: `🏷️ 客戶: 【${customer.code}】${customer.shortName}`, size: 'sm', weight: 'bold' },
                    { type: 'text', text: `🏢 ${customer.fullName}`, size: 'xs', color: '#666666', wrap: true },
                    { type: 'text', text: `📞 ${customer.phone || '未提供'}`, size: 'sm' },
                    { type: 'text', text: `📍 取件地址: ${customer.address || '未提供'}`, size: 'sm', color: '#E11D48', weight: 'bold', wrap: true },
                    { type: 'text', text: `📝 備註: ${remark || '無'}`, size: 'sm', wrap: true },
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
        replyToken,
        messages: [flexMessage]
    });
}

module.exports = { startDefectiveReturnFlow, handleConversationInput };
