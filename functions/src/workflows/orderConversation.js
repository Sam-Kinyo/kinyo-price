/**
 * orderConversation.js
 * 訂單 對話式 flow
 *
 * 狀態機：
 *   (start) → waiting_customer → waiting_delivery → waiting_items → waiting_remark → (完成，寫 PendingOrders + Flex 確認卡)
 *   任何階段輸入「取消」都會中止並清 state
 */

const { admin, db } = require('../utils/firebase');
const { getState, setState, clearState, TTL_MINUTES } = require('../services/conversationState');
const { calculateLevelPrice } = require('../utils/priceCalculator');

// 客戶編號 pattern
const CODE_PATTERN = /^[A-Za-z]{2,4}\d{3,6}(-\d+)?$/;

// 商品行格式：支援多種寫法
//   KHS3104pu x300 @342
//   KPB2512BR 10個 320元
//   KPB-2990 x5 @100
//   KHS3104 10 320
//   KHS3104 10個
function tryParseItem(input) {
    // 1. 正規化：統一 x、去除貨幣符號、保留 箱/件 當單位標記，其他量詞轉空白
    const cleaned = String(input).trim()
        .replace(/[＊✕×*]/g, 'x')
        .replace(/[＠]/g, '@')
        .replace(/元整?|NT\$?|\$/gi, '')
        .replace(/[個台組盒支瓶罐袋包片條顆]/g, ' ')               // 其他量詞 → 空白
        .replace(/(?<![A-Za-z])pcs?(?![A-Za-z])/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    // Pattern A: model x qty [箱/件] [@ price]
    let m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*x\s*(\d+)\s*([箱件])?\s*(?:@\s*(\d+))?/i);
    if (m) {
        return { model: m[1].toUpperCase(), qty: parseInt(m[2], 10), unit: m[3] || null, unitPrice: m[4] ? parseInt(m[4], 10) : null };
    }

    // Pattern B: model qty [箱/件] [price]
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s+(\d+)\s*([箱件])?\s*(?:\s+@?\s*(\d+))?/i);
    if (m) {
        return { model: m[1].toUpperCase(), qty: parseInt(m[2], 10), unit: m[3] || null, unitPrice: m[4] ? parseInt(m[4], 10) : null };
    }

    // 只打型號（沒數量）→ 預設 1
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*$/);
    if (m) return { model: m[1].toUpperCase(), qty: 1, unit: null, unitPrice: null };

    return null;
}

// ==========================================
// QuickReply 按鈕
// ==========================================
const cancelBtn = { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } };
const submitBtn = { type: 'action', action: { type: 'message', label: '✅ 送出', text: '送出' } };
const skipBtn = { type: 'action', action: { type: 'message', label: '⏭️ 跳過', text: '跳過' } };
const modifyItemsBtn = { type: 'action', action: { type: 'message', label: '🔧 修改', text: '修改商品' } };
function quickReply(items) { return { items }; }

