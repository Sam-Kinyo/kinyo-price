/**
 * sampleConversation.js
 * 借樣品 對話式 flow
 *
 * 狀態機：
 *   客戶 → 收件方式 → 商品 → 借樣案名 → 預計歸還日 → 備註 → Flex 確認卡
 *   任何階段輸入「取消」會中止並清 state
 *
 * 差異 vs 訂單:
 *   - 商品沒有單價（樣品）
 *   - 取代「物流/到貨」改問「案名/歸還日」
 *   - Flex 配色橘色 (#F59E0B) 借樣識別
 */

const { admin, db } = require('../utils/firebase');
const { getState, setState, clearState, TTL_MINUTES } = require('../services/conversationState');

const CODE_PATTERN = /^[A-Za-z]{2,4}\d{3,6}(-\d+)?$/;

// 商品行格式：型號 x 數量（沒單價）
function tryParseSampleItem(input) {
    const cleaned = String(input).trim()
        .replace(/[＊✕×*]/g, 'x')
        .replace(/[個件台箱組盒支瓶罐袋包片條顆]/g, ' ')
        .replace(/(?<![A-Za-z])pcs?(?![A-Za-z])/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    let m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*x\s*(\d+)/i);
    if (m) return { model: m[1].toUpperCase(), quantity: parseInt(m[2], 10) };
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s+(\d+)/i);
    if (m) return { model: m[1].toUpperCase(), quantity: parseInt(m[2], 10) };
    // 只打型號（沒數量）→ 預設 1
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*$/);
    if (m) return { model: m[1].toUpperCase(), quantity: 1 };
    return null;
}

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

// QuickReply
const cancelBtn = { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } };
const submitBtn = { type: 'action', action: { type: 'message', label: '✅ 送出', text: '送出' } };
const skipBtn = { type: 'action', action: { type: 'message', label: '⏭️ 跳過', text: '跳過' } };
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
// 進入點
// ==========================================
async function startSampleFlow(lineUid, groupId, replyToken, lineClient) {
    await setState(lineUid, {
        flow: 'borrow_sample',
        step: 'waiting_customer',
        data: { items: [] },
        groupId: groupId || null,
        startedAt: new Date().toISOString(),
    });
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📦 進入「借樣品」對話模式\n\n請輸入客戶編號或簡稱\n(例：耐嘉 或 耐嘉股份有限公司)\n\n💡 ${TTL_MINUTES} 分鐘未回應自動過期`,
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
            messages: [{ type: 'text', text: '❌ 已取消借樣品對話。' }]
        });
        return;
    }

    if (state.step === 'waiting_customer') {
        await handleCustomerStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_shipping_choice') {
        await handleShippingChoiceStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_items') {
        await handleItemsStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_logistics') {
        await handleLogisticsStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_name') {
        await handleOverrideNameStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_phone') {
        await handleOverridePhoneStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_address') {
        await handleOverrideAddressStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_confirm') {
        await handleOverrideConfirmStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_project_name') {
        await handleProjectNameStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_return_date') {
        await handleReturnDateStep(state, input, lineUid, replyToken, lineClient);
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
        if (doc.exists) return advanceToShippingChoice(state, doc.data(), lineUid, replyToken, lineClient);
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `⚠️ 查無客戶編號「${code}」\n請重新輸入。`, quickReply: quickReply([cancelBtn]) }]
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
            messages: [{ type: 'text', text: `⚠️ 查無符合「${input}」的客戶\n請換一個關鍵字或輸入客戶編號。`, quickReply: quickReply([cancelBtn]) }]
        });
    }
    if (matches.length === 1) return advanceToShippingChoice(state, matches[0], lineUid, replyToken, lineClient);
    if (matches.length > 5) {
        const preview = matches.slice(0, 5).map(m => `• ${m.code} ${m.shortName}`).join('\n');
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: `🔍 找到 ${matches.length} 筆符合，請輸入更精確的關鍵字：\n\n${preview}\n...(還有 ${matches.length - 5} 筆)`, quickReply: quickReply([cancelBtn]) }]
        });
    }
    const items = matches.map(m => ({
        type: 'action',
        action: { type: 'message', label: `${m.code} ${m.shortName}`.substring(0, 20), text: m.code }
    }));
    items.push(cancelBtn);
    await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: `🔍 找到 ${matches.length} 筆符合，請點選：`, quickReply: quickReply(items) }]
    });
}

async function advanceToShippingChoice(state, customerData, lineUid, replyToken, lineClient) {
    const customer = {
        code: customerData.code || customerData.id || '',
        shortName: customerData.shortName || '',
        fullName: customerData.fullName || '',
        phone: customerData.phone || '',
        address: customerData.address || '',
        taxId: customerData.taxId || '',
    };
    state.data.customer = customer;
    state.step = 'waiting_shipping_choice';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✅ 已識別\n━━━━━━━━━\n【${customer.code}】${customer.shortName}\n${customer.fullName}\n📞 ${customer.phone || '未提供'}\n📍 ${customer.address || '未提供'}\n━━━━━━━━━\n\n請選擇收件方式：`,
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '🏢 寄到公司 (預設)', text: '寄到公司' } },
                { type: 'action', action: { type: 'message', label: '✍️ 指定收件資料', text: '指定收件資料' } },
                cancelBtn
            ])
        }]
    });
}

