/**
 * quoteSheetConversation.js
 * 管理員專用「報價單」對話式 flow
 *
 * 狀態機:
 *   (start) → waiting_customer → waiting_items → (送出 → 產 xlsx 回連結)
 *   任何階段輸入「取消」都會中止並清 state
 *
 * 權限: 只有 ADMIN_LINE_UID 可進入 (在 index.js 入口做 gate)
 */

const { db } = require('../utils/firebase');
const { getState, setState, clearState, TTL_MINUTES } = require('../services/conversationState');
const { generateQuoteSheet } = require('../services/quoteSheetGenerator');

const CODE_PATTERN = /^[A-Za-z]{2,4}\d{3,6}(-\d+)?$/;

// ==========================================
// 商品行解析: 型號 x 數量 @ 單價  (單價必填)
// 例:
//   KHS3104pu x300 @342
//   KPB-2990 x5 @100
//   KHS3104 10 320
// ==========================================
function tryParseItem(input) {
    const cleaned = String(input).trim()
        .replace(/[＊✕×*]/g, 'x')
        .replace(/[＠]/g, '@')
        .replace(/元整?|NT\$?|\$/gi, '')
        .replace(/[個台組盒支瓶罐袋包片條顆]/g, ' ')
        .replace(/(?<![A-Za-z])pcs?(?![A-Za-z])/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Pattern A: model x qty @ price
    let m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*x\s*(\d+)\s*(?:@\s*(\d+(?:\.\d+)?))?/i);
    if (m) {
        return { model: m[1].toUpperCase(), qty: parseInt(m[2], 10), unitPrice: m[3] ? Number(m[3]) : null };
    }
    // Pattern B: model qty [price]
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s+(\d+)\s*(?:@?\s*(\d+(?:\.\d+)?))?/i);
    if (m) {
        return { model: m[1].toUpperCase(), qty: parseInt(m[2], 10), unitPrice: m[3] ? Number(m[3]) : null };
    }
    return null;
}

// ==========================================
// QuickReply 按鈕
// ==========================================
const cancelBtn = { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } };
const submitBtn = { type: 'action', action: { type: 'message', label: '✅ 送出', text: '送出' } };
const skipCustBtn = { type: 'action', action: { type: 'message', label: '⏭️ 略過查詢', text: '略過' } };
const clearItemsBtn = { type: 'action', action: { type: 'message', label: '🧹 清空', text: '清空' } };
function quickReply(items) { return { items }; }

function itemsStepQuickReply(hasItems) {
    const btns = [];
    if (hasItems) {
        btns.push(submitBtn);
        btns.push(clearItemsBtn);
    }
    btns.push(cancelBtn);
    return quickReply(btns);
}