// 商品 step 的 quickReply：視是否已加過商品決定要不要顯示送出/修改
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
// 進入點 - 使用者打「訂單」
// ==========================================
async function startOrderFlow(lineUid, groupId, replyToken, lineClient) {
    await setState(lineUid, {
        flow: 'order',
        step: 'waiting_customer',
        data: { items: [] },
        groupId: groupId || null,
        startedAt: new Date().toISOString(),
    });

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `📝 進入「訂單」對話模式\n\n請輸入客戶編號或簡稱\n(例：耐嘉 或 耐嘉股份有限公司)\n\n💡 ${TTL_MINUTES} 分鐘未回應自動過期`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// 主分派
// ==========================================
async function handleConversationInput(state, userText, event, lineClient, userContext) {
    const lineUid = event.source.userId;
    const replyToken = event.replyToken;
    const input = userText.replace(/@KINYO挺好的\s*/g, '').trim();

    if (input === '取消' || input === '@KINYO挺好的 取消') {
        await clearState(lineUid);
        await lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '❌ 已取消訂單對話。' }]
        });
        return;
    }

    if (state.step === 'waiting_customer') {
        await handleCustomerStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_shipping_choice') {
        await handleShippingChoiceStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_items') {
        await handleItemsStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_price_conflict') {
        await handlePriceConflictStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_name') {
        await handleOverrideNameStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_phone') {
        await handleOverridePhoneStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_address') {
        await handleOverrideAddressStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_override_confirm') {
        await handleOverrideConfirmStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_logistics') {
        await handleLogisticsStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_delivery') {
        await handleDeliveryStep(state, input, lineUid, replyToken, lineClient);
    } else if (state.step === 'waiting_remark') {
        await handleRemarkStep(state, input, lineUid, replyToken, lineClient, event, userContext);
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
            messages: [{
                type: 'text',
                text: `⚠️ 查無客戶編號「${code}」\n請重新輸入。`,
                quickReply: quickReply([cancelBtn])
            }]
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
                text: `🔍 找到 ${matches.length} 筆符合，請輸入更精確的關鍵字：\n\n${preview}\n...(還有 ${matches.length - 5} 筆)`,
                quickReply: quickReply([cancelBtn])
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
        pricingRule: customerData.pricingRule || null,
    };
    state.data.customer = customer;
    state.step = 'waiting_shipping_choice';
    await setState(lineUid, state);

    const pricingHint = customer.pricingRule?.type === 'level_qty'
        ? `\n\n🔒 此客戶已設定自動計價 (Level ${customer.pricingRule.level} / ${customer.pricingRule.refQty} 數量)，未填單價時系統會自動套用`
        : '';

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `✅ 已識別\n━━━━━━━━━\n【${customer.code}】${customer.shortName}\n${customer.fullName}\n📞 ${customer.phone || '未提供'}\n📍 ${customer.address || '未提供'}\n━━━━━━━━━${pricingHint}\n\n請選擇收件方式：`,
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: '🏢 寄到公司 (預設)', text: '寄到公司' } },
                { type: 'action', action: { type: 'message', label: '✍️ 指定收件資料', text: '指定收件資料' } },
                cancelBtn
            ])
        }]
    });
}