// ==========================================
// Step 2: 收件方式
// ==========================================
async function handleShippingChoiceStep(state, input, lineUid, replyToken, lineClient) {
    const keepDefault = ['寄到公司', '預設', '預設地址', 'A', 'a', '公司'].includes(input);
    const wantOverride = ['指定收件資料', '修改', '指定', 'B', 'b'].includes(input);

    if (keepDefault) {
        state.step = 'waiting_items';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🏢 將寄到預設地址：\n${state.data.customer.address || '未提供'}\n\n請輸入樣品明細（一行一個）\n格式：型號 x 數量\n例：KHS3104pu x2`,
                quickReply: itemsStepQuickReply(false)
            }]
        });
    }
    if (wantOverride) {
        state.data.override = {};
        state.step = 'waiting_override_name';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `✍️ 指定收件資料\n\n請輸入「收件人姓名」\n(不需要修改請點「跳過」，沿用預設：${state.data.customer.shortName})`,
                quickReply: quickReply([skipBtn, cancelBtn])
            }]
        });
    }
    return lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: '⚠️ 請點選以下其中一個：',
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '🏢 寄到公司 (預設)', text: '寄到公司' } },
                { type: 'action', action: { type: 'message', label: '✍️ 指定收件資料', text: '指定收件資料' } },
                cancelBtn
            ])
        }]
    });
}

// ==========================================
// Step 3: 商品明細
// ==========================================
async function handleItemsStep(state, input, lineUid, replyToken, lineClient) {
    if (input === '修改商品' || input === '修改明細' || input === '重填商品') {
        state.data.items = [];
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🔧 已清空明細\n\n請重新輸入樣品明細（一行一個）\n格式：型號 x 數量\n例：KHS3104pu x2`,
                quickReply: itemsStepQuickReply(false)
            }]
        });
    }
    if (input === '送出' || input === '完成') {
        if (!state.data.items || state.data.items.length === 0) {
            return lineClient.replyMessage({
                replyToken,
                messages: [{ type: 'text', text: '⚠️ 尚未輸入任何樣品，請至少輸入一筆。', quickReply: quickReply([cancelBtn]) }]
            });
        }
        state.step = 'waiting_logistics';
        await setState(lineUid, state);
        const itemsPreview = state.data.items.map(it => `• ${it.model} x${it.quantity}`).join('\n');
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `📦 目前共 ${state.data.items.length} 筆：\n${itemsPreview}\n\n請選擇物流方式：`,
                quickReply: quickReply([
                    { type: 'action', action: { type: 'message', label: '🚚 大榮貨運', text: '大榮貨運' } },
                    { type: 'action', action: { type: 'message', label: '📮 郵局', text: '郵局' } },
                    { type: 'action', action: { type: 'message', label: '🚛 專車', text: '專車' } },
                    { type: 'action', action: { type: 'message', label: '🏃 自取', text: '自取' } },
                    cancelBtn
                ])
            }]
        });
    }

    const lines = input.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const added = [];
    const failed = [];
    for (const line of lines) {
        const item = tryParseSampleItem(line);
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
                text: `⚠️ 無法解析「${input}」\n請用：型號 x 數量\n例：KHS3104pu x2`,
                quickReply: itemsStepQuickReply(state.data.items.length > 0)
            }]
        });
    }
    await setState(lineUid, state);

    const addedMsg = added.map(it => `• ${it.model} x${it.quantity}`).join('\n');
    let msg = `✅ 已加入 ${added.length} 筆：\n${addedMsg}\n\n目前累積 ${state.data.items.length} 筆\n繼續輸入、或點「送出」完成`;
    if (failed.length > 0) {
        msg += `\n\n⚠️ 以下無法解析（已略過）：\n${failed.map(l => `• ${l}`).join('\n')}`;
    }
    await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'text', text: msg, quickReply: itemsStepQuickReply(true) }]
    });
}

