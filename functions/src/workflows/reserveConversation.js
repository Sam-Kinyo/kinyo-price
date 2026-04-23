/**
 * reserveConversation.js
 * 預留訂單 對話式 flow
 *
 * 狀態機：
 *   (start) → waiting_customer → waiting_deadline → waiting_items → waiting_remark → (完成，送 Flex 確認卡)
 *   任何階段輸入「取消」都會中止並清 state
 */

const { db } = require('../utils/firebase');
const { getState, setState, clearState, TTL_MINUTES } = require('../services/conversationState');

// 客戶編號 pattern：英文字母 + 數字 + 可選 "-數字"
const CODE_PATTERN = /^[A-Za-z]{2,4}\d{3,6}(-\d+)?$/;

// 日期格式嘗試：YYYY/M/D, YYYY-M-D, YYYY年M月D日
function tryParseDate(input) {
    const normalized = String(input)
        .replace(/年|月/g, '-')
        .replace(/日/g, '')
        .replace(/\//g, '-')
        .trim();
    const m = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!m) return null;
    const [, y, mo, d] = m;
    const date = new Date(`${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}T00:00:00+08:00`);
    if (isNaN(date.getTime())) return null;
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// 商品行格式：支援多種寫法（KHS3104pu x300 @342 / KPB2512BR 10個 320元 / KHS3104 10 320 ...）
function tryParseItem(input) {
    const cleaned = String(input).trim()
        .replace(/[＊✕×*]/g, 'x')
        .replace(/[＠]/g, '@')
        .replace(/元整?|NT\$?|\$/gi, '')
        .replace(/[個件台箱組盒支瓶罐袋包片條顆]/g, ' ')
        .replace(/(?<![A-Za-z])pcs?(?![A-Za-z])/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*x\s*(\d+)\s*(?:@\s*(\d+))?/i);
    if (m) {
        return { model: m[1].toUpperCase(), qty: parseInt(m[2], 10), unitPrice: m[3] ? parseInt(m[3], 10) : null };
    }
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s+(\d+)(?:\s+@?\s*(\d+))?/i);
    if (m) {
        return { model: m[1].toUpperCase(), qty: parseInt(m[2], 10), unitPrice: m[3] ? parseInt(m[3], 10) : null };
    }
    return null;
}

// ==========================================
// QuickReply 按鈕組
// ==========================================
const cancelBtn = {
    type: 'action',
    action: { type: 'message', label: '❌ 取消', text: '取消' }
};

const submitBtn = {
    type: 'action',
    action: { type: 'message', label: '✅ 送出', text: '送出' }
};

const skipBtn = {
    type: 'action',
    action: { type: 'message', label: '⏭️ 跳過', text: '跳過' }
};

const modifyItemsBtn = {
    type: 'action',
    action: { type: 'message', label: '🔧 修改', text: '修改商品' }
};