// ==========================================
// Step 1.5: 選擇收件方式 (A 寄到公司 / B 指定收件資料)
// ==========================================
async function handleShippingChoiceStep(state, input, lineUid, replyToken, lineClient) {
    const keepDefault = input === '寄到公司' || input === '預設' || input === '預設地址' ||
        input.toUpperCase() === 'A' || input === '公司';
    const wantOverride = input === '指定收件資料' || input === '修改' || input === '指定' ||
        input.toUpperCase() === 'B';

    if (keepDefault) {
        state.step = 'waiting_items';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `🏢 將寄到公司預設地址：\n${state.data.customer.address || '未提供'}\n\n請輸入商品明細（一行一個）\n格式：型號 x 數量 @ 單價 (單價可省略)\n例：KHS3104pu x300 @342`,
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
// Step 2: 商品明細 → 進入物流選項
// ==========================================
async function handleItemsStep(state, input, lineUid, replyToken, lineClient) {
    // 修改：清空已輸入的商品明細，重新輸入
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

        // 檢查是否有固定價 vs 使用者輸入價衝突，需要逐一詢問
        const conflicts = [];
        state.data.items.forEach((it, idx) => {
            if (it.priceConflict) {
                conflicts.push({ itemIndex: idx, model: it.model, ...it.priceConflict });
            }
        });
        if (conflicts.length > 0) {
            state.data.conflicts = conflicts;
            state.step = 'waiting_price_conflict';
            await setState(lineUid, state);
            return askNextConflict(state, lineUid, replyToken, lineClient);
        }

        // 沒衝突 → 直接進物流
        await advanceToLogistics(state, lineUid, replyToken, lineClient);
        return;
    }

    const lines = input.split(/\n+/).map(l => l.trim()).filter(Boolean);
    const added = [];
    const failed = [];
    const notFoundModels = [];
    const customer = state.data.customer;
    const rule = customer?.pricingRule;
    for (const line of lines) {
        const item = tryParseItem(line);
        if (!item) { failed.push(line); continue; }

        // 箱/件 → 查 Products.cartonQty 自動換算成實際數量
        if (item.unit === '箱' || item.unit === '件') {
            const prod = await lookupProduct(item.model);
            if (prod && prod.cartonQty) {
                const boxQty = parseInt(prod.cartonQty) || 1;
                if (boxQty > 1) {
                    item.origBoxes = item.qty;
                    item.cartonQty = boxQty;
                    item.qty = item.qty * boxQty;
                }
            }
        }

        // 查這客戶的型號固定價
        const fixed = await lookupCustomerFixedPrice(customer?.code, item.model);

        const hasUserPrice = item.unitPrice != null && item.unitPrice !== 0;

        if (fixed) {
            if (!hasUserPrice) {
                // 沒打價 → 套固定價
                item.unitPrice = fixed.unitPrice;
                item.autoPriced = true;
                item.fixedPrice = true;
            } else if (Number(item.unitPrice) !== Number(fixed.unitPrice)) {
                // 使用者打了不同的價 → 標記衝突，稍後詢問
                item.priceConflict = { fixedPrice: fixed.unitPrice, userPrice: Number(item.unitPrice), lastOrderDate: fixed.lastOrderDate };
            } else {
                // 使用者打了相同的價 → 也算自動價
                item.fixedPrice = true;
            }
        } else if (rule?.type === 'level_qty' && !hasUserPrice) {
            // 沒固定價但有整體規則 → 算 Level/Qty
            const autoPrice = await lookupAutoPrice(item.model, rule.level, rule.refQty);
            if (autoPrice) {
                item.unitPrice = autoPrice;
                item.autoPriced = true;
            } else {
                notFoundModels.push(item.model);
            }
        }

        state.data.items.push(item);
        added.push(item);
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

    const addedMsg = added.map(it => {
        let mark = '';
        if (it.priceConflict) mark = ` ⚠️ (固定價 $${it.priceConflict.fixedPrice})`;
        else if (it.fixedPrice) mark = ' 🔒 固定價';
        else if (it.autoPriced) mark = ' 🔒 自動';
        const boxNote = it.origBoxes ? ` (${it.origBoxes}${it.unit}×${it.cartonQty}入)` : '';
        return `• ${it.model} x${it.qty}${boxNote}${it.unitPrice ? ` @${it.unitPrice}` : ''}${mark}`;
    }).join('\n');
    let msg = `✅ 已加入 ${added.length} 筆：\n${addedMsg}\n\n目前累積 ${state.data.items.length} 筆\n繼續輸入、或點「送出」完成`;
    const hasConflict = added.some(it => it.priceConflict);
    if (hasConflict) {
        msg += `\n\n⚠️ 有型號的輸入價與固定價不同，點「送出」後系統會逐一詢問`;
    }
    if (notFoundModels.length > 0) {
        msg += `\n\n⚠️ 找不到以下型號於商品主檔，未能自動計價 (單價待確認):\n${notFoundModels.map(m => `• ${m}`).join('\n')}`;
    }
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

// 客戶+型號固定價查詢 (Customers/{code}/Pricing/{sanitizedModel})
function sanitizeModel(m) {
    return String(m || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}
async function lookupCustomerFixedPrice(customerCode, modelCode) {
    if (!customerCode || !modelCode) return null;
    const docId = sanitizeModel(modelCode);
    try {
        const doc = await db.collection('Customers').doc(customerCode).collection('Pricing').doc(docId).get();
        if (doc.exists) {
            const data = doc.data();
            return { unitPrice: Number(data.unitPrice), lastOrderDate: data.lastOrderDate || null };
        }
    } catch (e) {
        console.error('[lookupCustomerFixedPrice]', e);
    }
    return null;
}

// 查 Products 主檔 (供 cartonQty / cost / 自動計價等用)
async function lookupProduct(modelCode) {
    if (!modelCode) return null;
    const sanitize = s => String(s || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    const target = sanitize(modelCode);
    const snap = await db.collection('Products').get();
    for (const d of snap.docs) {
        const data = d.data();
        if (sanitize(data.model) === target) return data;
    }
    for (const d of snap.docs) {
        const data = d.data();
        const pSan = sanitize(data.model);
        if (pSan && pSan.length >= 3 && target.startsWith(pSan)) return data;
    }
    return null;
}

// 根據客戶定價規則查成本並自動計算價格
async function lookupAutoPrice(modelCode, level, refQty) {
    const product = await lookupProduct(modelCode);
    if (!product || !product.cost) return null;
    return calculateLevelPrice(product.cost, level, refQty);
}

// ==========================================
// Step: 固定價 vs 使用者輸入衝突解決 (逐一詢問)
// ==========================================
async function askNextConflict(state, lineUid, replyToken, lineClient) {
    const c = state.data.conflicts[0];
    const dateHint = c.lastOrderDate ? ` (最後交易 ${String(c.lastOrderDate).substring(0, 10)})` : '';
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `⚠️ 型號 ${c.model} 價格不一致\n\n🔒 固定價 $${c.fixedPrice}${dateHint}\n✏️ 你輸入 $${c.userPrice}\n\n要用哪個？`,
            quickReply: quickReply([
                { type: 'action', action: { type: 'message', label: `🔒 固定 $${c.fixedPrice}`, text: '用固定價' } },
                { type: 'action', action: { type: 'message', label: `✏️ 用 $${c.userPrice}`, text: '用我的價' } },
                { type: 'action', action: { type: 'message', label: '❌ 刪除這筆', text: '刪除這筆' } },
                cancelBtn
            ])
        }]
    });
}

async function handlePriceConflictStep(state, input, lineUid, replyToken, lineClient) {
    if (!state.data.conflicts || state.data.conflicts.length === 0) {
        // 不應該發生，直接往下走
        await advanceToLogistics(state, lineUid, replyToken, lineClient);
        return;
    }

    const c = state.data.conflicts[0];
    const item = state.data.items[c.itemIndex];

    const useFix = /固定|\$?${c.fixedPrice}/.test(input) || input === '用固定價' || input === '固定';
    const useUser = /我的|自訂|^用\$?${c.userPrice}/.test(input) || input === '用我的價' || input === '我的';
    const del = input === '刪除這筆' || input === '刪除' || input === '移除';

    if (useFix) {
        item.unitPrice = c.fixedPrice;
        item.autoPriced = true;
        item.fixedPrice = true;
        delete item.priceConflict;
    } else if (useUser) {
        // 使用者的價已經是 item.unitPrice
        delete item.priceConflict;
    } else if (del) {
        state.data.items[c.itemIndex] = null; // 標記為刪除，下面 filter 移除
    } else {
        // 不認識的回覆 → 再問一次
        return askNextConflict(state, lineUid, replyToken, lineClient);
    }

    state.data.conflicts.shift();
    await setState(lineUid, state);

    if (state.data.conflicts.length > 0) {
        return askNextConflict(state, lineUid, replyToken, lineClient);
    }

    // 所有衝突解決完 → 清空 null 項目後進物流
    state.data.items = state.data.items.filter(Boolean);
    if (state.data.items.length === 0) {
        await clearState(lineUid);
        return lineClient.replyMessage({
            replyToken,
            messages: [{ type: 'text', text: '⚠️ 所有商品都被刪除了，訂單對話已結束。' }]
        });
    }
    await advanceToLogistics(state, lineUid, replyToken, lineClient);
}

async function advanceToLogistics(state, lineUid, replyToken, lineClient) {
    state.step = 'waiting_logistics';
    state.data.conflicts = null;
    await setState(lineUid, state);
    const itemsPreview = state.data.items.map(it => {
        const boxNote = it.origBoxes ? ` (${it.origBoxes}${it.unit}×${it.cartonQty}入)` : '';
        return `• ${it.model} x${it.qty}${boxNote}${it.unitPrice ? ` @${it.unitPrice}` : ''}${it.fixedPrice ? ' 🔒' : ''}`;
    }).join('\n');
    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `🛒 目前共 ${state.data.items.length} 筆：\n${itemsPreview}\n\n請選擇物流方式：`,
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

// ==========================================
// Override sub-flow: 收件人 → 電話 → 地址 → 回到 items
// ==========================================
async function handleOverrideNameStep(state, input, lineUid, replyToken, lineClient) {
    if (input !== '跳過' && input !== '無' && input !== '否') {
        state.data.override.name = input;
    }
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
    if (input !== '跳過' && input !== '無' && input !== '否') {
        state.data.override.phone = input;
    }
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
    if (input !== '跳過' && input !== '無' && input !== '否') {
        state.data.override.address = input;
    }
    state.step = 'waiting_override_confirm';
    await setState(lineUid, state);

    // 組出 override 後的收件資料摘要
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

// ==========================================
// Step: 確認指定收件資料
// ==========================================
async function handleOverrideConfirmStep(state, input, lineUid, replyToken, lineClient) {
    const confirmed = input === '確認' || input === '正確' || input === '是' || input.toUpperCase() === 'Y' || input === '✅';
    const refill = input === '修改' || input === '重填' || input === '重新' || input === '重來' || input.toUpperCase() === 'R';

    if (confirmed) {
        state.step = 'waiting_items';
        await setState(lineUid, state);
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: `✅ 收件資料已鎖定\n\n請輸入商品明細（一行一個）\n格式：型號 x 數量 @ 單價 (單價可省略)\n例：KHS3104pu x300 @342`,
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
                text: `🔄 重新填寫指定收件資料\n\n請輸入「收件人姓名」\n(不需要修改請點「跳過」，沿用預設：${state.data.customer.shortName})`,
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
// Step 3: 物流方式
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
    state.step = 'waiting_delivery';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `🚚 物流方式：${matched}\n\n請輸入希望到貨時間\n(例：5/15、下週三、4月底、盡快出貨)`,
            quickReply: quickReply([cancelBtn])
        }]
    });
}