// ==========================================
// 進入點
// ==========================================
async function startQuoteSheetFlow(lineUid, groupId, replyToken, lineClient) {
    await setState(lineUid, {
        flow: 'quote_sheet',
        step: 'waiting_customer',
        data: { items: [] },
        groupId: groupId || null,
        startedAt: new Date().toISOString(),
    });

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📄 進入「報價單」對話模式\n\n請輸入客戶名稱或編號\n(例:耐嘉 / KY001 / 王大明科技)\n\n找不到客戶時輸入「略過」可自行填客戶名\n\n💡 ${TTL_MINUTES} 分鐘未回應自動過期`,
            quickReply: quickReply([skipCustBtn, cancelBtn]),
        }],
    });
}

// ==========================================
// 分派
// ==========================================
async function handleConversationInput(state, userText, event, lineClient) {
    const lineUid = event.source.userId;
    const replyToken = event.replyToken;
    const input = userText.replace(/@KINYO挺好的\s*/g, '').trim();

    if (input === '取消') {
        await clearState(lineUid);
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 已取消報價單對話。' }],
        });
        return;
    }

    if (state.step === 'waiting_customer') {
        await handleCustomerStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_custom_customer_name') {
        await handleCustomCustomerNameStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_items') {
        await handleItemsStep(state, input, event, lineClient);
    } else {
        await clearState(lineUid);
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '⚠️ 對話狀態異常,已清除。請重新開始。' }],
        });
    }
}

// ==========================================
// Step 1: 客戶
// ==========================================
async function handleCustomerStep(state, input, lineUid, replyToken, lineClient) {
    if (input === '略過' || input === '自行輸入' || input === '手動輸入') {
        state.step = 'waiting_custom_customer_name';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: '✍️ 請輸入客戶完整名稱(會顯示在報價單上)',
                quickReply: quickReply([cancelBtn]),
            }],
        });
    }

    // 先試客戶編號精準查
    if (CODE_PATTERN.test(input)) {
        const code = input.toUpperCase();
        const doc = await db.collection('Customers').doc(code).get();
        if (doc.exists) {
            return advanceToItems(state, { id: code, ...doc.data() }, lineUid, replyToken, lineClient);
        }
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `⚠️ 查無客戶編號「${code}」\n請重新輸入,或點「略過」自行填客戶名。`,
                quickReply: quickReply([skipCustBtn, cancelBtn]),
            }],
        });
    }

    // 關鍵字搜尋 shortName / fullName
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
                text: `⚠️ 查無符合「${input}」的客戶\n請換關鍵字,或點「略過」自行填客戶名。`,
                quickReply: quickReply([skipCustBtn, cancelBtn]),
            }],
        });
    }

    if (matches.length === 1) {
        return advanceToItems(state, matches[0], lineUid, replyToken, lineClient);
    }

    if (matches.length > 5) {
        const preview = matches.slice(0, 5).map(m => `• ${m.code || m.id} ${m.shortName || ''}`).join('\n');
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🔍 找到 ${matches.length} 筆,請輸入更精確的關鍵字:\n\n${preview}\n...(還有 ${matches.length - 5} 筆)`,
                quickReply: quickReply([skipCustBtn, cancelBtn]),
            }],
        });
    }

    const items = matches.map(m => ({
        type: 'action',
        action: {
            type: 'message',
            label: `${m.code || m.id} ${m.shortName || ''}`.substring(0, 20),
            text: m.code || m.id,
        },
    }));
    items.push(cancelBtn);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `🔍 找到 ${matches.length} 筆,請點選:`,
            quickReply: quickReply(items),
        }],
    });
}

// ==========================================
// Step 1b: 自行輸入客戶名
// ==========================================
async function handleCustomCustomerNameStep(state, input, lineUid, replyToken, lineClient) {
    if (!input) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '⚠️ 客戶名稱不能空白,請重新輸入。', quickReply: quickReply([cancelBtn]) }],
        });
    }
    state.data.customer = {
        name: input,
        phone: '',
        contactPerson: '',
        email: '',
    };
    state.step = 'waiting_items';
    await setState(lineUid, state);
    return promptItems(lineUid, replyToken, lineClient, false);
}