function quickReply(items) {
    return { items };
}

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
// 進入點 - 使用者打「預留訂單」
// ==========================================
async function startReserveFlow(lineUid, groupId, replyToken, lineClient) {
    await setState(lineUid, {
        flow: 'reserve_order',
        step: 'waiting_customer',
        data: { items: [] },
        groupId: groupId || null,
        startedAt: new Date().toISOString(),
    });

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📌 進入「預留訂單」對話模式\n\n請輸入客戶編號或簡稱\n(例：耐嘉 或 耐嘉股份有限公司)\n\n💡 ${TTL_MINUTES} 分鐘未回應自動過期`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// 主分派：依 step 處理
// ==========================================
async function handleConversationInput(state, userText, event, lineClient) {
    const lineUid = event.source.userId;
    const replyToken = event.replyToken;
    const input = userText.replace(/@KINYO挺好的\s*/g, '').trim();

    // 全階段共用：取消
    if (input === '取消' || input === '@KINYO挺好的 取消') {
        await clearState(lineUid);
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 已取消預留訂單對話。' }]
        });
        return;
    }

    if (state.step === 'waiting_customer') {
        await handleCustomerStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_deadline') {
        await handleDeadlineStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_items') {
        await handleItemsStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_remark') {
        await handleRemarkStep(state, input, lineUid, replyToken, lineClient);
    } else {
        // 不明 step，清掉
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
    // 1. 編號精確比對
    if (CODE_PATTERN.test(input)) {
        const code = input.toUpperCase();
        const doc = await db.collection('Customers').doc(code).get();
        if (doc.exists) {
            return advanceToDeadline(state, doc.data(), lineUid, replyToken, lineClient);
        }
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `⚠️ 查無客戶編號「${code}」\n請重新輸入，或打「取消」中止。` }]
        });
    }

    // 2. 文字模糊比對（簡稱/全名 includes）
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
        return advanceToDeadline(state, matches[0], lineUid, replyToken, lineClient);
    }

    // 多筆：超過 5 筆叫使用者更精確
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

    // 2~5 筆：quickReply 按鈕
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

async function advanceToDeadline(state, customerData, lineUid, replyToken, lineClient) {
    const customer = {
        code: customerData.code || customerData.id || '',
        shortName: customerData.shortName || '',
        fullName: customerData.fullName || '',
        phone: customerData.phone || '',
        address: customerData.address || '',
        taxId: customerData.taxId || '',
    };
    state.data.customer = customer;
    state.step = 'waiting_deadline';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✅ 已識別\n━━━━━━━━━\n【${customer.code}】${customer.shortName}\n${customer.fullName}\n📞 ${customer.phone || '未提供'}\n📍 ${customer.address || '未提供'}\n━━━━━━━━━\n\n請輸入預留期限\n(例：2026/05/31 或 2026-05-31)`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// Step 2: 預留期限
// ==========================================
async function handleDeadlineStep(state, input, lineUid, replyToken, lineClient) {
    const parsed = tryParseDate(input);
    if (!parsed) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: '⚠️ 無法解析日期，請用 YYYY/MM/DD 格式\n例：2026/05/31',
                quickReply: quickReply([cancelBtn])
            }]
        });
    }

    state.data.reserveDeadline = parsed;
    state.step = 'waiting_items';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📅 預留期限：${parsed}\n\n請輸入商品明細（一行一個）\n格式：型號 x 數量 @ 單價 (單價可省略)\n例：KHS3104pu x300 @342`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// Step 3: 商品明細（多行累積）
// ==========================================
async function handleItemsStep(state, input, lineUid, replyToken, lineClient) {
    // 修改：清空已輸入的商品明細
    if (input === '修改商品' || input === '修改明細' || input === '重填商品') {
        state.data.items = [];
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🔧 已清空商品明細\n\n請重新輸入商品明細（一行一個）\n格式：型號 x 數量 @ 單價 (單價可省略)\n例：KHS3104pu x300 @342`,
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
        // 進入備註 step
        state.step = 'waiting_remark';
        await setState(lineUid, state);
        const itemsPreview = state.data.items.map(it =>
            `• ${it.model} x${it.qty}${it.unitPrice ? ` @${it.unitPrice}` : ''}`
        ).join('\n');
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🛒 目前共 ${state.data.items.length} 筆：\n${itemsPreview}\n\n是否要加備註？\n• 有 → 請直接輸入備註內容\n• 無 → 點「跳過」`,
                quickReply: quickReply([skipBtn, cancelBtn])
            }]
        });
    }

    // 支援同一則訊息多行
    const lines = input.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const added = [];
    const failed = [];
    for (const line of lines) {
        const item = tryParseItem(line);
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
                text: `⚠️ 無法解析「${input}」\n請用：型號 x 數量 @ 單價\n例：KHS3104pu x300 @342`,
                quickReply: itemsStepQuickReply(state.data.items.length > 0)
            }]
        });
    }

    await setState(lineUid, state);

    const addedMsg = added.map(it => `• ${it.model} x${it.qty}${it.unitPrice ? ` @${it.unitPrice}` : ''}`).join('\n');
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
// Step 4: 備註（選填）→ 完成 → Flex 確認卡
// ==========================================
async function handleRemarkStep(state, input, lineUid, replyToken, lineClient) {
    if (input === '跳過' || input === '無' || input === '否') {
        state.data.remark = '';
    } else {
        state.data.remark = input;
    }

    // 寫入 tempOrders 並顯示 Flex 確認卡
    const tempData = {
        action: 'reserve_order',
        customer: {
            company: state.data.customer.fullName || state.data.customer.shortName,
            name: state.data.customer.shortName, // 收件人先帶簡稱（ERP 無個別聯絡人欄位）
            phone: state.data.customer.phone,
            address: state.data.customer.address,
            remark: state.data.remark || '',
            reserveDeadline: state.data.reserveDeadline,
            customerCode: state.data.customer.code,
            customerShortName: state.data.customer.shortName,
        },
        orderItems: state.data.items.map(it => ({
            model: it.model,
            qty: it.qty,
            unitPrice: it.unitPrice,
        })),
    };

    const tempOrderRef = await db.collection('tempOrders').add(tempData);
    await clearState(lineUid);

    // 組 items 顯示字串 + 總金額
    let itemsText = '';
    let totalAmount = 0;
    tempData.orderItems.forEach(item => {
        const price = Number(item.unitPrice) || 0;
        const qty = Number(item.qty) || 1;
        itemsText += `${item.model} x${qty}${price > 0 ? ` @${price}` : ''}\n`;
        totalAmount += price * qty;
    });
    if (!itemsText) itemsText = '未提供商品明細';

    const customer = state.data.customer;
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
                    { type: 'text', text: `🏷️ 客戶: 【${customer.code}】${customer.shortName}`, size: 'sm', weight: 'bold' },
                    { type: 'text', text: `🏢 ${customer.fullName}`, size: 'xs', color: '#666666', wrap: true },
                    { type: 'text', text: `📞 ${customer.phone || '未提供'}`, size: 'sm' },
                    { type: 'text', text: `📍 ${customer.address || '未提供'}`, size: 'sm', wrap: true },
                    { type: 'text', text: `📅 預留期限: ${state.data.reserveDeadline}`, size: 'sm', color: '#E11D48', weight: 'bold' },
                    { type: 'text', text: `📝 備註: ${state.data.remark || '無'}`, size: 'sm', wrap: true },
                    { type: 'separator', margin: 'md' },
                    { type: 'text', text: itemsText, size: 'sm', wrap: true, margin: 'md' },
                    { type: 'text', text: totalAmount > 0 ? `💰 總計: $${totalAmount}` : '💰 總計: 待確認', size: 'sm', weight: 'bold', color: '#E11D48' }
                ]
            },
            footer: {
                type: 'box', layout: 'vertical', spacing: 'sm',
                contents: [
                    {
                        type: 'button', style: 'primary', color: '#1DB446',
                        action: { type: 'postback', label: '✅ 確認預留', data: `action=confirm_reserve&id=${tempOrderRef.id}` }
                    },
                    {
                        type: 'box', layout: 'horizontal', spacing: 'sm',
                        contents: [
                            {
                                type: 'button', style: 'secondary',
                                action: { type: 'postback', label: '🔧 修改', data: `action=modify_reserve&id=${tempOrderRef.id}` }
                            },
                            {
                                type: 'button', style: 'secondary',
                                action: { type: 'postback', label: '❌ 取消', data: `action=cancel_temp_order&id=${tempOrderRef.id}` }
                            }
                        ]
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

module.exports = { startReserveFlow, handleConversationInput };