// ==========================================
// Step 4: 希望到貨時間 (自由文字)
// ==========================================
async function handleDeliveryStep(state, input, lineUid, replyToken, lineClient) {
    if (!input || input.length > 50) {
        return lineClient.replyMessage({
            replyToken,
            messages: [{
                type: 'text',
                text: '⚠️ 請輸入希望到貨時間（50 字以內）',
                quickReply: quickReply([cancelBtn])
            }]
        });
    }

    state.data.deliveryTime = input;
    state.step = 'waiting_remark';
    await setState(lineUid, state);

    await lineClient.replyMessage({
        replyToken,
        messages: [{
            type: 'text',
            text: `⏰ 希望到貨：${input}\n\n是否要加備註？\n• 有 → 直接輸入備註內容\n• 無 → 點「跳過」`,
            quickReply: quickReply([skipBtn, cancelBtn])
        }]
    });
}

// ==========================================
// Step 5: 備註 → 完成 (寫 PendingOrders + Flex 確認卡)
// ==========================================
async function handleRemarkStep(state, input, lineUid, replyToken, lineClient, event, userContext) {
    if (input === '跳過' || input === '無' || input === '否') {
        state.data.remark = '';
    } else {
        state.data.remark = input;
    }

    const customer = state.data.customer;
    const validItems = state.data.items.map(it => ({
        model: it.model,
        qty: Number(it.qty) || 1,
        unitPrice: it.unitPrice != null ? Number(it.unitPrice) : null,
        subtotal: (it.unitPrice != null && Number(it.unitPrice) > 0) ? Number(it.unitPrice) * (Number(it.qty) || 1) : 0,
        autoPriced: !!it.autoPriced,
        fixedPrice: !!it.fixedPrice,
        origBoxes: it.origBoxes || null,
        cartonQty: it.cartonQty || null,
        unit: it.unit || null,
    }));

    // 計算總金額 + 運費 (比照 order.js 邏輯)
    let totalAmount = validItems.reduce((sum, it) => sum + (it.subtotal || 0), 0);
    const hasMissingPrice = validItems.some(i => i.unitPrice == null || i.unitPrice === 0);
    let shippingFee = 0;
    const realLevel = userContext?.realLevel || 0;
    if (totalAmount === 0 && hasMissingPrice) {
        shippingFee = 0;
    } else {
        shippingFee = (totalAmount >= 3000 || realLevel >= 4) ? 0 : 150;
        totalAmount += shippingFee;
    }

    const orderId = `ORD${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const orderData = {
        orderId,
        userId: lineUid,
        userEmail: userContext?.userEmail || '',
        orderLevel: userContext?.level || 0,
        customer: {
            company: customer.fullName || customer.shortName,
            name: (state.data.override?.name) || customer.shortName,
            phone: (state.data.override?.phone) || customer.phone,
            address: (state.data.override?.address) || customer.address,
            deliveryTime: state.data.deliveryTime,
            logistics: state.data.logistics,
            remark: state.data.remark || '',
            customerCode: customer.code,
            customerShortName: customer.shortName,
            hasOverride: !!(state.data.override?.name || state.data.override?.phone || state.data.override?.address),
        },
        items: validItems,
        totalAmount,
        shippingFee,
        status: 'waiting',
        sourceId: state.groupId || event.source.userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('PendingOrders').doc(orderId).set(orderData);
    await clearState(lineUid);

    // Flex 確認卡
    const itemBoxes = validItems.map(item => {
        const boxNote = item.origBoxes ? ` (${item.origBoxes}${item.unit}×${item.cartonQty})` : '';
        return {
            type: 'box', layout: 'horizontal',
            contents: [
                { type: 'text', text: `${item.model} x${item.qty}${boxNote}${item.fixedPrice || item.autoPriced ? ' 🔒' : ''}`, size: 'sm', flex: 2, wrap: true },
                { type: 'text', text: item.subtotal > 0 ? `$${item.subtotal}` : `待確認`, size: 'sm', color: item.subtotal > 0 ? '#111111' : '#E11D48', align: 'end', flex: 1 }
            ]
        };
    });

    const totalDisplay = totalAmount > 0 ? `$${totalAmount}` : '待確認';

    const flexMessage = {
        type: 'flex',
        altText: '訂單已建立，請確認',
        contents: {
            type: 'bubble',
            header: {
                type: 'box', layout: 'vertical', backgroundColor: '#E11D48',
                contents: [{ type: 'text', text: '📝 訂單已建立，請確認', weight: 'bold', size: 'lg', color: '#FFFFFF' }]
            },
            body: {
                type: 'box', layout: 'vertical',
                contents: [
                    { type: 'text', text: `🏷️ 客戶: 【${customer.code}】${customer.shortName}`, size: 'sm', weight: 'bold' },
                    { type: 'text', text: `🏢 ${customer.fullName}`, size: 'xs', color: '#666666', wrap: true },
                    { type: 'text', text: `👤 收件: ${orderData.customer.name}${state.data.override?.name ? ' (指定)' : ''}`, size: 'sm' },
                    { type: 'text', text: `📞 ${orderData.customer.phone || '未提供'}${state.data.override?.phone ? ' (指定)' : ''}`, size: 'sm' },
                    { type: 'text', text: `📍 ${orderData.customer.address || '未提供'}${state.data.override?.address ? ' (指定)' : ''}`, size: 'sm', wrap: true, color: state.data.override?.address ? '#E11D48' : '#111111' },
                    { type: 'text', text: `🚚 物流: ${state.data.logistics || '未指定'}`, size: 'sm', color: '#555555', margin: 'sm' },
                    { type: 'text', text: `⏰ 到貨: ${state.data.deliveryTime}`, size: 'sm', color: '#1DB446', wrap: true, margin: 'sm' },
                    { type: 'text', text: `📝 備註: ${state.data.remark || '無'}`, size: 'sm', color: '#E11D48', wrap: true, margin: 'sm' },
                    { type: 'separator', margin: 'lg' },
                    { type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm', contents: itemBoxes },
                    { type: 'separator', margin: 'lg' },
                    {
                        type: 'box', layout: 'horizontal', margin: 'lg',
                        contents: [
                            { type: 'text', text: '運費', size: 'sm' },
                            { type: 'text', text: totalAmount > 0 ? (shippingFee === 0 ? '免運' : `$${shippingFee}`) : '待確認', size: 'sm', align: 'end' }
                        ]
                    },
                    {
                        type: 'box', layout: 'horizontal', margin: 'md',
                        contents: [
                            { type: 'text', text: '總計', weight: 'bold', size: 'md', color: '#E11D48' },
                            { type: 'text', text: totalDisplay, weight: 'bold', size: 'md', color: '#E11D48', align: 'end' }
                        ]
                    }
                ]
            },
            footer: {
                type: 'box', layout: 'vertical', spacing: 'sm',
                contents: [
                    {
                        type: 'button', style: 'primary', color: '#0055aa',
                        action: { type: 'postback', label: '✅ 確認無誤', data: `action=confirm_order&orderId=${orderId}` }
                    },
                    {
                        type: 'box', layout: 'horizontal', spacing: 'sm',
                        contents: [
                            {
                                type: 'button', style: 'secondary',
                                action: { type: 'postback', label: '🔧 修改', data: `action=modify_order&orderId=${orderId}` }
                            },
                            {
                                type: 'button', style: 'secondary',
                                action: { type: 'postback', label: '❌ 取消', data: `action=cancel_order&orderId=${orderId}` }
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

module.exports = { startOrderFlow, handleConversationInput };