// ==========================================
// 從 Customers doc 組出 xlsx 需要的客戶欄位,進入商品 step
// ==========================================
async function advanceToItems(state, customerData, lineUid, replyToken, lineClient) {
    const customer = {
        name: customerData.fullName || customerData.shortName || customerData.name || customerData.id,
        phone: customerData.phone || '',
        contactPerson: customerData.contactPerson || customerData.contact || '',
        email: customerData.email || '',
    };
    state.data.customer = customer;
    state.step = 'waiting_items';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✅ 客戶已帶入\n━━━━━━━━\n${customer.name}\n📞 ${customer.phone || '(未提供)'}\n👤 ${customer.contactPerson || '(未提供)'}\n✉️ ${customer.email || '(未提供)'}\n━━━━━━━━\n\n請輸入商品明細(一行一個)\n格式:型號 x 數量 @ 單價\n例:KHS3104pu x300 @342\n\n輸入完所有商品後點「送出」產出報價單`,
            quickReply: itemsStepQuickReply(false),
        }],
    });
}

// ==========================================
// Step 2: 商品
// ==========================================
async function promptItems(lineUid, replyToken, lineClient, hasItems) {
    return lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: hasItems
                ? '✅ 繼續加下一筆,或點「送出」產出報價單'
                : '請輸入商品明細(一行一個)\n格式:型號 x 數量 @ 單價\n例:KHS3104pu x300 @342',
            quickReply: itemsStepQuickReply(hasItems),
        }],
    });
}

async function handleItemsStep(state, input, event, lineClient) {
    const lineUid = event.source.userId;
    const replyToken = event.replyToken;
    const items = state.data.items || [];

    if (input === '清空') {
        state.data.items = [];
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '🧹 已清空商品,請重新輸入', quickReply: itemsStepQuickReply(false) }],
        });
    }

    if (input === '送出') {
        if (items.length === 0) {
            return lineClient.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: '⚠️ 還沒輸入任何商品,請先加明細。', quickReply: itemsStepQuickReply(false) }],
            });
        }
        return finalizeAndGenerate(state, event, lineClient);
    }

    // 支援多行輸入 (一次貼多筆)
    const lines = input.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const added = [];
    const rejected = [];
    for (const line of lines) {
        const parsed = tryParseItem(line);
        if (!parsed) {
            rejected.push({ line, reason: '格式無法解析' });
            continue;
        }
        if (!parsed.unitPrice || parsed.unitPrice <= 0) {
            rejected.push({ line, reason: '缺單價(報價單必填)' });
            continue;
        }
        added.push(parsed);
    }

    if (added.length > 0) {
        state.data.items = [...items, ...added];
        await setState(lineUid, state);
    }

    const summary = state.data.items
        .map((it, i) => `${i + 1}. ${it.model} x${it.qty} @${it.unitPrice} = ${it.qty * it.unitPrice}`)
        .join('\n');
    let msg = '';
    if (added.length > 0) {
        msg += `✅ 已加入 ${added.length} 筆\n`;
    }
    if (rejected.length > 0) {
        msg += `⚠️ 有 ${rejected.length} 筆無法加入:\n`;
        msg += rejected.map(r => `  • ${r.line} (${r.reason})`).join('\n') + '\n';
    }
    msg += `\n━━━━━━━━\n目前明細 (${state.data.items.length} 筆):\n${summary}\n━━━━━━━━\n\n繼續加或點「送出」產出報價單。\n\n格式範例:型號 x 數量 @ 單價`;

    return lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: msg, quickReply: itemsStepQuickReply(state.data.items.length > 0) }],
    });
}

// ==========================================
// 送出 → 產 PDF
// push 到當前對話 (群組 or DM),不是永遠 push 到管理員個人
// ==========================================
async function finalizeAndGenerate(state, event, lineClient) {
    const lineUid = event.source.userId;
    const replyToken = event.replyToken;
    const targetId = event.source.groupId || event.source.roomId || event.source.userId;

    await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: '⏳ 正在產出報價單 (xlsx),請稍候...' }],
    });

    try {
        const { url, totalAmount, productCount } = await generateQuoteSheet({
            customer: state.data.customer,
            items: state.data.items,
            sellerName: '郭庭豪',
        });

        await clearState(lineUid);

        await lineClient.pushMessage({
            to: targetId,
            messages: [{
                type: 'text',
                text: `✅ 報價單產出完成\n━━━━━━━━\n客戶:${state.data.customer.name}\n商品:${productCount} 筆\n總計(含稅):${totalAmount.toLocaleString()}\n━━━━━━━━\n\n📥 下載連結 (xlsx):\n${url}`,
            }],
        });
    } catch (err) {
        console.error('[quoteSheet] 產出失敗', err);
        await clearState(lineUid);
        await lineClient.pushMessage({
            to: targetId,
            messages: [{ type: 'text', text: `❌ 產出報價單失敗:${err.message}` }],
        });
    }
}

module.exports = { startQuoteSheetFlow, handleConversationInput };