// ==========================================
// Step: 物流方式
// ==========================================
const LOGISTICS_OPTIONS = ['大榮貨運', '郵局', '專車', '自取'];
async function handleLogisticsStep(state, input, lineUid, replyToken, lineClient) {
    const matched = LOGISTICS_OPTIONS.find(opt => input.includes(opt) || opt.includes(input));
    if (!matched) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: '⚠️ 請點選物流選項：',
                quickReply: quickReply([
                    { type: 'action', action: { type: 'message', label: '🚚 大榮貨運', text: '大榮貨運' } },
                    { type: 'action', action: { type: 'message', label: '📮 郵局', text: '郵局' } },
                    { type: 'action', action: { type: 'message', label: '🚛 專車', text: '專車' } },
                    { type: 'action', action: { type: 'message', label: '🏃 自取', text: '自取' } },
                    cancelBtn
                ])
            }]
        });
    }
    state.data.logistics = matched;
    state.step = 'waiting_project_name';
    await setState(lineUid, state);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `🚚 物流方式：${matched}\n\n請輸入「借樣品案名」\n(例：2026年Q2提案、某某展覽佈置等)\n若沒有案名可點「無」`,
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '⏭️ 無', text: '無' } },
                cancelBtn
            ])
        }]
    });
}

// ==========================================
// Override sub-flow (同 order)
// ==========================================
async function handleOverrideNameStep(state, input, lineUid, replyToken, lineClient) {
    if (!['跳過', '無', '否'].includes(input)) state.data.override.name = input;
    state.step = 'waiting_override_phone';
    await setState(lineUid, state);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `請輸入「聯絡電話」\n(不需要修改請點「跳過」，沿用預設：${state.data.customer.phone || '未提供'})`,
            quickReply: quickReply([skipBtn, cancelBtn])
        }]
    });
}

async function handleOverridePhoneStep(state, input, lineUid, replyToken, lineClient) {
    if (!['跳過', '無', '否'].includes(input)) state.data.override.phone = input;
    state.step = 'waiting_override_address';
    await setState(lineUid, state);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `請輸入「指定送貨地址」\n(不需要修改請點「跳過」，沿用預設：${state.data.customer.address || '未提供'})`,
            quickReply: quickReply([skipBtn, cancelBtn])
        }]
    });
}

async function handleOverrideAddressStep(state, input, lineUid, replyToken, lineClient) {
    if (!['跳過', '無', '否'].includes(input)) state.data.override.address = input;
    state.step = 'waiting_override_confirm';
    await setState(lineUid, state);

    const o = state.data.override || {};
    const c = state.data.customer;
    const displayName = o.name || c.shortName;
    const displayPhone = o.phone || c.phone || '未提供';
    const displayAddress = o.address || c.address || '未提供';
    const changed = [];
    if (o.name) changed.push('收件人');
    if (o.phone) changed.push('電話');
    if (o.address) changed.push('地址');
    const changedSummary = changed.length > 0 ? `已指定：${changed.join('、')}` : '未修改，沿用預設';

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📋 收件資料確認 (${changedSummary})\n━━━━━━━━━\n👤 收件人：${displayName}\n📞 電話：${displayPhone}\n📍 地址：${displayAddress}\n━━━━━━━━━\n\n是否正確？`,
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '✅ 確認', text: '確認' } },
                { type: 'action', action: { type: 'message', label: '🔧 修改', text: '修改' } },
                cancelBtn
            ])
        }]
    });
}

async function handleOverrideConfirmStep(state, input, lineUid, replyToken, lineClient) {
    const confirmed = ['確認', '正確', '是', 'Y', 'y', '✅'].includes(input);
    const refill = ['修改', '重填', '重新', '重來', 'R', 'r'].includes(input);
    if (confirmed) {
        state.step = 'waiting_items';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `✅ 收件資料已鎖定\n\n請輸入樣品明細（一行一個）\n格式：型號 x 數量\n例：KHS3104pu x2`,
                quickReply: itemsStepQuickReply(false)
            }]
        });
    }
    if (refill) {
        state.data.override = {};
        state.step = 'waiting_override_name';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🔄 重新填寫\n\n請輸入「收件人姓名」\n(沿用預設請點「跳過」：${state.data.customer.shortName})`,
                quickReply: quickReply([skipBtn, cancelBtn])
            }]
        });
    }
    return lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: '⚠️ 請點選以下其中一個：',
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '✅ 確認', text: '確認' } },
                { type: 'action', action: { type: 'message', label: '🔧 修改', text: '修改' } },
                cancelBtn
            ])
        }]
    });
}

// ==========================================
// Step 4: 借樣案名
// ==========================================
async function handleProjectNameStep(state, input, lineUid, replyToken, lineClient) {
    let display;
    if (['無', '跳過', '否', '沒有'].includes(input)) {
        state.data.projectName = '';
        display = '(無)';
    } else if (!input || input.length > 80) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: '⚠️ 請輸入借樣案名（80 字以內），或點「無」略過',
                quickReply: quickReply([{ type: 'action', action: { type: 'message', label: '⏭️ 無', text: '無' } }, cancelBtn])
            }]
        });
    } else {
        state.data.projectName = input;
        display = input;
    }
    state.step = 'waiting_return_date';
    await setState(lineUid, state);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📁 案名：${display}\n\n請輸入「預計歸還日期」\n(例：2026/05/31 或 2026-05-31)\n若沒有確定日期可點「無」`,
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '⏭️ 無', text: '無' } },
                cancelBtn
            ])
        }]
    });
}

// ==========================================
// Step 5: 預計歸還日
// ==========================================
async function handleReturnDateStep(state, input, lineUid, replyToken, lineClient) {
    let display;
    if (['無', '跳過', '否', '沒有'].includes(input)) {
        state.data.returnDate = '';
        display = '(無)';
    } else {
        const parsed = tryParseDate(input);
        if (!parsed) {
            return lineClient.replyMessage({
                replyToken,
                messages: [{
                    type: 'text',
                    text: '⚠️ 無法解析日期，請用 YYYY/MM/DD 格式\n例：2026/05/31，或點「無」略過',
                    quickReply: quickReply([{ type: 'action', action: { type: 'message', label: '⏭️ 無', text: '無' } }, cancelBtn])
                }]
            });
        }
        state.data.returnDate = parsed;
        display = parsed;
    }
    state.step = 'waiting_remark';
    await setState(lineUid, state);
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📅 預計歸還：${display}\n\n是否要加備註？\n• 有 → 直接輸入備註內容\n• 無 → 點「跳過」`,
            quickReply: quickReply([skipBtn, cancelBtn])
        }]
    });
}

// ==========================================
// Step 6: 備註 → 完成 (寫 tempOrders + Flex 確認卡)
// ==========================================
async function handleRemarkStep(state, input, lineUid, replyToken, lineClient) {
    if (['跳過', '無', '否'].includes(input)) state.data.remark = '';
    else state.data.remark = input;

    const customer = state.data.customer;
    const displayName = state.data.override?.name || customer.shortName;
    const displayPhone = state.data.override?.phone || customer.phone;
    const displayAddress = state.data.override?.address || customer.address;

    const tempData = {
        action: 'borrow_sample',
        customer: {
            company: customer.fullName || customer.shortName,
            name: displayName,
            phone: displayPhone,
            address: displayAddress,
            projectName: state.data.projectName || '',
            returnDate: state.data.returnDate || '',
            logistics: state.data.logistics || '',
            remark: state.data.remark || '',
            customerCode: customer.code,
            customerShortName: customer.shortName,
            hasOverride: !!(state.data.override?.name || state.data.override?.phone || state.data.override?.address),
        },
        items: state.data.items.map(it => ({ model: it.model, quantity: it.quantity })),
    };

    const tempOrderRef = await db.collection('tempOrders').add(tempData);
    await clearState(lineUid);

    let totalQty = 0;
    const itemsText = tempData.items.map(it => {
        totalQty += it.quantity;
        return `${it.model} x${it.quantity}`;
    }).join('\n') || '未提供明細';

    const flexMessage = {
        type: 'flex',
        altText: '借樣品申請已建立，請確認',
        contents: {
            type: 'bubble',
            header: {
                type: 'box', layout: 'vertical', backgroundColor: '#F59E0B',
                contents: [{ type: 'text', text: '📦 借樣品申請已建立，請確認', color: '#ffffff', weight: 'bold' }]
            },
            body: {
                type: 'box', layout: 'vertical', spacing: 'sm',
                contents: [
                    { type: 'text', text: `🏷️ 客戶: 【${customer.code}】${customer.shortName}`, size: 'sm', weight: 'bold' },
                    { type: 'text', text: `🏢 ${customer.fullName}`, size: 'xs', color: '#666666', wrap: true },
                    { type: 'text', text: `👤 收件: ${displayName}${state.data.override?.name ? ' (指定)' : ''}`, size: 'sm' },
                    { type: 'text', text: `📞 ${displayPhone || '未提供'}${state.data.override?.phone ? ' (指定)' : ''}`, size: 'sm' },
                    { type: 'text', text: `📍 ${displayAddress || '未提供'}${state.data.override?.address ? ' (指定)' : ''}`, size: 'sm', wrap: true, color: state.data.override?.address ? '#E11D48' : '#111111' },
                    { type: 'text', text: `🚚 物流: ${state.data.logistics || '未指定'}`, size: 'sm', margin: 'sm' },
                    ...(state.data.projectName ? [{ type: 'text', text: `📁 案名: ${state.data.projectName}`, size: 'sm', color: '#E11D48', wrap: true }] : []),
                    { type: 'text', text: `📅 預計歸還: ${state.data.returnDate || '無'}`, size: 'sm', color: '#E11D48', weight: 'bold' },
                    { type: 'text', text: `📝 備註: ${state.data.remark || '無'}`, size: 'sm', wrap: true },
                    { type: 'separator', margin: 'md' },
                    { type: 'text', text: itemsText, size: 'sm', wrap: true, margin: 'md' },
                    { type: 'text', text: `共 ${totalQty} 件`, size: 'sm', weight: 'bold', color: '#F59E0B' }
                ]
            },
            footer: {
                type: 'box', layout: 'vertical', spacing: 'sm',
                contents: [
                    {
                        type: 'button', style: 'primary', color: '#F59E0B',
                        action: { type: 'postback', label: '✅ 確認無誤', data: `action=confirm_sample&id=${tempOrderRef.id}` }
                    },
                    {
                        type: 'box', layout: 'horizontal', spacing: 'sm',
                        contents: [
                            {
                                type: 'button', style: 'secondary',
                                action: { type: 'postback', label: '🔧 修改', data: `action=modify_sample&id=${tempOrderRef.id}` }
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

module.exports = { startSampleFlow, handleConversationInput };
