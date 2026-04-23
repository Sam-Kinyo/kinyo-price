const functions = require('firebase-functions');
const { setGlobalDispatcher, ProxyAgent } = require('undici');
const { line, messagingApi } = require('@line/bot-sdk');
const { parseUserIntent } = require('./src/llm/geminiParser');

const { admin, db } = require('./src/utils/firebase');
const { transporter } = require('./src/utils/mailer');

// --- 環境變數與設定 ---
// 根據 Firebase Functions v3+ 官方規範，.env 檔案的變數會在中介層自動掛載進 process.env


// --- HTML Escape 工具（防 XSS）---
function escapeHtml(str) {
    if (str == null) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// --- 全域同義詞字典檔 ---
const synonymDict = { "藍芽": "藍牙", "捕蚊拍": "電蚊拍", "台": "臺" };

function normalizeKeyword(str) {
    if (!str) return str;
    let normalized = String(str);
    for (const [key, value] of Object.entries(synonymDict)) {
        normalized = normalized.split(key).join(value);
    }
    return normalized;
}

// --- Imports & Helper Functions ---
const { processOrder } = require('./src/services/order');
const { processQuote } = require('./src/services/quote');
const { calculateLevelPrice } = require('./src/utils/priceCalculator');
const { runStorageSync } = require('./src/services/driveSync');


const normalize = (s) => String(s).replace(/[-\s]/g, '').toUpperCase().trim();
const getConfig = () => ({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    geminiApiKey: process.env.GEMINI_API_KEY
});



exports.lineWebhook = functions.region('asia-east1').https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    const config = getConfig();
    if (!config.channelAccessToken || !config.channelSecret || !config.geminiApiKey) {
        console.error("⚠️ 環境變數尚未完全設定，服務無法執行。");
        res.status(500).send('Internal Server Error: Missing ENV');
        return;
    }

    const lineClient = new messagingApi.MessagingApiClient({
        channelAccessToken: config.channelAccessToken
    });




    try {
        const events = req.body.events;
        if (!events || events.length === 0) {
            res.status(200).send('OK');
            return;
        }

        for (const event of events) {
            let userText = "";
            let lineUid = event.source.userId;
            const groupId = event.source.groupId || event.source.roomId;
            const isGroup = event.source.type === 'group' || event.source.type === 'room';
            const replyToken = event.replyToken;
            let simulatedLevel = null;
            let simulatedKeyword = null;
            let summaryText = ""; // 用於暫停文字摘要，延後到最後與卡片一起發送
            let customToken = ''; // 提升作用域供底部 QuickReply 存取

            let shouldSkipSearch = false; // 用於標記是否純切換指令，跳過後面的商品搜尋

            // --- 全域變數提列 ---
            let realLevel = 0;
            let level = 0;
            let isVip = false;
            let userEmail = "Group_User";
            let currentViewLevel = null;

            // 內部驗證函式：依據環境判定權限
            async function verifyGlobalPermission() {
                if (isGroup) {
                    // 若是群組且是文字訊息，不論有無綁定權限，都必須有提到 @KINYO挺好的 才能處理，否則全部靜默忽略
                    // 例外：若使用者正在進行對話式 flow (ConversationStates 有紀錄)，則放行後續訊息
                    if (event.type === 'message' && (!event.message.text || !event.message.text.includes('@KINYO挺好的'))) {
                        const { getState } = require('./src/services/conversationState');
                        const ongoing = await getState(lineUid);
                        if (!ongoing) {
                            throw new Error('SILENT_IGNORE'); // 中斷處理但不回傳訊息
                        }
                        // 有進行中對話 → 放行，繼續走後續 state 處理
                    }

                    // 1. 群組環境：查驗 Groups 集合
                    const groupDoc = await db.collection('Groups').doc(groupId).get();
                    if (groupDoc.exists && groupDoc.data().level) {
                        currentViewLevel = parseInt(groupDoc.data().level) || 0;
                        realLevel = currentViewLevel;
                        level = currentViewLevel;

                        // 新增：群組開啟兩步認證 - 未經開放查價的群組阻擋對話
                        if (groupDoc.data().isPriceCheckEnabled === false) {
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '⛔ 此群組的查價與各項功能目前為【關閉】狀態。\n若要開放請聯繫業務人員。' }]
                            });
                            throw new Error('PERMISSION_DENIED');
                        }
                    } else {
                        // 群組無權限：這時由於已經擋掉未 tag 的情況，能來到這裡代表使用者確實 tag 了機器人
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '⛔ 此群組尚未綁定報價權限。' }]
                        });
                        throw new Error('PERMISSION_DENIED');
                    }
                } else {
                    // 2. 私訊環境：查驗 Users 集合 (出了群組就失去庇護)
                    const userSnapshot = await db.collection('Users').where('line_uid', '==', lineUid).limit(1).get();
                    if (!userSnapshot.empty) {
                        const userDocData = userSnapshot.docs[0].data();
                        userEmail = userSnapshot.docs[0].id; // 取得使用者的 Email 或是 doc ID
                        if (userDocData.level) {
                            realLevel = parseInt(userDocData.level) || 0;
                            level = parseInt(userDocData.currentViewLevel) || realLevel;
                            isVip = !!userDocData.vipColumn;
                            currentViewLevel = level;

                            if (realLevel < 1 && !isVip) {
                                await lineClient.replyMessage({
                                    replyToken: replyToken,
                                    messages: [{ type: 'text', text: '⛔ 您的個人帳號尚未開通報價權限，請聯繫業務申請。' }]
                                });
                                throw new Error('PERMISSION_DENIED');
                            }
                        } else {
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '⛔ 您的個人帳號尚未開通報價權限，請聯繫業務申請。' }]
                            });
                            throw new Error('PERMISSION_DENIED');
                        }
                    } else {
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '尚未綁定帳號或無查詢權限，請透過系統選單進行綁定。' }]
                        });
                        throw new Error('PERMISSION_DENIED');
                    }
                }
            }

            try {
                // --- 例外處理：優先放行管理員的 #綁定群組 指令，避免陷入死結 ---
                if (event.type === 'message' && event.message.type === 'text') {
                    const text = event.message.text.trim();
                    if (isGroup && text.includes('@KINYO挺好的') && (text.includes('#綁定群組') || text.includes('#解除綁定') || text.includes('#開放查價') || text.includes('#開放報價') || text.includes('#關閉查價') || text.includes('#關閉報價') || text.includes('#封鎖查價'))) {
                        // 交給後續既有的綁定 / 解除邏輯處理，此處直接略過全域權限阻擋
                    } else {
                        // --- 核心全域權限防線啟動 ---
                        await verifyGlobalPermission();
                    }
                } else if (event.type === 'postback') {
                    await verifyGlobalPermission();
                }
            } catch (e) {
                if (e.message === 'SILENT_IGNORE' || e.message === 'PERMISSION_DENIED') {
                    continue; // 捕獲自定義權限異常，結束此 event 的處理
                }
                console.error('[全域權限驗證]', e);
                continue;
            }

            if (event.type === 'message' && event.message.type === 'text') {
                const rawUserMessage = event.message.text.trim();
                userText = rawUserMessage;

                // --- 新增：取得來源 ID 探測指令 ---
                if (rawUserMessage === '@KINYO挺好的 取群組ID') {
                    const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{
                            type: 'text',
                            text: `[系統管理員資訊]\n此來源的 ID 為：\n${sourceId}`
                        }]
                    });
                    continue;
                }
                if (rawUserMessage === '@KINYO挺好的 設定為接單總部') {
                    const adminUid = process.env.ADMIN_LINE_UID; // 郭庭豪的 LINE UID
                    if (lineUid !== adminUid) {
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此設定' }]
                        });
                        continue;
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
                    continue;
                }

                // --- 新增：同步圖庫指令 (限管理員) ---
                if (rawUserMessage === '#同步圖庫' || rawUserMessage === '@KINYO挺好的 同步圖庫') {
                    const adminUid = process.env.ADMIN_LINE_UID;
                    if (lineUid !== adminUid) {
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此指令' }]
                        });
                        continue;
                    }

                    // 回覆並非同步觸發 Cloud Function
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{ type: 'text', text: '✅ 已於背景開始強制同步圖庫。\n此過程可能需要數分鐘，請稍候再查看網頁或機器人。' }]
                    });

                    fetch(`https://asia-east1-kinyo-price.cloudfunctions.net/syncGDrive?token=${process.env.SYNC_TOKEN}`, { signal: AbortSignal.timeout(1000) })
                        .catch(() => {}); // 忽略 timeout 錯誤，讓它在背景執行
                        
                    continue;
                }

                // --- 額外處理：綁定群組相關指令 ---
                if (isGroup) {
                    const botName = '@KINYO挺好的';
                    const isBotTag = rawUserMessage.startsWith(botName);

                    if (isBotTag) {
                        const cleanCommand = rawUserMessage.replace(botName, '').trim();

                        // 處理綁定指令
                        if (cleanCommand.startsWith('#綁定群組')) {
                            const adminUid = process.env.ADMIN_LINE_UID; // 郭庭豪的 LINE UID

                            // 權限攔截防線
                            if (lineUid !== adminUid) {
                                await lineClient.replyMessage({
                                    replyToken: replyToken,
                                    messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此變更' }]
                                });
                                continue;
                            }

                            const targetLevel = parseInt(cleanCommand.replace('#綁定群組', '').trim(), 10);
                            if (!isNaN(targetLevel)) {
                                await db.collection('Groups').doc(groupId).set({ level: targetLevel, isPriceCheckEnabled: false });
                                await lineClient.replyMessage({
                                    replyToken: replyToken,
                                    messages: [{ type: 'text', text: `✅ 本群組已綁定 Level ${targetLevel}。\n⚠️ 查價功能預設為【關閉】，若要正式開放請您輸入「#開放查價」。` }]
                                });
                            }
                            continue;
                        }

                        // 新增：處理開放查詢指令
                        if (cleanCommand.startsWith('#開放查價') || cleanCommand.startsWith('#開放報價')) {
                            const adminUid = process.env.ADMIN_LINE_UID;
                            if (lineUid !== adminUid) {
                                await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此變更' }] });
                                continue;
                            }
                            await db.collection('Groups').doc(groupId).set({ isPriceCheckEnabled: true }, { merge: true });
                            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '✅ 本群組的查詢與報價功能已正式【開放】！\n群組成員現在可以開始使用各項功能了。' }] });
                            continue;
                        }

                        // 新增：處理關閉查詢指令
                        if (cleanCommand.startsWith('#關閉查價') || cleanCommand.startsWith('#關閉報價') || cleanCommand.startsWith('#封鎖查價')) {
                            const adminUid = process.env.ADMIN_LINE_UID;
                            if (lineUid !== adminUid) {
                                await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此變更' }] });
                                continue;
                            }
                            await db.collection('Groups').doc(groupId).set({ isPriceCheckEnabled: false }, { merge: true });
                            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '🚫 本群組的各項功能目前已【封鎖/關閉】。' }] });
                            continue;
                        }

                        // 處理解除綁定指令
                        if (cleanCommand.startsWith('#解除綁定')) {
                            const adminUid = process.env.ADMIN_LINE_UID;

                            if (lineUid !== adminUid) {
                                await lineClient.replyMessage({
                                    replyToken: replyToken,
                                    messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此變更' }]
                                });
                                continue;
                            }

                            await db.collection('Groups').doc(groupId).delete();
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '✅ 本群組已成功解除報價權限綁定。' }]
                            });
                            continue;
                        }
                    }
                }

                // --- 對話式 flow：優先檢查是否有進行中的對話 state ---
                {
                    const { getState } = require('./src/services/conversationState');
                    const reserveFlow = require('./src/workflows/reserveConversation');
                    const orderFlow = require('./src/workflows/orderConversation');
                    const sampleFlow = require('./src/workflows/sampleConversation');
                    const ongoingState = await getState(lineUid);
                    if (ongoingState) {
                        const convInput = userText.replace(/@KINYO挺好的\s*/g, '').trim();
                        const userContext = { level: currentViewLevel, realLevel, userEmail };
                        if (ongoingState.flow === 'order') {
                            await orderFlow.handleConversationInput(ongoingState, convInput, event, lineClient, userContext);
                        } else if (ongoingState.flow === 'borrow_sample') {
                            await sampleFlow.handleConversationInput(ongoingState, convInput, event, lineClient);
                        } else {
                            // 預設、reserve_order 都走 reserve flow
                            await reserveFlow.handleConversationInput(ongoingState, convInput, event, lineClient);
                        }
                        continue;
                    }

                    // 啟動對話式預留訂單
                    if (userText === '預留訂單' || userText === '留貨' || userText === '@KINYO挺好的 預留訂單' || userText === '@KINYO挺好的 留貨') {
                        await reserveFlow.startReserveFlow(lineUid, groupId, replyToken, lineClient);
                        continue;
                    }

                    // 啟動對話式訂單
                    if (userText === '訂單' || userText === '@KINYO挺好的 訂單') {
                        await orderFlow.startOrderFlow(lineUid, groupId, replyToken, lineClient);
                        continue;
                    }

                    // 啟動對話式借樣品
                    if (userText === '借樣品' || userText === '借樣' || userText === '@KINYO挺好的 借樣品' || userText === '@KINYO挺好的 借樣') {
                        await sampleFlow.startSampleFlow(lineUid, groupId, replyToken, lineClient);
                        continue;
                    }
                }

                // --- 新增：靜態收件資訊卡片 ---
                if (userText === '收件資訊' || userText === '寄件地址' || userText === '@KINYO挺好的 收件資訊' || userText === '@KINYO挺好的 寄件地址') {
                    const shippingFlex = {
                        type: 'flex',
                        altText: '收件資訊',
                        contents: {
                            type: 'bubble',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: '#1E3A8A',
                                contents: [{ type: 'text', text: '📦 標準收件資訊', color: '#ffffff', weight: 'bold', size: 'lg' }]
                            },
                            body: {
                                type: 'box', layout: 'vertical', spacing: 'md',
                                contents: [
                                    { type: 'text', text: '請將包裹或樣品寄至以下地址：', size: 'sm', color: '#666666' },
                                    {
                                        type: 'box', layout: 'vertical', margin: 'lg', spacing: 'sm',
                                        contents: [
                                            {
                                                type: 'box', layout: 'baseline', spacing: 'sm',
                                                contents: [
                                                    { type: 'text', text: '地址', color: '#aaaaaa', size: 'sm', flex: 2 },
                                                    { type: 'text', text: '新竹市東區經國路一段187號', wrap: true, color: "#333333", size: "sm", flex: 6 }
                                                ]
                                            },
                                            {
                                                type: 'box', layout: 'baseline', spacing: 'sm',
                                                contents: [
                                                    { type: 'text', text: '收件人', color: '#aaaaaa', size: 'sm', flex: 2 },
                                                    { type: 'text', text: '郭庭豪', wrap: true, color: "#333333", size: "sm", flex: 6 }
                                                ]
                                            },
                                            {
                                                type: 'box', layout: 'baseline', spacing: 'sm',
                                                contents: [
                                                    { type: 'text', text: '市話', color: '#aaaaaa', size: 'sm', flex: 2 },
                                                    { type: 'text', text: '03-5396966 #266', wrap: true, color: "#333333", size: "sm", flex: 6 }
                                                ]
                                            },
                                            {
                                                type: 'box', layout: 'baseline', spacing: 'sm',
                                                contents: [
                                                    { type: 'text', text: '手機', color: '#aaaaaa', size: 'sm', flex: 2 },
                                                    { type: 'text', text: '0976-966333', wrap: true, color: "#333333", size: "sm", flex: 6 }
                                                ]
                                            }
                                        ]
                                    },
                                    { type: 'separator', margin: 'lg' },
                                    { type: 'text', text: '⚠️ 寄件時請務必於外箱或託運單註明：', size: 'xs', color: '#EF4444', margin: 'lg', wrap: true },
                                    { type: 'text', text: '1. 寄件人名稱\n2. 內容物明細', size: 'sm', color: '#333333', wrap: true }
                                ]
                            }
                        }
                    };
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [shippingFlex]
                    });
                    continue;
                }
                // -----------------------------------

                // --- 指令列表 (業務常用指令說明) ---
                if (userText === '指令' || userText === '幫助' || userText === '指令列表' || userText === '@KINYO挺好的 指令' || userText === '@KINYO挺好的 幫助' || userText === '@KINYO挺好的 指令列表') {
                    const commandFlexMessage = {
                        type: 'flex',
                        altText: 'KINYO 機器人指令列表',
                        contents: {
                            type: 'bubble',
                            size: 'giga',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: '#ea580c', paddingAll: '16px',
                                contents: [
                                    { type: 'text', text: '🤖 KINYO 挺好的 指令列表', color: '#ffffff', weight: 'bold', size: 'lg' },
                                    { type: 'text', text: '群組內使用請加 @KINYO挺好的', color: '#ffe5cc', size: 'xs', margin: 'sm' }
                                ]
                            },
                            body: {
                                type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '16px',
                                contents: [
                                    { type: 'text', text: '📦 訂單與申請', weight: 'bold', size: 'sm', color: '#ea580c' },
                                    {
                                        type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm',
                                        contents: [
                                            { type: 'text', text: '• 訂單 — 一般下單模板', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 預留訂單 / 留貨 — 佔位先留貨 (期限前 7 天自動提醒)', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 借樣品 / 借樣 — 借樣品申請', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 新品不良 / 來回件 — 不良品派車', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 廠價申請 — 廠價申請表單', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 行動屋出貨 — 批次出貨 (最多 10 筆)', size: 'sm', color: '#333333', wrap: true }
                                        ]
                                    },
                                    { type: 'separator', margin: 'md' },
                                    { type: 'text', text: '🔍 查詢', weight: 'bold', size: 'sm', color: '#ea580c', margin: 'md' },
                                    {
                                        type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm',
                                        contents: [
                                            { type: 'text', text: '• 直接輸入型號 — 查單一商品 (例：KPB-2990)', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 關鍵字 + 預算 — 進階查價 (例：吹風機 預算500-700)', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 查詢訂單 — 看本群組近 5 筆訂單', size: 'sm', color: '#333333', wrap: true }
                                        ]
                                    },
                                    { type: 'separator', margin: 'md' },
                                    { type: 'text', text: '📍 其他', weight: 'bold', size: 'sm', color: '#ea580c', margin: 'md' },
                                    {
                                        type: 'box', layout: 'vertical', spacing: 'xs', margin: 'sm',
                                        contents: [
                                            { type: 'text', text: '• 收件資訊 / 寄件地址 — 顯示公司收件地址', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 維修 / 客服 — 維修客服資訊', size: 'sm', color: '#333333', wrap: true },
                                            { type: 'text', text: '• 操作指南 / 使用教學 — 使用說明 FAQ', size: 'sm', color: '#333333', wrap: true }
                                        ]
                                    }
                                ]
                            },
                            footer: {
                                type: 'box', layout: 'vertical', paddingAll: '12px',
                                contents: [
                                    { type: 'text', text: '💡 輸入對應關鍵字即可取得完整模板', size: 'xs', color: '#888888', align: 'center', wrap: true }
                                ]
                            }
                        }
                    };

                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [commandFlexMessage]
                    });
                    continue;
                }

                // --- 訂單狀況追蹤 (摘要 / 待處理 / 已處理) ---
                if (['訂單狀況', '工作進度', '待處理', '已處理',
                    '@KINYO挺好的 訂單狀況', '@KINYO挺好的 工作進度',
                    '@KINYO挺好的 待處理', '@KINYO挺好的 已處理'].includes(userText)) {
                    const PENDING_STATUSES = ['處理中', '處理中_借樣品', '處理中_來回件', '處理中_批次'];
                    const PROCESSED_STATUSES = ['已出貨', '處理中_已發送異常通知', '處理完成_已派車'];

                    // helper: 解析 createdAt (Firestore Timestamp / serialized)
                    const toDate = (ts) => {
                        if (!ts) return null;
                        if (typeof ts.toDate === 'function') return ts.toDate();
                        if (ts._seconds) return new Date(ts._seconds * 1000);
                        if (typeof ts === 'string') return new Date(ts);
                        return null;
                    };

                    // helper: 判斷訂單類型
                    const getType = (orderId) => {
                        if (orderId.startsWith('SMP')) return '借樣品';
                        if (orderId.startsWith('RMA')) return '派車單';
                        if (orderId.startsWith('BCH')) return '行動屋';
                        return '訂單';
                    };

                    // helper: 組 Flex bubble
                    const buildBubble = (orderId, data, mode) => {
                        const type = getType(orderId);
                        const cCode = data.customer?.customerCode || '';
                        const cName = data.customer?.company || data.customer?.name || '未提供';
                        const amount = data.totalAmount;
                        const created = toDate(data.createdAt);
                        const ageDays = created ? Math.floor((Date.now() - created.getTime()) / 86400000) : 0;
                        const dateStr = created ? `${created.getMonth() + 1}/${created.getDate()}` : '?';

                        let headerColor = '#0055aa';
                        let ageText = null;
                        if (mode === 'pending') {
                            if (ageDays >= 2) { headerColor = '#E11D48'; ageText = `🔴 超時 ${ageDays} 天`; }
                            else if (ageDays >= 1) { headerColor = '#F59E0B'; ageText = `🟡 ${ageDays} 天未處理`; }
                            else { ageText = '🟢 今日'; }
                        } else {
                            headerColor = '#1DB446';
                        }

                        const bodyContents = [
                            { type: 'text', text: `${orderId.substring(0, 16)}`, size: 'xs', color: '#888888' },
                            { type: 'text', text: `${cCode ? '【' + cCode + '】' : ''}${cName}`, weight: 'bold', size: 'sm', wrap: true }
                        ];
                        if (amount) bodyContents.push({ type: 'text', text: `💰 $${amount}`, size: 'sm', color: '#E11D48' });
                        bodyContents.push({ type: 'text', text: `📅 建立：${dateStr}`, size: 'xs', color: '#666666' });
                        if (mode === 'processed') {
                            bodyContents.push({ type: 'text', text: `✓ ${data.status || ''}`, size: 'xs', color: '#1DB446', wrap: true });
                            if (data.tracking) bodyContents.push({ type: 'text', text: `📋 ${data.tracking}`, size: 'xs', wrap: true });
                            if (data.customer?.logistics) bodyContents.push({ type: 'text', text: `🚚 ${data.customer.logistics}`, size: 'xs', color: '#666666' });
                        } else {
                            bodyContents.push({ type: 'text', text: `⏳ ${data.status || '處理中'}`, size: 'xs', color: '#666666', wrap: true });
                            if (data.customer?.logistics) bodyContents.push({ type: 'text', text: `🚚 ${data.customer.logistics}`, size: 'xs', color: '#666666' });
                        }
                        if (ageText) bodyContents.push({ type: 'text', text: ageText, size: 'sm', weight: 'bold', color: headerColor, margin: 'sm' });

                        const bubble = {
                            type: 'bubble', size: 'kilo',
                            header: {
                                type: 'box', layout: 'vertical', backgroundColor: headerColor, paddingAll: '12px',
                                contents: [{ type: 'text', text: `📝 ${type}`, color: '#ffffff', weight: 'bold', size: 'sm' }]
                            },
                            body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: bodyContents }
                        };

                        if (mode === 'pending') {
                            const isRma = orderId.startsWith('RMA');
                            const shipUrl = isRma
                                ? `https://asia-east1-kinyo-price.cloudfunctions.net/markRMACompleted?rmaId=${orderId}`
                                : `https://asia-east1-kinyo-price.cloudfunctions.net/markOrderShipped?orderId=${orderId}`;
                            bubble.footer = {
                                type: 'box', layout: 'vertical', spacing: 'xs',
                                contents: [
                                    {
                                        type: 'button', style: 'primary', color: '#28a745', height: 'sm',
                                        action: { type: 'uri', label: isRma ? '✅ 派車完成' : '✅ 出貨/填單號', uri: shipUrl }
                                    },
                                    {
                                        type: 'button', style: 'secondary', height: 'sm',
                                        action: { type: 'uri', label: '⚠️ 通知異常', uri: `https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${orderId}` }
                                    }
                                ]
                            };
                        }
                        return bubble;
                    };

                    // 指令：訂單狀況 / 工作進度 → 摘要
                    if (userText.includes('訂單狀況') || userText.includes('工作進度')) {
                        const [pendSnap, procSnap] = await Promise.all([
                            db.collection('PendingOrders').where('status', 'in', PENDING_STATUSES).get(),
                            db.collection('PendingOrders').where('status', 'in', PROCESSED_STATUSES).get(),
                        ]);
                        const pendByType = { '訂單': 0, '借樣品': 0, '派車單': 0, '行動屋': 0 };
                        let overdueCount = 0;
                        pendSnap.docs.forEach(d => {
                            pendByType[getType(d.id)] = (pendByType[getType(d.id)] || 0) + 1;
                            const created = toDate(d.data().createdAt);
                            if (created && (Date.now() - created.getTime()) / 86400000 >= 2) overdueCount++;
                        });
                        const sevenDaysAgo = Date.now() - 7 * 86400000;
                        const procLast7 = procSnap.docs.filter(d => {
                            const created = toDate(d.data().createdAt);
                            return created && created.getTime() >= sevenDaysAgo;
                        }).length;

                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{
                                type: 'flex',
                                altText: '訂單狀況摘要',
                                contents: {
                                    type: 'bubble',
                                    header: {
                                        type: 'box', layout: 'vertical', backgroundColor: '#333333', paddingAll: '16px',
                                        contents: [{ type: 'text', text: '📊 訂單狀況摘要', color: '#ffffff', weight: 'bold', size: 'lg' }]
                                    },
                                    body: {
                                        type: 'box', layout: 'vertical', spacing: 'md',
                                        contents: [
                                            { type: 'text', text: '📋 待處理', weight: 'bold', size: 'md', color: '#E11D48' },
                                            { type: 'text', text: `總計 ${pendSnap.size} 筆 (${overdueCount} 筆超時)`, size: 'sm', color: overdueCount > 0 ? '#E11D48' : '#666666' },
                                            { type: 'text', text: `• 訂單 ${pendByType['訂單']} / 借樣 ${pendByType['借樣品']} / 派車 ${pendByType['派車單']} / 行動屋 ${pendByType['行動屋']}`, size: 'xs', color: '#666666' },
                                            { type: 'separator', margin: 'md' },
                                            { type: 'text', text: '✅ 已處理 (近 7 天)', weight: 'bold', size: 'md', color: '#1DB446', margin: 'md' },
                                            { type: 'text', text: `${procLast7} 筆`, size: 'sm', color: '#666666' },
                                            { type: 'separator', margin: 'md' },
                                            { type: 'text', text: '💡 輸入「待處理」或「已處理」可看詳細清單', size: 'xs', color: '#888888', margin: 'md', wrap: true }
                                        ]
                                    }
                                }
                            }]
                        });
                        continue;
                    }

                    // 指令：待處理
                    if (userText.includes('待處理')) {
                        const snap = await db.collection('PendingOrders').where('status', 'in', PENDING_STATUSES).get();
                        if (snap.empty) {
                            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '✅ 目前沒有待處理訂單' }] });
                            continue;
                        }
                        const sorted = snap.docs.sort((a, b) => {
                            const aT = toDate(a.data().createdAt)?.getTime() || 0;
                            const bT = toDate(b.data().createdAt)?.getTime() || 0;
                            return aT - bT; // 舊的在前 (最需要處理)
                        }).slice(0, 10);
                        const bubbles = sorted.map(d => buildBubble(d.id, d.data(), 'pending'));
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [
                                { type: 'text', text: `📋 待處理 ${snap.size} 筆${snap.size > 10 ? '（顯示最舊 10 筆）' : ''}` },
                                { type: 'flex', altText: `待處理 ${snap.size} 筆`, contents: { type: 'carousel', contents: bubbles } }
                            ]
                        });
                        continue;
                    }

                    // 指令：已處理
                    if (userText.includes('已處理')) {
                        const snap = await db.collection('PendingOrders').where('status', 'in', PROCESSED_STATUSES).get();
                        if (snap.empty) {
                            await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '目前沒有已處理訂單' }] });
                            continue;
                        }
                        const sorted = snap.docs.sort((a, b) => {
                            const aT = toDate(a.data().createdAt)?.getTime() || 0;
                            const bT = toDate(b.data().createdAt)?.getTime() || 0;
                            return bT - aT; // 新的在前
                        }).slice(0, 10);
                        const bubbles = sorted.map(d => buildBubble(d.id, d.data(), 'processed'));
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [
                                { type: 'text', text: `✅ 已處理 ${snap.size} 筆${snap.size > 10 ? '（顯示最新 10 筆）' : ''}` },
                                { type: 'flex', altText: `已處理 ${snap.size} 筆`, contents: { type: 'carousel', contents: bubbles } }
                            ]
                        });
                        continue;
                    }
                }

                // --- 額外處理：訂單模板回覆 ---
                if (userText === '訂單' || userText === '@KINYO挺好的 訂單') {
                    const orderTemplate = `@KINYO挺好的 下單\n\n採購公司：\n收件人：\n聯絡電話：\n送貨地址：\n預期到貨：\n備註：\n=================\n【訂購明細】請依下方格式填寫：\n型號： / 數量： / 單價：  (單價沒有可空白)\n型號： / 數量： / 單價：`;

                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{
                            type: 'text',
                            text: `請複製以下模板填寫並送出：\n\n${orderTemplate}`
                        }]
                    });
                    continue; // 回傳後即結束本次請求處理
                }

                // --- 查詢訂單關鍵字攔截 ---
                if (userText === '查詢訂單' || userText === '@KINYO挺好的 查詢訂單') {
                    // 1. 從 Firestore 撈取該群組最近 5 筆訂單
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
                        continue;
                    }

                    // 2. 組合 Flex Carousel 輪播卡片
                    const bubbles = ordersSnapshot.docs.map(doc => {
                        const data = doc.data();
                        const orderId = doc.id;
                        const statusColor = data.status === '已出貨' ? '#1DB446' : '#F59E0B';
                        const dateStr = data.createdAt ? new Date(data.createdAt._seconds * 1000).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '未知時間';

                        return {
                            type: 'bubble',
                            size: 'micro', // 使用微型卡片以便在手機上橫向滑動
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
                    continue;
                }

                // --- 階段二：後端實作 LIFF 綁定成功後續與 RBAC 權限回覆 ---
                if (userText === '#帳號綁定完成') {
                    shouldSkipSearch = true; // 阻擋原本商品查詢流程
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
                            continue;
                        }

                        // 取得權限
                        const userData = userSnapshot.docs[0].data();
                        const realLevel = parseInt(userData.level) || 0;
                        const isVip = !!userData.vipColumn;
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
                    continue; // 處理完直接結束此 iteration
                }
            } else if (event.type === 'postback') {
                // 強制寫入 Firebase 雲端日誌以供稽核
                console.log(`[Postback 執行] 來源群組: ${groupId || '無'}, 點擊者: ${lineUid}, 繼承等級: ${currentViewLevel}`);

                // 若頂層變數遺失的防呆攔截
                if (!currentViewLevel) {
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{ type: 'text', text: '⛔ 系統錯誤：無法取得全域報價等級。' }]
                    });
                    continue; // 結束本回合
                }

                const postbackData = event.postback.data;
                const params = new URLSearchParams(postbackData);
                const action = params.get('action');

                if (action === 'export_ppt') {
                    const pptModel = params.get('model') || '';
                    let pptQty = parseInt(params.get('qty'));
                    pptQty = (isNaN(pptQty) || pptQty <= 0) ? 50 : pptQty;
                    const pptIntentParams = {
                        intent: 'query', action: 'export_ppt', keyword: pptModel, target_qty: pptQty, min_budget: null, max_budget: null
                    };
                    const userContext = { level: currentViewLevel, userEmail, realLevel };
                    const { processPptExport } = require('./src/services/pptGenerator');
                    await processPptExport(pptIntentParams, userContext, event, lineClient);
                    continue;
                } else if (action === 'show_level_menu') {
                    shouldSkipSearch = true;
                    userText = "切換選單顯示";
                } else if (action === 'set_level') {
                    shouldSkipSearch = true;
                    simulatedLevel = parseInt(params.get('value'), 10);
                    userText = "設定權限等級";
                } else if (action === 'get_text_quote') {
                    shouldSkipSearch = true;
                    userText = "產生單一文字報價";
                } else if (action === 'modify_order') {
                    shouldSkipSearch = true;
                    const orderId = params.get('orderId');
                    try {
                        const orderDoc = await db.collection('PendingOrders').doc(orderId).get();
                        if (!orderDoc.exists) throw new Error('找不到該訂單，可能已處理過。');
                        const orderData = orderDoc.data();
                        const customerCode = orderData.customer?.customerCode;
                        if (!customerCode) throw new Error('此訂單缺少客戶編號，無法修改，請取消後重新下單。');

                        const custDoc = await db.collection('Customers').doc(customerCode).get();
                        if (!custDoc.exists) throw new Error(`找不到客戶 ${customerCode}`);
                        const custData = custDoc.data();

                        // 重建對話 state (保留 customer，重新走後續流程)
                        const { setState } = require('./src/services/conversationState');
                        await setState(lineUid, {
                            flow: 'order',
                            step: 'waiting_shipping_choice',
                            data: {
                                items: [],
                                customer: {
                                    code: custData.code || customerCode,
                                    shortName: custData.shortName || '',
                                    fullName: custData.fullName || '',
                                    phone: custData.phone || '',
                                    address: custData.address || '',
                                    taxId: custData.taxId || '',
                                },
                            },
                            groupId: event.source.groupId || null,
                            startedAt: new Date().toISOString(),
                        });

                        // 刪除這張舊的 PendingOrders
                        await db.collection('PendingOrders').doc(orderId).delete();

                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{
                                type: 'text',
                                text: `🔧 已進入修改模式 (客戶保留)\n━━━━━━━━━\n【${custData.code}】${custData.shortName}\n${custData.fullName}\n📞 ${custData.phone || '未提供'}\n📍 ${custData.address || '未提供'}\n━━━━━━━━━\n\n請選擇收件方式：`,
                                quickReply: {
                                    items: [
                                        { type: 'action', action: { type: 'message', label: '🏢 寄到公司 (預設)', text: '寄到公司' } },
                                        { type: 'action', action: { type: 'message', label: '✍️ 指定收件資料', text: '指定收件資料' } },
                                        { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } }
                                    ]
                                }
                            }]
                        });
                    } catch (err) {
                        console.error('[modify_order] 失敗:', err);
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 修改失敗：${err.message}` }]
                        });
                    }
                    continue;
                } else if (action === 'confirm_order' || action === 'cancel_order') {
                    shouldSkipSearch = true;
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

                                // --- 歷史價記錄：把使用者輸入的單價寫入 Customers/{code}/Pricing/{model} ---
                                // 只記錄「使用者自己打的價」，不記錄系統自動計算 (autoPriced=true)
                                try {
                                    const custCode = orderData.customer?.customerCode;
                                    if (custCode && Array.isArray(orderData.items)) {
                                        const todayStr = new Date().toISOString().substring(0, 10);
                                        const batch = db.batch();
                                        let recorded = 0;
                                        for (const item of orderData.items) {
                                            if (item.autoPriced) continue;           // 系統自動算 → 不記錄
                                            const price = Number(item.unitPrice);
                                            if (!price || price <= 0) continue;       // 沒價 or 待確認 → 跳過
                                            const model = item.model;
                                            if (!model) continue;
                                            const docId = String(model).replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
                                            if (!docId) continue;
                                            const ref = db.collection('Customers').doc(custCode).collection('Pricing').doc(docId);
                                            batch.set(ref, {
                                                model,
                                                unitPrice: price,
                                                source: 'order_history',
                                                lastOrderDate: todayStr,
                                                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                                            }, { merge: true });
                                            recorded++;
                                        }
                                        if (recorded > 0) {
                                            await batch.commit();
                                            console.log(`[歷史價記錄] 訂單 ${orderId} 寫入 ${recorded} 筆至 Customers/${custCode}/Pricing`);
                                        }
                                    }
                                } catch (histErr) {
                                    console.error('[歷史價記錄] 失敗:', histErr);
                                }

                                // 解析商品陣列並生成 HTML 表格
                                let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
                                itemsHtml += '<tr style="background-color: #f2f2f2;"><th>商品型號</th><th>數量</th><th>單價</th><th>小計</th></tr>';

                                if (orderData.items && Array.isArray(orderData.items)) {
                                    orderData.items.forEach(item => {
                                        // 1. 多重鍵值捕捉：窮舉 LLM 可能生成的變數名稱
                                        const model = item.model || item.name || item.product || '未知型號';
                                        const qty = item.quantity || item.qty || item.count || item.amount || 1;
                                        let subtotal = item.subtotal || item.total || item.totalPrice || 0;
                                        let price = item.price || item.unitPrice || 0;

                                        // 2. 數據反推防呆機制
                                        // 如果有單價和數量，但沒小計，自動算出小計
                                        if (subtotal === 0 && price > 0 && qty > 0) {
                                            subtotal = price * qty;
                                        }
                                        // 如果有小計和數量，但沒單價 (如本次 Bug)，自動反推單價
                                        if (price === 0 && subtotal > 0 && qty > 0) {
                                            price = Math.round(subtotal / qty);
                                        }

                                        // 顯示邏輯：0 轉換為待確認
                                        const priceDisplay = price > 0 ? `$${price}` : '<span style="color:red;">待確認</span>';
                                        const subtotalDisplay = subtotal > 0 ? `$${subtotal}` : '<span style="color:red;">待確認</span>';

                                        itemsHtml += `<tr><td>${model}</td><td align="center">${qty}</td><td align="right">${priceDisplay}</td><td align="right">${subtotalDisplay}</td></tr>`;
                                    });
                                }

                                // 若有運費則獨立顯示一列
                                if (orderData.shippingFee) {
                                    itemsHtml += `<tr><td colspan="3" align="right">運費</td><td align="right">$${orderData.shippingFee}</td></tr>`;
                                }
                                itemsHtml += '</table>';

                                const totalDisplay = orderData.totalAmount > 0 ? `$${orderData.totalAmount}` : '<span style="color:red;">待確認 (依實際出貨單為準)</span>';

                                const mailOptions = {
                                    from: 'KINYO 報價系統 <sam.kuo@kinyo.tw>',
                                    to: process.env.ORDER_NOTIFY_EMAILS ? process.env.ORDER_NOTIFY_EMAILS.split(',') : ['sam.kuo@kinyo.tw', 'din@kinyo.tw'],
                                    subject: `[新訂單通知]${orderData.customer?.customerCode ? `[${orderData.customer.customerCode}]` : ''} ${orderData.customer?.company || ''}${orderData.customer?.name && orderData.customer.name !== orderData.customer.company ? ' ' + orderData.customer.name : ''} - 總計 ${totalDisplay.replace(/<[^>]+>/g, '')}`,
                                    html: `
                                      <h2 style="color: #333;">新訂單通知</h2>
                                      <p><strong>訂單編號:</strong> ${orderId}</p>
                                      <p><strong>客戶編號:</strong> ${orderData.customer?.customerCode || '未建檔'}</p>
                                      <p><strong>採購公司:</strong> ${orderData.customer?.company || '未提供'}</p>
                                      <p><strong>收件人:</strong> ${orderData.customer?.name}</p>
                                      <p><strong>電話:</strong> ${orderData.customer?.phone}</p>
                                      <p><strong>地址:</strong> ${orderData.customer?.address || '未提供'}</p>
                                      <p><strong>物流方式:</strong> ${orderData.customer?.logistics || '未指定'}</p>
                                      <p><strong>預期到貨:</strong> ${orderData.customer?.deliveryTime || '未指定'}</p>
                                      <p><strong>備註:</strong> <span style="color: #E11D48;">${orderData.customer?.remark || '無'}</span></p>
                                      <hr>
                                      <h3 style="color: #333;">🛒 訂購商品明細：</h3>
                                      ${itemsHtml}
                                      <h3 style="color: #E11D48;">總計金額: ${totalDisplay}</h3>
                                      <hr>
                                      <br>
                                      <a href="${functionUrl}" style="display:inline-block; padding:14px 28px; color:white; background-color:#28a745; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; margin-right: 10px;">✅ 出貨並填物流單號</a>
                                      <a href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${orderId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#F59E0B; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">⚠️ 訂單異常 / 通知客戶</a>
                                    `
                                };
                                // 非同步寄信，不阻塞 Transaction
                                transporter.sendMail(mailOptions).catch(err => console.error("SMTP 發信失敗:", err));

                                // ---------------------------------
                                // --- 修改：大單備貨通知邏輯 ---
                                // 1. 篩選出數量嚴格大於 300 的商品
                                const largeQuantityItems = (orderData.items || []).filter(item => (item.quantity || item.qty || 0) > 300);

                                // 2. 若存在大單商品，觸發採購與商開通知信
                                if (largeQuantityItems.length > 0) {
                                  let restockItemsHtml = '';
                                  largeQuantityItems.forEach(item => {
                                    restockItemsHtml += `<tr><td style="padding: 8px; border: 1px solid #ddd;">${item.model}</td><td style="padding: 8px; border: 1px solid #ddd; color: #E11D48; font-weight: bold;">${item.qty || item.quantity || 0}</td></tr>`;
                                  });

                                  const restockEmailHtml = `
                                    <h2 style="color: #E11D48;">⚠️ 大單出貨與備貨警示</h2>
                                    <p>系統偵測到以下商品單筆出貨量大於 300，請評估是否需要提前備貨：</p>
                                    <table style="border-collapse: collapse; width: 100%; max-width: 500px;">
                                      <tr style="background-color: #f3f4f6;"><th style="padding: 8px; border: 1px solid #ddd; text-align: left;">型號</th><th style="padding: 8px; border: 1px solid #ddd; text-align: left;">出貨數量</th></tr>
                                      ${restockItemsHtml}
                                    </table>
                                    <hr>
                                    <p><strong>關聯訂單資訊：</strong></p>
                                    <ul>
                                      <li>客戶名稱：${orderData.customer?.company || orderData.customer?.name || '未提供'}</li>
                                      <li>負責業務：郭庭豪</li>
                                    </ul>
                                    <p style="color: #666; font-size: 12px;">[系統提示] 此為系統自動偵測觸發之備貨警示信。</p>
                                  `;

                                  const restockMailOptions = {
                                    from: '系統通知信箱 <sam.kuo@kinyo.tw>',
                                    to: process.env.RESTOCK_NOTIFY_EMAILS || 'crystal.lin@nakay.com.tw, iris@nakay.com.tw, irene.tien@nakay.com.tw, chloe@nakay.com.tw, kelly@nakay.com.tw, sam.kuo@kinyo.tw',
                                    subject: '【大單備貨警示】型號庫存消耗通知',
                                    html: restockEmailHtml
                                  };

                                  transporter.sendMail(restockMailOptions).catch(err => console.error("⚠️ 大單備貨通知發送失敗:", err));
                                }
                                // ---------------------------------

                                try {
                                    const configDoc = await admin.firestore().collection('SystemConfig').doc('OrderSettings').get();
                                    if (configDoc.exists && configDoc.data().notifyGroupId) {
                                        const targetGroupId = configDoc.data().notifyGroupId;
                                        const companyName = orderData.customer?.company || '未提供';
                                        const amount = orderData.totalAmount;
                                        const deliveryTime = orderData.customer?.deliveryTime || '未指定';

                                        const customerCode = orderData.customer?.customerCode || '未建檔';
                                        const notifyText = `⚠️ 新訂單通知\n編號：${orderId.substring(0, 8)}\n客戶編號：${customerCode}\n採購公司：${companyName}\n預期到貨：${deliveryTime}\n總金額：$${amount}\n\n請盡速查看 Email 處理出貨作業。`;

                                        await lineClient.pushMessage({
                                            to: targetGroupId,
                                            messages: [{ type: 'text', text: notifyText }]
                                        });
                                    }
                                } catch (pushError) {
                                    // 僅記錄錯誤，絕對不可阻斷主流程或拋出異常給前端
                                    console.error('[系統警告] 推播至接單總部失敗:', pushError);
                                }
                                // ------------------------------------
                            }
                        });

                        const replyMsg = finalStatus === '處理中'
                            ? '✅ 訂單已成功送出！我們將盡快為您處理。'
                            : '❌ 訂單已取消。';

                        console.log(`[訂單狀態更新] ${orderId} -> ${finalStatus}`);
                        return lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: replyMsg }]
                        });
                    } catch (err) {
                        console.error('[訂單處理錯誤]', err);
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 處理失敗: ${err.message}` }]
                        });
                    }
                } else if (action === 'cancel_temp_order') {
                    shouldSkipSearch = true;
                    const tempOrderId = params.get('id');
                    try {
                        const tempDocRef = db.collection('tempOrders').doc(tempOrderId);
                        const tempDoc = await tempDocRef.get();
                        if (!tempDoc.exists) {
                            return lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '這筆申請先前已經處理過或是已取消囉！' }]
                            });
                        }
                        await tempDocRef.delete();
                        console.log(`[取消暫存] 成功刪除紀錄 ${tempOrderId}`);
                        return lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '✅ 申請/暫存單已成功取消。' }]
                        });
                    } catch (err) {
                        console.error('[取消暫存錯誤]', err);
                        return lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 取消失敗: ${err.message}` }]
                        });
                    }
                } else if (action === 'confirm_sample') {
                    shouldSkipSearch = true;
                    const orderId = params.get('id');
                    try {
                        const tempDocRef = db.collection('tempOrders').doc(orderId);
                        const tempDoc = await tempDocRef.get();

                        if (!tempDoc.exists) {
                            throw new Error('找不到該申請紀錄，可能已處理過或失效。');
                        }
                        const orderData = tempDoc.data();

                        // 轉移至 PendingOrders 且標記為處理中
                        const newOrderId = `SMP${Date.now()}`;
                        orderData.orderId = newOrderId;
                        orderData.status = '處理中_借樣品';
                        orderData.createdAt = admin.firestore.FieldValue.serverTimestamp();
                        orderData.userId = lineUid;
                        orderData.userEmail = userEmail;
                        orderData.sourceId = event.source.groupId || event.source.userId;

                        // 寫入正式 Collection，刪除暫存
                        await db.collection('PendingOrders').doc(newOrderId).set(orderData);
                        await tempDocRef.delete();

                        // ===== SMTP 通知 =====
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

                        // 生成後台結案按鈕 (暫時沿用現有 markOrderShipped 但需調整裡面判斷)
                        const functionUrl = `https://asia-east1-kinyo-price.cloudfunctions.net/markOrderShipped?orderId=${newOrderId}`;

                        const mailOptions = {
                            from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                            to: process.env.ORDER_NOTIFY_EMAILS ? process.env.ORDER_NOTIFY_EMAILS.split(',') : ['sam.kuo@kinyo.tw', 'din@kinyo.tw'],
                            subject: `[借樣品通知]${orderData.customer?.customerCode ? `[${orderData.customer.customerCode}]` : ''} ${orderData.customer?.company || ''}${orderData.customer?.name && orderData.customer.name !== orderData.customer.company ? ' ' + orderData.customer.name : ''} - 共 ${totalQty} 件`,
                            html: `
                              <h2 style="color: #F59E0B;">📦 借樣品申請通知</h2>
                              <p><strong>申請編號:</strong> ${newOrderId}</p>
                              <p><strong>客戶編號:</strong> ${orderData.customer?.customerCode || '未建檔'}</p>
                              ${orderData.customer?.projectName ? `<p><strong>案名:</strong> <span style="color: #E11D48;">${orderData.customer.projectName}</span></p>` : ''}
                              <p><strong>預計歸還:</strong> <span style="color: #E11D48;">${orderData.customer?.returnDate || '無'}</span></p>
                              <p><strong>物流方式:</strong> ${orderData.customer?.logistics || '未指定'}</p>
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
                              <a href="${functionUrl}" style="display:inline-block; padding:14px 28px; color:white; background-color:#28a745; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; margin-right: 10px;">✅ 出貨並填物流單號/結案</a>
                              <a href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${newOrderId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#F59E0B; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">⚠️ 訂單異常 / 通知客戶</a>
                            `
                        };
                        transporter.sendMail(mailOptions).catch(err => console.error("借樣品 SMTP 發信失敗:", err));

                        // 4. 發送 LINE 總部推播
                        const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
                        if (configDoc.exists && configDoc.data().notifyGroupId) {
                            const targetGroupId = configDoc.data().notifyGroupId;
                            const companyName = orderData.customer?.company || '未提供';
                            const projectName = orderData.customer?.projectName || '未提供';

                            const customerCode = orderData.customer?.customerCode || '未建檔';
                            const notifyText = `📦 [借樣品通知]\n編號：${newOrderId.substring(0, 8)}\n客戶編號：${customerCode}\n公司：${companyName}\n案名：${projectName}\n項目：共 ${totalQty} 件\n\n請盡速查看 Email 處理樣品寄送作業。`;
                            await lineClient.pushMessage({
                                to: targetGroupId,
                                messages: [{ type: 'text', text: notifyText }]
                            });
                        }


                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '✅ 借樣品申請已成功送出！' }]
                        });
                        console.log(`[借樣品狀態更新] 成功建立 ${newOrderId}`);
                    } catch (err) {
                        console.error('[借樣品處理錯誤]', err);
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 申請失敗: ${err.message}` }]
                        });
                    }
                } else if (action === 'modify_sample') {
                    shouldSkipSearch = true;
                    const tempId = params.get('id');
                    try {
                        const tempDocRef = db.collection('tempOrders').doc(tempId);
                        const tempDoc = await tempDocRef.get();
                        if (!tempDoc.exists) throw new Error('找不到該借樣紀錄，可能已處理過。');
                        const sampleData = tempDoc.data();
                        const customerCode = sampleData.customer?.customerCode;
                        if (!customerCode) throw new Error('此借樣單缺少客戶編號，無法修改。');

                        const custDoc = await db.collection('Customers').doc(customerCode).get();
                        if (!custDoc.exists) throw new Error(`找不到客戶 ${customerCode}`);
                        const custData = custDoc.data();

                        const { setState } = require('./src/services/conversationState');
                        await setState(lineUid, {
                            flow: 'borrow_sample',
                            step: 'waiting_shipping_choice',
                            data: {
                                items: [],
                                customer: {
                                    code: custData.code || customerCode,
                                    shortName: custData.shortName || '',
                                    fullName: custData.fullName || '',
                                    phone: custData.phone || '',
                                    address: custData.address || '',
                                    taxId: custData.taxId || '',
                                },
                            },
                            groupId: event.source.groupId || null,
                            startedAt: new Date().toISOString(),
                        });

                        await tempDocRef.delete();

                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{
                                type: 'text',
                                text: `🔧 已進入修改模式 (客戶保留)\n━━━━━━━━━\n【${custData.code}】${custData.shortName}\n${custData.fullName}\n━━━━━━━━━\n\n請選擇收件方式：`,
                                quickReply: {
                                    items: [
                                        { type: 'action', action: { type: 'message', label: '🏢 寄到公司 (預設)', text: '寄到公司' } },
                                        { type: 'action', action: { type: 'message', label: '✍️ 指定收件資料', text: '指定收件資料' } },
                                        { type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } }
                                    ]
                                }
                            }]
                        });
                    } catch (err) {
                        console.error('[modify_sample] 失敗:', err);
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 修改失敗：${err.message}` }]
                        });
                    }
                    continue;
                } else if (action === 'modify_reserve') {
                    shouldSkipSearch = true;
                    const tempId = params.get('id');
                    try {
                        const tempDocRef = db.collection('tempOrders').doc(tempId);
                        const tempDoc = await tempDocRef.get();
                        if (!tempDoc.exists) throw new Error('找不到該預留紀錄，可能已處理過。');
                        const reserveData = tempDoc.data();
                        const customerCode = reserveData.customer?.customerCode;
                        if (!customerCode) throw new Error('此預留單缺少客戶編號，無法修改。');

                        const custDoc = await db.collection('Customers').doc(customerCode).get();
                        if (!custDoc.exists) throw new Error(`找不到客戶 ${customerCode}`);
                        const custData = custDoc.data();

                        const { setState } = require('./src/services/conversationState');
                        await setState(lineUid, {
                            flow: 'reserve_order',
                            step: 'waiting_deadline',
                            data: {
                                items: [],
                                customer: {
                                    code: custData.code || customerCode,
                                    shortName: custData.shortName || '',
                                    fullName: custData.fullName || '',
                                    phone: custData.phone || '',
                                    address: custData.address || '',
                                    taxId: custData.taxId || '',
                                },
                            },
                            groupId: event.source.groupId || null,
                            startedAt: new Date().toISOString(),
                        });

                        await tempDocRef.delete();

                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{
                                type: 'text',
                                text: `🔧 已進入修改模式 (客戶保留)\n━━━━━━━━━\n【${custData.code}】${custData.shortName}\n${custData.fullName}\n━━━━━━━━━\n\n請輸入預留期限\n(例：2026/05/31 或 2026-05-31)`,
                                quickReply: {
                                    items: [{ type: 'action', action: { type: 'message', label: '❌ 取消', text: '取消' } }]
                                }
                            }]
                        });
                    } catch (err) {
                        console.error('[modify_reserve] 失敗:', err);
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 修改失敗：${err.message}` }]
                        });
                    }
                    continue;
                } else if (action === 'confirm_reserve') {
                    shouldSkipSearch = true;
                    const orderId = params.get('id');
                    try {
                        const tempDocRef = db.collection('tempOrders').doc(orderId);
                        const tempDoc = await tempDocRef.get();

                        if (!tempDoc.exists) throw new Error('找不到該預留紀錄，可能已處理過或失效。');
                        const reserveData = tempDoc.data();

                        const newReserveId = `RSV${Date.now()}`;
                        const reserveDeadline = reserveData.customer?.reserveDeadline || null;

                        let totalAmount = 0;
                        let totalQty = 0;
                        if (reserveData.orderItems && Array.isArray(reserveData.orderItems)) {
                            reserveData.orderItems.forEach(item => {
                                const price = Number(item.unitPrice) || 0;
                                const qty = Number(item.qty) || 1;
                                totalAmount += price * qty;
                                totalQty += qty;
                            });
                        }

                        await db.collection('ReservedOrders').doc(newReserveId).set({
                            ...reserveData,
                            reserveId: newReserveId,
                            reserveDeadline,
                            totalAmount,
                            status: 'active',
                            reminderSent: false,
                            createdAt: admin.firestore.FieldValue.serverTimestamp(),
                            userId: lineUid,
                            userEmail,
                            sourceId: event.source.groupId || event.source.userId
                        });
                        await tempDocRef.delete();

                        let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
                        itemsHtml += '<tr style="background-color: #f2f2f2;"><th>商品型號</th><th>數量</th><th>單價</th><th>小計</th></tr>';
                        if (reserveData.orderItems && Array.isArray(reserveData.orderItems)) {
                            reserveData.orderItems.forEach(item => {
                                const price = Number(item.unitPrice) || 0;
                                const qty = Number(item.qty) || 1;
                                itemsHtml += `<tr><td>${item.model}</td><td align="center">${qty}</td><td align="right">${price > 0 ? '$' + price : '待確認'}</td><td align="right">${price > 0 ? '$' + (price * qty) : '—'}</td></tr>`;
                            });
                        }
                        itemsHtml += `<tr style="background-color: #fef3c7;"><td colspan="3" align="right"><strong>總計</strong></td><td align="right"><strong>${totalAmount > 0 ? '$' + totalAmount : '待確認'}</strong></td></tr>`;
                        itemsHtml += '</table>';

                        const { emailSettings } = require('./src/config/emailSettings');
                        const reserveRecipients = emailSettings['#商品預留'] || ['sam.kuo@kinyo.tw', 'din@kinyo.tw'];

                        const reserveMailOptions = {
                            from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                            to: reserveRecipients,
                            subject: `[預留訂單]${reserveData.customer?.customerCode ? `[${reserveData.customer.customerCode}]` : ''} ${reserveData.customer?.company || ''}${reserveData.customer?.name && reserveData.customer.name !== reserveData.customer.company ? ' ' + reserveData.customer.name : ''} - 期限 ${reserveDeadline || '未指定'}`,
                            html: `
                              <h2 style="color: #6366F1;">📌 預留訂單通知 (佔位先留貨)</h2>
                              <p><strong>預留編號:</strong> ${newReserveId}</p>
                              <p><strong>客戶編號:</strong> ${reserveData.customer?.customerCode || '未建檔'}</p>
                              <p><strong>預留期限:</strong> <span style="color: #E11D48; font-size: 16px;">${reserveDeadline || '未提供'}</span></p>
                              <hr>
                              <p><strong>採購公司:</strong> ${reserveData.customer?.company || '未提供'}</p>
                              <p><strong>收件人:</strong> ${reserveData.customer?.name || '未提供'}</p>
                              <p><strong>聯絡電話:</strong> ${reserveData.customer?.phone || '未提供'}</p>
                              <p><strong>送貨地址:</strong> ${reserveData.customer?.address || '未提供'}</p>
                              <p><strong>備註:</strong> <span style="color: #E11D48;">${reserveData.customer?.remark || '無'}</span></p>
                              <hr>
                              <h3 style="color: #333;">🛒 預留商品明細：</h3>
                              ${itemsHtml}
                              <hr>
                              <p style="color: #666; font-size: 13px;">※ 系統將於預留期限到期前 7 天自動寄信提醒助理準備做單出貨。</p>
                            `
                        };
                        transporter.sendMail(reserveMailOptions).catch(err => console.error("預留訂單 SMTP 發信失敗:", err));

                        const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
                        if (configDoc.exists && configDoc.data().notifyGroupId) {
                            const targetGroupId = configDoc.data().notifyGroupId;
                            const companyName = reserveData.customer?.company || '未提供';
                            const customerCode = reserveData.customer?.customerCode || '未建檔';
                            const notifyText = `📌 [預留訂單]\n編號：${newReserveId.substring(0, 8)}\n客戶編號：${customerCode}\n公司：${companyName}\n期限：${reserveDeadline || '未指定'}\n項目：共 ${totalQty} 件\n\n到期前 7 天系統會自動提醒。`;
                            await lineClient.pushMessage({ to: targetGroupId, messages: [{ type: 'text', text: notifyText }] });
                        }

                        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `✅ 預留訂單已建立！\n編號：${newReserveId}\n期限：${reserveDeadline || '未指定'}` }] });
                        console.log(`[預留訂單] 成功建立 ${newReserveId}, deadline=${reserveDeadline}`);
                    } catch (err) {
                        console.error('[預留訂單處理錯誤]', err);
                        await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: `⚠️ 預留失敗: ${err.message}` }] });
                    }
                } else if (action === 'confirm_rma') {
                    shouldSkipSearch = true;
                    const orderId = params.get('id');
                    try {
                        const docRef = db.collection('tempOrders').doc(orderId);
                        const doc = await docRef.get();

                        if (!doc.exists) {
                            throw new Error('找不到該申請紀錄，可能已處理過或失效。');
                        }
                        const rmaData = doc.data();
                        const rmaDisplayId = `RMA${Date.now()}`; // 產生 RMA 專屬單號

                        // 1. 寫入正式資料表 (比照 C-1 邏輯)
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

                        // 2. 準備明細 HTML (加入故障原因欄位)
                        let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px; margin-bottom: 20px;">';
                        itemsHtml += '<tr style="background-color: #f2f2f2;"><th>不良品型號</th><th>數量</th><th>故障原因</th></tr>';
                        if (rmaData.items && Array.isArray(rmaData.items)) {
                            rmaData.items.forEach(item => {
                                itemsHtml += `<tr><td>${item.model}</td><td align="center">${item.quantity}</td><td style="color: #E11D48;">${item.reason || '未提供'}</td></tr>`;
                            });
                        }
                        itemsHtml += '</table>';

                        // 3. 發送 Email 通知
                        const mailOptions = {
                            from: process.env.GMAIL_USER || 'sam.kuo@kinyo.tw',
                            to: [process.env.GMAIL_USER || 'sam.kuo@kinyo.tw', 'din@kinyo.tw'],
                            subject: `[新品不良派車]${rmaData.customer?.customerCode ? `[${rmaData.customer.customerCode}]` : ''} ${rmaData.customer?.company || ''}${rmaData.customer?.name && rmaData.customer.name !== rmaData.customer.company ? ' - ' + rmaData.customer.name : ''}`,
                            html: `
                              <h2 style="color: #E11D48;">⚠️ 新品不良來回件派車單</h2>
                              <p><strong>單號:</strong> ${rmaDisplayId}</p>
                              <p><strong>客戶編號:</strong> ${rmaData.customer?.customerCode || '未建檔'}</p>
                              <p><strong>採購公司:</strong> ${rmaData.customer?.company || '未提供'}</p>
                              <p><strong>客戶姓名:</strong> ${rmaData.customer?.name}</p>
                              <p><strong>聯絡電話:</strong> ${rmaData.customer?.phone}</p>
                              <p><strong>取件/換貨地址:</strong> <span style="color: #E11D48; font-weight: bold;">${rmaData.customer?.address || '未提供'}</span></p>
                              <p><strong>備註:</strong> ${rmaData.customer?.remark || '無'}</p>
                              <hr>
                              <h3 style="color: #333;">📦 不良品明細與原因：</h3>
                              <h3 style="color: #333;">📦 不良品明細與原因：</h3>
                              ${itemsHtml}
                              <hr>
                              <br>
                              <p style="color: #666; font-size: 13px;">※ 若不良品已安排派件，可點擊下方按鈕結案並通知客戶</p>
                              <a href="https://asia-east1-kinyo-price.cloudfunctions.net/markRMACompleted?rmaId=${rmaDisplayId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#1DB446; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">✅ 標記為處理完成_已派車</a>
                            `
                        };
                        transporter.sendMail(mailOptions).catch(err => console.error("RMA SMTP 發信失敗:", err));

                        // 4. 發送 LINE 總部推播
                        const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
                        if (configDoc.exists && configDoc.data().notifyGroupId) {
                            const targetGroupId = configDoc.data().notifyGroupId;
                            const notifyText = `⚠️ [新品不良派車]\n客戶編號：${rmaData.customer?.customerCode || '未建檔'}\n公司：${rmaData.customer?.company || '未提供'}\n客戶：${rmaData.customer?.name}\n取件地址：${rmaData.customer?.address || '未提供'}\n\n請盡速查看 Email 安排物流派車。`;
                            await lineClient.pushMessage({
                                to: targetGroupId,
                                messages: [{ type: 'text', text: notifyText }]
                            });
                        }

                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '✅ 來回件申請已成功送出！我們將盡快安排物流派車。' }]
                        });
                        console.log(`[RMA狀態更新] 成功建立 ${rmaDisplayId}`);
                    } catch (err) {
                        console.error('[RMA處理錯誤]', err);
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: `⚠️ 申請失敗: ${err.message}` }]
                        });
                    }
                } else if (action === 'confirm_batch_order') {
                    shouldSkipSearch = true;
                    const idsStr = params.get('ids');
                    if (!idsStr) {
                        return lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '無法取得批次訂單 ID，請重新操作。' }]
                        });
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

                            // 轉移至 PendingOrders
                            orderData.orderId = newOrderId;
                            orderData.status = '處理中_批次';
                            orderData.createdAt = admin.firestore.FieldValue.serverTimestamp();
                            orderData.userId = lineUid;
                            orderData.userEmail = userEmail;
                            orderData.sourceId = event.source.groupId || event.source.userId;

                            // 計算總數量 (批次出貨預設單價0，不計總額)
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

                            // ===== SMTP 通知 (單筆寄送模式，也可根據需求組合為一封大信) =====
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
                                to: ['sam.kuo@kinyo.tw', 'din@kinyo.tw', 'chinlienhsin903@gmail.com'],
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
                                  <a href="${functionUrl}" style="display:inline-block; padding:14px 28px; color:white; background-color:#28a745; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px; margin-right: 10px;">✅ 出貨並填物流單號</a>
                                  <a href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${newOrderId}" style="display:inline-block; padding:14px 28px; color:white; background-color:#F59E0B; text-decoration:none; border-radius:6px; font-weight:bold; font-size:16px;">⚠️ 訂單異常 / 通知客戶</a>
                                `
                            };
                            transporter.sendMail(mailOptions).catch(err => console.error("批次 SMTP 發信失敗:", err));

                            // 發送 LINE 通知群組 (如果有設定)
                            const configDoc = await db.collection('SystemConfig').doc('OrderSettings').get();
                            if (configDoc.exists && configDoc.data().notifyGroupId) {
                                const targetGroupId = configDoc.data().notifyGroupId;

                                // 將 items 轉換為純文字明細列
                                let notifyItemsText = '';
                                if (orderData.items && Array.isArray(orderData.items)) {
                                    orderData.items.forEach(item => {
                                        notifyItemsText += `- ${item.model} x${item.quantity}\n`;
                                    });
                                }

                                const notifyText = `🚨 [行動屋出貨成立]\n\n🏢 門市：${orderData.customer?.company || ''} ${orderData.customer?.name}\n📍 地址：${orderData.customer?.address || '未提供'}\n📝 備註：${orderData.customer?.remark || '無'}\n\n📦 訂單明細：\n${notifyItemsText}\n(總計 ${totalQty} 件)\n\n信件已發送至助理信箱備查。`;

                                await lineClient.pushMessage({
                                    to: targetGroupId,
                                    messages: [{ type: 'text', text: notifyText }]
                                });
                            }

                        } catch (err) {
                            console.error(`[批次處理錯誤] ID: ${id}`, err);
                            errorCount++;
                        }
                    }

                    return lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{ type: 'text', text: `✅ 批次訂單已全部確認！成功建立 ${successCount} 筆出貨單。` }]
                    });

                } else if (action === 'cancel_batch_order') {
                    shouldSkipSearch = true;
                    // ... (批次訂單取消邏輯) ...
                    const idsStr = params.get('ids');
                    if (!idsStr) {
                        return lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '無法取得批次訂單 ID，請重新操作。' }]
                        });
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

                    return lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{ type: 'text', text: `❌ 已成功取消整批 ${deletedCount} 筆訂單。` }]
                    });

                } else if (action === 'confirm_special') {
                    shouldSkipSearch = true;
                    const requestId = params.get('id');
                    const requestDoc = await db.collection('SpecialRequests').doc(requestId).get();

                    if (!requestDoc.exists || requestDoc.data().status !== 'pending') {
                        return lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '⚠️ 此申請已處理或已失效。' }]
                        });
                    }

                    const data = requestDoc.data().data;

                    // 1. 組合 HTML Email 內文
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

                    // 2. 透過 Nodemailer 發信
                    const mailOptions = {
                        from: 'KINYO 報價系統 <sam.kuo@kinyo.tw>',
                        to: APPLY_PRICE_EMAILS,
                        subject: `【廠價申請】${data.department} + ${data.customer} + ${data.model}`,
                        html: emailHtml
                    };

                    transporter.sendMail(mailOptions).catch(err => console.error("廠價申請 SMTP 發信失敗:", err));

                    // 3. 更新資料庫狀態為已核准/已送出
                    await db.collection('SpecialRequests').doc(requestId).update({ status: 'sent' });

                    // 4. 回覆 LINE 群組
                    return lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{
                            type: 'text',
                            text: `✅ 廠價申請信件已成功發送至指定主管信箱。`
                        }]
                    });

                } else if (action === 'cancel_special') {
                    shouldSkipSearch = true;
                    // 處理取消
                    await db.collection('SpecialRequests').doc(params.get('id')).update({ status: 'cancelled' });
                    return lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{ type: 'text', text: '❌ 已取消此申請草稿。' }]
                    });
                } else {
                    continue;
                }
            } else if (event.type === 'follow') {
                // 處理加入好友 / 解除封鎖事件
                console.log(`[Follow Event] 收到加入好友或解除封鎖事件，UID: ${lineUid}`);
                try {
                    const usersRef = db.collection('Users');
                    const snapshot = await usersRef.where('line_uid', '==', lineUid).limit(1).get();

                    if (!snapshot.empty) {
                        // 情境 A：用戶已存在且已綁定 (解除封鎖情境)
                        console.log(`[Follow Event] 用戶已綁定，發送歡迎回來訊息`);
                        const userDoc = snapshot.docs[0];
                        const userLevel = parseInt(userDoc.data().level) || 0;

                        // 1. 宣告基礎回覆訊息 (不含按鈕)
                        let welcomeBackMessage = {
                            type: 'text',
                            text: '歡迎回來！您的帳號已綁定，可直接輸入關鍵字或點擊下方選單開始查價。'
                        };

                        // 2. 嚴格權限防線：僅 Level 4 賦予切換視角按鈕
                        if (userLevel === 4) {
                            welcomeBackMessage.quickReply = {
                                items: [
                                    {
                                        type: "action",
                                        action: {
                                            type: "postback",
                                            label: "切換查價視角",
                                            data: "action=show_level_menu"
                                        }
                                    }
                                ]
                            };
                        }

                        // 3. 執行回覆
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [welcomeBackMessage]
                        });
                    } else {
                        // 情境 B：全新用戶或未綁定用戶
                        console.log(`[Follow Event] 用戶未綁定，發送 Flex Message 引導綁定`);
                        const flexMessage = {
                            type: 'flex',
                            altText: '請綁定 KINYO 專屬報價系統',
                            contents: {
                                type: 'bubble',
                                header: {
                                    type: 'box',
                                    layout: 'vertical',
                                    contents: [
                                        {
                                            type: 'text',
                                            text: 'KINYO 專屬報價系統',
                                            weight: 'bold',
                                            size: 'xl',
                                            color: '#0055aa'
                                        }
                                    ]
                                },
                                body: {
                                    type: 'box',
                                    layout: 'vertical',
                                    contents: [
                                        {
                                            type: 'text',
                                            text: '請先綁定您的企業信箱，以取得對應等級的報價權限。',
                                            wrap: true,
                                            color: '#666666',
                                            size: 'sm'
                                        }
                                    ]
                                },
                                footer: {
                                    type: 'box',
                                    layout: 'vertical',
                                    spacing: 'sm',
                                    contents: [
                                        {
                                            type: 'button',
                                            style: 'primary',
                                            height: 'sm',
                                            color: '#0055aa',
                                            action: {
                                                type: 'uri',
                                                label: '立即綁定帳號',
                                                uri: 'https://liff.line.me/2009444751-vlA8ef2c'
                                            }
                                        }
                                    ]
                                }
                            }
                        };
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [flexMessage]
                        });
                    }
                } catch (error) {
                    console.error('[Follow Event] 處理 follow 事件時發生錯誤:', error);
                }
                continue; // 處理完 follow 事件後，直接換下一個 event
            } else {
                continue;
            }

            // ---------------------------------------------------------
            // 模組 3 前置：權限驗證攔截 (已重構成全域前置驗證，此段邏輯移除以簡化)
            // ---------------------------------------------------------

            // 處理全局快速切換指令 (跳過 Gemini 與搜尋)
            if (shouldSkipSearch) {
                const params = new URLSearchParams(event.type === 'postback' ? event.postback.data : '');
                const action = params.get('action');

                // 除了產生報價跟訂單操作以外的特殊指令，限 Level 4 (管理員/自己) 執行
                const isPublicAction = action === 'get_text_quote' || action === 'confirm_order' || action === 'cancel_order';

                if (!isPublicAction && realLevel !== 4) {
                    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '您無權限執行此指令。' }] });
                    continue;
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
                } else if (params.get('action') === 'set_level') {
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
                } else if (params.get('action') === 'get_text_quote') {
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
                            continue;
                        }

                        const cost = parseInt(p.cost) || 0;

                        const finalPrice = calculateLevelPrice(cost, currentViewLevel, evalQty);

                        const textMsg = `【${p.model}】${p.name || '未命名'}
賣場售價：${p.marketPrice || '未提供'}
末售價格：${p.minPrice || '未提供'}
--------------------
採購價格：
${evalQty}個：${finalPrice}

商品連結：${p.productUrl || '無'}`;
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
                }
                continue;
            }

            let intentParams = {
                intent: 'query',
                keyword: null,
                target_qty: null,
                min_budget: null,
                max_budget: null,
                min_stock: null,
                request_image_links: false,
                customer: null,
                orderItems: null
            };

            if (event.type === 'message') {
                const sourceId = event.source.groupId || event.source.roomId || event.source.userId;



                // ---------------------------------------------------------
                // 模組 2：呼叫 Gemini 解析意圖 (JSON Schema) 或 Fast Path (純型號)
                // ---------------------------------------------------------
                const { analyzeAndCleanMessage } = require('./src/utils/messagePreprocessor');
                const preprocessResult = analyzeAndCleanMessage(userText);
                
                if (!preprocessResult.requireAi) {
                    intentParams.intent = preprocessResult.intentInfo;
                    intentParams.action = preprocessResult.actionInfo;
                    
                    if (intentParams.intent === 'query') {
                        intentParams.keyword = preprocessResult.cleanText;
                        intentParams.target_qty = 1; // 預設查 1 個
                        console.log(`⚡ [Fast Path] 偵測為純型號查詢，略過 Gemini: "${intentParams.keyword}"`);
                    } else if (intentParams.intent === 'faq') {
                        console.log(`⚡ [Fast Path] 偵測為靜態 FAQ: "${intentParams.action}"`);
                    }
                } else {
                    const cleanUserText = preprocessResult.cleanText;
                    console.log(`[Gemini] 開始解析輸入文字: "${cleanUserText}" (原: "${userText}")`);

                try {
                    if (!isGroup) {
                        await lineClient.showLoadingAnimation({
                            chatId: lineUid,
                            loadingSeconds: 10
                        });
                    }
                } catch (loadErr) {
                    console.error(`⚠️ [Line SDK 警告] showLoadingAnimation failed:`, loadErr);
                }

                intentParams = await parseUserIntent(cleanUserText, config.geminiApiKey);

                    console.log(`🧠 [Gemini 解析結果]`, JSON.stringify(intentParams, null, 2));
                } // 結束 if (!preprocessResult.requireAi) else 區塊

                const fallbackMessage = {
                    type: 'text',
                    text: `🤖 系統提示：無法辨識指令\n\n很抱歉，『挺好的』目前無法完全理解您的需求。為加快處理速度，請參考以下標準指令：\n\n🔍 商品查價：請輸入「查價 + 型號」\n🛒 建立訂單：請填寫完整「下單模板」\n🛠️ 維修資訊：請輸入「維修」或「客服」\n📦 樣品/不良品：請直接填寫完整申請模板\n\n若需專人協助，請直接於群組內標註業務人員，謝謝您！`
                };



                const { handleSpecialActions } = require('./src/workflows/specialActionWorkflow');
                const { handleFaqRequest } = require('./src/workflows/faqWorkflow');

                // 處理 FAQ (如果由 Fast Path 攔截，或是 Gemini NLP 判斷出是 repair_info)
                if (intentParams.intent === 'faq' || intentParams.action === 'repair_info' || intentParams.action === 'user_guide') {
                    const faqType = (intentParams.action === 'user_guide') ? 'user_guide' : 'repair';
                    await handleFaqRequest(event, lineClient, faqType);
                    continue; // 執行完畢跳脫
                }

                const isSpecialAction = ['borrow_sample', 'defective_return', 'batch_order', 'reserve_order'].includes(intentParams.action);
                if (isSpecialAction) {
                    await handleSpecialActions(intentParams, { lineClient, replyToken });
                    continue; // 執行完特殊意圖後跳過後續查詢邏輯
                } else if (intentParams.intent === 'query' || intentParams.intent === 'order' || intentParams.action === 'query' || intentParams.action === 'search' || intentParams.action === 'export_ppt') {
                    // 允許正規查詢與下單指令通過，不在此處阻擋
                } else {
                    // 復原最後一道防線 (阻擋未知或垃圾訊息)
                    return lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [fallbackMessage]
                    });
                }
            }

            // ---------------------------------------------------------
            // 模組 3 & 4：交由服務層進行後續處理 (Quote & Order)
            // ---------------------------------------------------------
            console.log(`[Trace] 準備進入服務層. intent: ${intentParams.intent}, action: ${intentParams.action}, keyword: ${intentParams.keyword}`);
            if (intentParams.intent === 'order') {
                const userContext = { level, lineUid, userEmail, realLevel };
                await processOrder(intentParams, userContext, event, lineClient);
            } else if (intentParams.action === 'export_ppt') {
                const userContext = { level, userEmail, realLevel };
                const { processPptExport } = require('./src/services/pptGenerator');
                await processPptExport(intentParams, userContext, event, lineClient);
            } else if (intentParams.intent === 'query' || intentParams.action === 'query' || intentParams.action === 'search') {
                const userContext = { level, userEmail, realLevel };
                await processQuote(intentParams, userContext, event, lineClient);
            }
        }

        res.status(200).send('OK');
    } catch (e) {
        console.error('Webhook 執行發生整體錯誤:', e);
        if (e.originalError && e.originalError.response && e.originalError.response.data) {
            console.error(`❌ [Line API 詳細錯誤 (Top Level)]`, JSON.stringify(e.originalError.response.data, null, 2));
        }
        res.status(500).send('Internal Server Error');
    }
});

// --- API 擴充：信件出貨按鈕回呼 ---
exports.markOrderShipped = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).send('缺少訂單編號');

    const orderRef = db.collection('PendingOrders').doc(orderId);

    // GET: 顯示填寫表單
    if (req.method === 'GET') {
        const doc = await orderRef.get();
        if (!doc.exists) return res.status(404).send('<h2 style="text-align:center;">找不到該訂單</h2>');
        const order = doc.data();

        const isSample = orderId.startsWith('SMP');
        const titleText = isSample ? '確認樣品寄出' : '確認訂單出貨';
        const logistics = order.customer?.logistics || '';
        const existingTracking = order.tracking || '';
        const alreadyShipped = order.status === '已出貨';

        const confirmHtml = `
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="font-family: Arial, 'Microsoft JhengHei', sans-serif; background: #f5f5f5; margin: 0;">
            <div style="max-width: 520px; margin: 40px auto; padding: 32px; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <h2 style="color: #333; margin-top: 0;">${titleText}</h2>
                ${alreadyShipped ? `<div style="padding: 12px; background: #fff3cd; color: #856404; border-radius: 6px; margin-bottom: 16px;">⚠️ 此訂單已標記為「已出貨」，繼續操作會覆寫物流單號</div>` : ''}
                <p><strong>編號：</strong>${orderId}</p>
                <p><strong>客戶：</strong>${order.customer?.company || ''} ${order.customer?.name || ''}</p>
                ${logistics ? `<p><strong>物流方式：</strong><span style="color: #0055aa; font-weight: bold;">${logistics}</span></p>` : ''}
                <form method="POST" action="">
                    <label style="display:block; margin-top: 20px; font-weight: bold; color: #333;">
                        物流單號 <span style="font-weight: normal; color: #888; font-size: 13px;">（自取可留空）</span>
                    </label>
                    <input name="tracking" value="${existingTracking.replace(/"/g, '&quot;')}" placeholder="例：HC12345678 / EX87654321" style="width: 100%; padding: 12px; font-size: 16px; margin-top: 6px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box;" />
                    <button type="submit" style="background-color: #28a745; color: white; padding: 15px 32px; font-size: 16px; margin-top: 24px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; width: 100%;">
                        ✅ 確認出貨並推播 LINE 通知
                    </button>
                </form>
                <p style="color: #888; font-size: 12px; margin-top: 24px;">送出後系統會自動推播給客戶群組，並將單號存檔。</p>
            </div>
            </body></html>
        `;
        return res.send(confirmHtml);
    }

    // POST: 執行出貨
    try {
        const tracking = String(req.body?.tracking || '').trim();
        const doc = await orderRef.get();
        if (!doc.exists) return res.status(404).send('<h2>找不到該訂單</h2>');
        const orderData = doc.data();

        const wasAlreadyShipped = orderData.status === '已出貨';

        // 更新狀態 + 單號 (即使已出貨也允許更新單號)
        const updates = { status: '已出貨' };
        if (!wasAlreadyShipped) updates.shippedAt = admin.firestore.FieldValue.serverTimestamp();
        if (tracking) updates.tracking = tracking;
        await orderRef.update(updates);

        // 透過 LINE Messaging API 主動推播至原始群組/用戶
        const targetId = orderData.sourceId;
        let pushSuccess = true;
        if (targetId && !wasAlreadyShipped) {
            const config = getConfig();
            const lineClient = new messagingApi.MessagingApiClient({
                channelAccessToken: config.channelAccessToken
            });

            const customerName = orderData.customer?.name || orderData.customer?.company || '客戶';
            let orderDate = '未知時間';
            if (orderData.createdAt) {
                const dateObj = orderData.createdAt.toDate ? orderData.createdAt.toDate() : new Date(orderData.createdAt);
                const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
                const dd = String(dateObj.getDate()).padStart(2, '0');
                orderDate = `${mm}/${dd}`;
            }

            const logistics = orderData.customer?.logistics || '';
            const isSample = orderId.startsWith('SMP');

            let notifyText = isSample
                ? `📦 系統通知：樣品 (${customerName}；${orderDate}) 已安排寄出`
                : `📦 系統通知：訂單 (${customerName}；${orderDate}) 已由出貨中心安排出貨`;
            if (logistics) notifyText += `\n🚚 物流：${logistics}`;
            if (tracking) notifyText += `\n📋 單號：${tracking}`;
            notifyText += `\n\n請留意收件。`;

            try {
                await lineClient.pushMessage({
                    to: targetId,
                    messages: [{ type: 'text', text: notifyText }]
                });
            } catch (pushErr) {
                console.warn('[LINE Push Failed]', pushErr.response?.data || pushErr.message);
                pushSuccess = false;
            }
        }

        // 回傳成功畫面
        const successParts = [
            wasAlreadyShipped ? '📝 物流單號已更新' : '✅ 狀態更新成功',
            tracking ? `<br>📋 單號：<strong>${tracking}</strong>` : '',
            pushSuccess ? (wasAlreadyShipped ? '' : '<br>📢 已推播 LINE 通知給客戶') : '<br>⚠️ LINE 推播失敗，請自行通知',
        ].filter(Boolean).join('');

        return res.send(`
            <div style="font-family: Arial, 'Microsoft JhengHei', sans-serif; text-align: center; padding: 40px; background: #d4edda; color: #155724; border-radius: 8px; max-width: 520px; margin: 40px auto; font-size: 18px; line-height: 1.8;">
                ${successParts}
            </div>
        `);
    } catch (error) {
        console.error('出貨更新失敗:', error);
        return res.status(500).send('<h2 style="text-align: center; color: red;">系統發生錯誤，請聯絡管理員</h2>');
    }
});

// --- API 擴充：新品不良來回件派車單結案按鈕回呼 ---
exports.markRMACompleted = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const rmaId = req.query.rmaId;
    if (!rmaId) return res.status(400).send('缺少不良品派車單號');

    // 防範信箱預覽機制 (Prefetch)：GET 請求只回傳確認畫面
    if (req.method === 'GET') {
        const confirmHtml = `
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
                <h2 style="color: #333;">確認新品不良派車</h2>
                <p>即將發送派件通知給單號 <strong>${rmaId}</strong> 的客戶群組</p>
                <form method="POST" action="">
                    <button type="submit" style="background-color: #1DB446; color: white; padding: 15px 32px; text-align: center; text-decoration: none; display: inline-block; font-size: 16px; margin: 20px 2px; cursor: pointer; border: none; border-radius: 8px; font-weight: bold;">
                        ✅ 確認並發送 LINE 推播
                    </button>
                </form>
            </div>
        `;
        return res.send(confirmHtml);
    }

    try {
        const orderRef = db.collection('PendingOrders').doc(rmaId);
        const doc = await orderRef.get();

        if (!doc.exists) return res.status(404).send('<h2>找不到該筆不良品申請紀錄</h2>');

        const orderData = doc.data();

        // 防呆：避免重複點擊重複推播
        if (orderData.status === '處理完成_已派車') {
            return res.send('<h2 style="text-align: center; color: #856404; background-color: #fff3cd; padding: 20px;">此派車單先前已經標記為「處理完成_已派車」囉！</h2>');
        }

        // 更新資料庫狀態
        await orderRef.update({ status: '處理完成_已派車' });

        // 透過 LINE Messaging API 主動推播至原始群組/用戶
        const targetId = orderData.sourceId;
        if (targetId) {
            // 在新請求中重新初始化 Line SDK v9 client
            const config = getConfig();
            const lineClient = new messagingApi.MessagingApiClient({
                channelAccessToken: config.channelAccessToken
            });

            // 抓取客戶名稱，若無則為空
            const customerName = orderData.customer?.name || '';
            const notifyText = `📦 系統通知：新品不良單 (${customerName}) 已經由總部處理完畢並安排派車！`;

            await lineClient.pushMessage({
                to: targetId,
                messages: [{ type: 'text', text: notifyText }]
            });
        }

        // 回傳成功畫面給點擊信件的助理
        return res.send('<h2 style="text-align: center; color: #155724; background-color: #d4edda; padding: 20px; border-radius: 8px;">✅ 狀態更新成功！已自動發送 LINE 派件通知給客戶群組。</h2>');
    } catch (error) {
        console.error('RMA 結案更新失敗:', error);
        return res.status(500).send('<h2 style="text-align: center; color: red;">系統發生錯誤，請聯絡管理員</h2>');
    }
});

// --- 預留單：標記為已完成 (不通知客戶) ---
exports.markReserveCompleted = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const reserveId = req.query.reserveId;
    if (!reserveId) return res.status(400).send('缺少預留單號');

    const reserveRef = db.collection('ReservedOrders').doc(reserveId);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // GET: 顯示確認頁
    if (req.method === 'GET') {
        const doc = await reserveRef.get();
        if (!doc.exists) return res.status(404).send('<h2 style="text-align:center;">找不到該預留單</h2>');
        const data = doc.data();
        const alreadyDone = data.status !== 'active';
        const company = data.customer?.company || data.customer?.name || '';
        const code = data.customer?.customerCode || '';
        const deadline = data.reserveDeadline || '';
        const itemCount = Array.isArray(data.orderItems) ? data.orderItems.length : 0;
        const totalAmount = data.totalAmount || 0;

        const confirmHtml = `
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="font-family: Arial, 'Microsoft JhengHei', sans-serif; background: #f5f5f5; margin: 0;">
            <div style="max-width: 520px; margin: 40px auto; padding: 32px; background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <h2 style="color: #333; margin-top: 0;">確認預留單已完成</h2>
                ${alreadyDone ? `<div style="padding: 12px; background: #fff3cd; color: #856404; border-radius: 6px; margin-bottom: 16px;">⚠️ 此預留單狀態已是「${esc(data.status)}」，不需再標記</div>` : ''}
                <p><strong>編號：</strong>${esc(reserveId)}</p>
                ${code ? `<p><strong>客戶編號：</strong>${esc(code)}</p>` : ''}
                <p><strong>客戶：</strong>${esc(company)}</p>
                ${deadline ? `<p><strong>預留期限：</strong>${esc(deadline)}</p>` : ''}
                <p><strong>項目：</strong>${itemCount} 項 / $${totalAmount}</p>
                <form method="POST" action="">
                    <button type="submit" ${alreadyDone ? 'disabled' : ''} style="background-color: #28a745; color: white; padding: 15px 32px; font-size: 16px; margin-top: 24px; border: none; border-radius: 8px; font-weight: bold; cursor: pointer; width: 100%; ${alreadyDone ? 'opacity: 0.5; cursor: not-allowed;' : ''}">
                        ✅ 標記為已完成
                    </button>
                </form>
                <p style="color: #888; font-size: 12px; margin-top: 24px;">此操作不會通知客戶。完成後此預留單會從儀表板移除。</p>
            </div>
            </body></html>
        `;
        return res.send(confirmHtml);
    }

    // POST: 執行標記
    try {
        const doc = await reserveRef.get();
        if (!doc.exists) return res.status(404).send('<h2>找不到該預留單</h2>');
        const data = doc.data();

        if (data.status !== 'active') {
            return res.send(`<h2 style="text-align: center; color: #856404; background-color: #fff3cd; padding: 20px;">此預留單狀態已是「${esc(data.status)}」，不需再標記</h2>`);
        }

        await reserveRef.update({
            status: 'completed',
            completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.send('<h2 style="text-align: center; color: #155724; background-color: #d4edda; padding: 20px; border-radius: 8px;">✅ 預留單已標記為完成。</h2>');
    } catch (error) {
        console.error('預留單完成更新失敗:', error);
        return res.status(500).send('<h2 style="text-align: center; color: red;">系統發生錯誤，請聯絡管理員</h2>');
    }
});

// --- API 擴充：訂單異常 / 缺貨通知表單 ---
exports.orderExceptionForm = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).send('缺少訂單編號');

    try {
        const orderRef = db.collection('PendingOrders').doc(orderId);
        const doc = await orderRef.get();

        if (!doc.exists) return res.status(404).send('<h2>找不到該訂單</h2>');

        const orderData = doc.data();
        const customerName = orderData.customer?.name || orderData.customer?.company || '客戶';

        const formHtml = `
            <!DOCTYPE html>
            <html lang="zh-TW">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>訂單異常 / 通知客戶</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; color: #333; line-height: 1.6; padding: 20px; }
                    .container { max-width: 600px; margin: 0 auto; background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    h2 { color: #E11D48; margin-top: 0; }
                    .info-box { background-color: #fee2e2; border: 1px solid #fecaca; padding: 15px; border-radius: 6px; margin-bottom: 20px; }
                    .form-group { margin-bottom: 20px; }
                    label { display: block; margin-bottom: 8px; font-weight: bold; }
                    textarea { width: 100%; height: 150px; padding: 10px; border: 1px solid #ccc; border-radius: 4px; resize: vertical; font-family: inherit; }
                    .submit-btn { background-color: #E11D48; color: white; border: none; padding: 12px 24px; font-size: 16px; font-weight: bold; border-radius: 6px; cursor: pointer; width: 100%; transition: background-color 0.2s; }
                    .submit-btn:hover { background-color: #be123c; }
                    .note { font-size: 13px; color: #666; margin-top: 10px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h2>⚠️ 訂單異常 / 通知客戶</h2>
                    <div class="info-box">
                        <p style="margin:0 0 5px 0;"><strong>訂單編號：</strong> ${escapeHtml(orderId)}</p>
                        <p style="margin:0;"><strong>客戶名稱：</strong> ${escapeHtml(customerName)}</p>
                    </div>
                    
                    <form action="https://asia-east1-kinyo-price.cloudfunctions.net/submitOrderException" method="POST">
                        <input type="hidden" name="orderId" value="${escapeHtml(orderId)}">
                        <div class="form-group">
                            <label for="reason">缺貨明細 / 留言給客戶：</label>
                            <textarea id="reason" name="reason" placeholder="請輸入要通知客戶的內容，例：\n您好，訂單中的「AB-1234」目前缺貨，我們將先寄出部分商品，缺貨的部分預計下週一補寄給您，若有問題請回覆我們。" required></textarea>
                            <p class="note">※ 送出後，系統將會直接透過 LINE Bot 推播這段訊息給該名客戶。</p>
                        </div>
                        <button type="submit" class="submit-btn" onclick="return confirm('確定要發送通知給客戶嗎？');">✅ 發送出貨與異常通知</button>
                    </form>
                </div>
            </body>
            </html>
        `;

        res.status(200).send(formHtml);
    } catch (error) {
        console.error('開啟異常通知表單錯誤:', error);
        res.status(500).send('<h2>系統發生錯誤，請聯絡管理員</h2>');
    }
});

// --- API 擴充：送出訂單異常通知 ---
exports.submitOrderException = functions.region('asia-east1').https.onRequest(async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).send('Method Not Allowed');
    }

    const { orderId, reason } = req.body;
    if (!orderId || !reason) {
        return res.status(400).send('<h2>缺少必要欄位</h2>');
    }

    try {
        const orderRef = db.collection('PendingOrders').doc(orderId);
        const doc = await orderRef.get();

        if (!doc.exists) return res.status(404).send('<h2>找不到該訂單</h2>');

        const orderData = doc.data();
        
        // 更新資料庫狀態紀錄
        await orderRef.update({ 
            exceptionMessage: reason,
            exceptionNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
            status: '處理中_已發送異常通知'
        });

        // 透過 LINE Messaging API 發送推播
        const targetId = orderData.sourceId;
        if (targetId) {
            const config = getConfig();
            const lineClient = new messagingApi.MessagingApiClient({
                channelAccessToken: config.channelAccessToken
            });

            const notifyText = `⚠️ 單據狀況通知 (單號：${orderId})\n\n工作人員留給您的訊息：\n\n${reason.trim()}`;

            try {
                await lineClient.pushMessage({
                    to: targetId,
                    messages: [{ type: 'text', text: notifyText }]
                });
            } catch (pushErr) {
                console.warn('[LINE Push Failed]', pushErr.response?.data || pushErr.message);
                return res.send(`
                    <div style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
                        <h2 style="color: #856404; background-color: #fff3cd; padding: 20px; border-radius: 8px;">✅ 狀態更新成功！但因群組設定或推播配額不足，未能即時發送 LINE 通知。</h2>
                        <a href="javascript:window.close();" style="display:inline-block; margin-top:20px; padding:10px 20px; background-color:#6c757d; color:white; text-decoration:none; border-radius:5px;">關閉視窗</a>
                    </div>
                `);
            }
        }

        return res.send(`
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
                <h2 style="color: #155724; background-color: #d4edda; padding: 20px; border-radius: 8px;">✅ 已成功向客戶發送通知！</h2>
                <a href="javascript:window.close();" style="display:inline-block; margin-top:20px; padding:10px 20px; background-color:#6c757d; color:white; text-decoration:none; border-radius:5px;">關閉視窗</a>
            </div>
        `);
    } catch (error) {
        console.error('送出異常通知失敗:', error);
        return res.status(500).send('<h2>系統發生錯誤，請聯絡管理員</h2>');
    }
});

// --- 新增：手動觸發 GDrive 背景同步 ---
exports.syncGDrive = functions
    .runWith({ timeoutSeconds: 540, memory: '1GB' })
    .region('asia-east1')
    .https.onRequest(async (req, res) => {
    const token = req.query.token;
    const startIndex = parseInt(req.query.startIndex, 10) || 0;
    
    if (!process.env.SYNC_TOKEN || token !== process.env.SYNC_TOKEN) {
        return res.status(403).send('Forbidden: Invalid token');
    }
    
    const targetModel = req.query.targetModel || null;
    const isIncremental = req.query.mode === 'incremental';
    const modeLabel = isIncremental ? '增量' : '全量';
    console.log(`開始執行${modeLabel}同步任務，可能需要數分鐘... 索引起點: ${startIndex}${targetModel ? `, 單一型號: ${targetModel}` : ''}`);

    // 初始化 LINE Client
    let lineClient = null;
    try {
        const config = getConfig();
        if (config.channelAccessToken) {
            lineClient = new messagingApi.MessagingApiClient({
                channelAccessToken: config.channelAccessToken
            });
        }
    } catch (e) {
        console.error("無法初始化 LINE Client", e);
    }

    const adminUid = process.env.ADMIN_LINE_UID;
    
    try {
        const result = await runStorageSync(startIndex, targetModel, { incremental: isIncremental });
        if (result.continueFrom) {
            console.log(`⏳ 準備回傳接力 (下一個索引: ${result.continueFrom}/${result.total})`);
            if (lineClient && adminUid) {
                await lineClient.pushMessage({
                    to: adminUid,
                    messages: [{ type: "text", text: `⏳ [系統通知] 圖庫同步已達 7 分鐘，為防止逾時中斷，系統已切換批次接力下載。\n目前進度：${result.continueFrom} / ${result.total} 個型號。\n背景自動接力同步中，請稍候...` }]
                }).catch(e => console.error("通知發送失敗", e));
            }
            
            // 觸發下一次同步（傳遞增量模式 flag）
            fetch(`https://asia-east1-kinyo-price.cloudfunctions.net/syncGDrive?token=${process.env.SYNC_TOKEN}&startIndex=${result.continueFrom}${targetModel ? "&targetModel=" + targetModel : ""}${result.incremental ? "&mode=incremental" : ""}`, { signal: AbortSignal.timeout(1000) })
                .catch(() => {}); // 預防 HeadersTimeoutError
        } else if (result.success) {
            console.log('✅ 同步任務完成');
            if (lineClient && adminUid) {
                await lineClient.pushMessage({
                    to: adminUid,
                    messages: [{ type: 'text', text: '✅ [系統通知] 圖庫背景同步已順利完成！\n您可以前往網頁查看最新的圖片。' }]
                }).catch(e => console.error("通知發送失敗", e));
            }
            return res.status(200).send('同步任務已順利完成！請查閱 Logs 確認。');
        } else {
            console.error('❌ 同步任務發生錯誤:', result.error);
            if (lineClient && adminUid) {
                await lineClient.pushMessage({
                    to: adminUid,
                    messages: [{ type: 'text', text: `❌ [系統通知] 圖庫背景同步失敗！\n錯誤訊息：${result.error}` }]
                }).catch(e => console.error("通知發送失敗", e));
            }
            return res.status(500).send('同步任務失敗: ' + result.error);
        }
    } catch (err) {
        console.error("未捕捉錯誤:", err);
        if (lineClient && adminUid) {
            await lineClient.pushMessage({
                to: adminUid,
                messages: [{ type: 'text', text: `❌ [系統通知] 圖庫背景同步發生意外錯誤！\n錯誤訊息：${err.message}` }]
            }).catch(e => console.error("通知發送失敗", e));
        }
        return res.status(500).send('意外系統錯誤');
    }
});

// --- 每日排程（凌晨 3 點台灣時間）：熱門榜統計 ---
// 圖庫同步已改為手動觸發，呼叫 syncGDrive HTTP endpoint
exports.scheduledDriveSync = functions
    .runWith({ timeoutSeconds: 540, memory: '1GB' })
    .region('asia-east1')
    .pubsub.schedule('0 3 * * *')
    .timeZone('Asia/Taipei')
    .onRun(async (context) => {
        // --- 每日熱門榜統計（基於 ProductClicks 過去 30 天數據）---
        try {
            console.log('📊 [排程] 開始統計熱門詢價榜（過去 30 天）...');
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const clicksSnap = await db.collection('ProductClicks')
                .where('clickedAt', '>=', admin.firestore.Timestamp.fromDate(thirtyDaysAgo))
                .get();

            if (!clicksSnap.empty) {
                const modelCounts = {};
                const modelNames = {};
                clicksSnap.docs.forEach(d => {
                    const data = d.data();
                    const model = (data.model || '').toUpperCase().trim();
                    if (!model) return;
                    modelCounts[model] = (modelCounts[model] || 0) + 1;
                    if (data.name) modelNames[model] = data.name;
                });

                const hotArray = Object.keys(modelCounts).map(model => ({
                    model, name: modelNames[model] || '', count: modelCounts[model]
                })).sort((a, b) => b.count - a.count).slice(0, 8);

                if (hotArray.length > 0) {
                    await db.collection('SiteConfig').doc('homeHotList').set({
                        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                        items: hotArray
                    }, { merge: true });
                    console.log(`📊 [排程] 熱門榜已更新，共 ${hotArray.length} 筆`);
                }
            } else {
                console.log('📊 [排程] 過去 30 天無 ProductClicks 資料，跳過熱門榜更新');
            }
        } catch (hotErr) {
            console.error('[排程] 熱門榜統計失敗:', hotErr);
        }

        return null;
    });

// --- 每日排程（上午 9 點台灣時間）：預留訂單 7 天到期前提醒 ---
exports.reservedOrderReminder = functions
    .runWith({ timeoutSeconds: 300, memory: '256MB' })
    .region('asia-east1')
    .pubsub.schedule('0 9 * * *')
    .timeZone('Asia/Taipei')
    .onRun(async (context) => {
        try {
            // 計算 7 天後的日期 (YYYY-MM-DD, Asia/Taipei)
            const now = new Date();
            const taipeiNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
            const targetDate = new Date(taipeiNow.getTime() + 7 * 24 * 60 * 60 * 1000);
            const targetDateStr = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}-${String(targetDate.getDate()).padStart(2, '0')}`;

            console.log(`[預留提醒] 檢查預留期限為 ${targetDateStr} 的訂單`);

            const snap = await db.collection('ReservedOrders')
                .where('reserveDeadline', '==', targetDateStr)
                .where('status', '==', 'active')
                .where('reminderSent', '==', false)
                .get();

            if (snap.empty) {
                console.log('[預留提醒] 今日無需提醒的預留訂單');
                return null;
            }

            const { emailSettings } = require('./src/config/emailSettings');
            const reserveRecipients = emailSettings['#商品預留'] || ['sam.kuo@kinyo.tw', 'din@kinyo.tw'];

            for (const doc of snap.docs) {
                const data = doc.data();
                const reserveId = doc.id;

                let itemsHtml = '<table border="1" cellpadding="8" cellspacing="0" style="border-collapse: collapse; width: 100%; max-width: 600px;">';
                itemsHtml += '<tr style="background-color: #f2f2f2;"><th>型號</th><th>數量</th><th>單價</th></tr>';
                if (data.orderItems && Array.isArray(data.orderItems)) {
                    data.orderItems.forEach(item => {
                        const price = Number(item.unitPrice) || 0;
                        const qty = Number(item.qty) || 1;
                        itemsHtml += `<tr><td>${item.model}</td><td align="center">${qty}</td><td align="right">${price > 0 ? '$' + price : '待確認'}</td></tr>`;
                    });
                }
                itemsHtml += '</table>';

                const mailOptions = {
                    from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                    to: reserveRecipients,
                    subject: `⏰ [預留訂單到期提醒]${data.customer?.customerCode ? `[${data.customer.customerCode}]` : ''} ${data.customer?.company || ''}${data.customer?.name && data.customer.name !== data.customer.company ? ' ' + data.customer.name : ''} - 7 天後到期`,
                    html: `
                      <h2 style="color: #E11D48;">⏰ 預留訂單即將到期提醒</h2>
                      <p style="font-size: 16px;">以下預留訂單將於 <strong style="color: #E11D48;">${data.reserveDeadline}</strong>（7 天後）到期，請盡速準備做單出貨。</p>
                      <hr>
                      <p><strong>預留編號:</strong> ${reserveId}</p>
                      <p><strong>客戶編號:</strong> ${data.customer?.customerCode || '未建檔'}</p>
                      <p><strong>採購公司:</strong> ${data.customer?.company || '未提供'}</p>
                      <p><strong>收件人:</strong> ${data.customer?.name || '未提供'}</p>
                      <p><strong>聯絡電話:</strong> ${data.customer?.phone || '未提供'}</p>
                      <p><strong>送貨地址:</strong> ${data.customer?.address || '未提供'}</p>
                      <p><strong>備註:</strong> ${data.customer?.remark || '無'}</p>
                      <hr>
                      <h3>預留商品：</h3>
                      ${itemsHtml}
                    `
                };

                try {
                    await transporter.sendMail(mailOptions);
                    await doc.ref.update({ reminderSent: true, reminderSentAt: admin.firestore.FieldValue.serverTimestamp() });
                    console.log(`[預留提醒] 已寄出 ${reserveId}`);
                } catch (sendErr) {
                    console.error(`[預留提醒] ${reserveId} 寄信失敗:`, sendErr);
                }
            }

            console.log(`[預留提醒] 處理完成，共 ${snap.size} 筆`);
        } catch (err) {
            console.error('[預留提醒] 排程錯誤:', err);
        }
        return null;
    });

// --- 訂單取消 (GET 確認頁 / POST 執行取消) ---
exports.orderCancel = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const token = req.query.token || req.body?.token;
    const expected = process.env.DASHBOARD_TOKEN || 'KinyoDash2026!pQ7wN';
    if (!token || token !== expected) {
        return res.status(401).send('<h2>⛔ Unauthorized</h2>');
    }
    const orderId = req.query.orderId || req.body?.orderId;
    if (!orderId) return res.status(400).send('<h2>缺少訂單編號</h2>');

    const ref = db.collection('PendingOrders').doc(orderId);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    try {
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).send('<h2>找不到訂單</h2>');
        const data = doc.data();
        const c = data.customer || {};
        const status = data.status || '';

        if (['已出貨', '處理完成_已派車', 'cancelled'].includes(status)) {
            return res.status(400).send(`<div style="font-family:sans-serif;text-align:center;padding:60px;"><h2 style="color:#856404">⚠️ 此訂單狀態為「${esc(status)}」，無法取消</h2></div>`);
        }

        if (req.method === 'POST') {
            const reason = (req.body.cancelReason || '').trim();
            await ref.update({
                status: 'cancelled',
                cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                cancelReason: reason,
            });

            transporter.sendMail({
                from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                to: process.env.ORDER_NOTIFY_EMAILS ? process.env.ORDER_NOTIFY_EMAILS.split(',') : ['sam.kuo@kinyo.tw', 'din@kinyo.tw'],
                subject: `❌ [訂單取消] ${orderId} ${c.company || ''}${c.customerCode ? ' [' + c.customerCode + ']' : ''}`,
                html: `
                    <h2 style="color:#E11D48">❌ 訂單已取消</h2>
                    <p><strong>編號：</strong>${orderId}</p>
                    <p><strong>客戶編號：</strong>${esc(c.customerCode || '未建檔')}</p>
                    <p><strong>採購公司：</strong>${esc(c.company || '-')}</p>
                    ${reason ? `<p><strong>取消原因：</strong><span style="color:#E11D48">${esc(reason)}</span></p>` : ''}
                    <p style="color:#666;font-size:12px">取消時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</p>
                `
            }).catch(e => console.error('[取消通知 SMTP]', e));

            return res.send(`
                <div style="font-family:sans-serif;text-align:center;padding:60px;background:#f8d7da;color:#721c24;border-radius:8px;max-width:600px;margin:40px auto;">
                    <h2>❌ 訂單已取消</h2>
                    <p>${esc(orderId)}</p>
                    <p>已寄取消通知 email 給助理</p>
                    <a href="javascript:window.close();" style="color:#0055aa">關閉此頁</a>
                </div>
            `);
        }

        // GET：確認頁
        const type = orderId.startsWith('SMP') ? '借樣品' : orderId.startsWith('RMA') ? '派車單' : orderId.startsWith('BCH') ? '行動屋' : '訂單';
        const itemsList = Array.isArray(data.items) ? data.items : (Array.isArray(data.orderItems) ? data.orderItems : []);
        const itemSummary = itemsList.map(it => `${esc(it.model)} x${Number(it.qty || it.quantity || 0)}`).join(', ');

        const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>取消訂單 ${esc(orderId)}</title>
<style>
body { font-family: 'Microsoft JhengHei', Arial, sans-serif; margin: 0; background: #f5f5f5; }
.wrap { max-width: 560px; margin: 40px auto; padding: 32px; background: white; border-radius: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.08); }
h2 { margin-top: 0; color: #E11D48; }
.info { background: #f9f9f9; padding: 14px 16px; border-radius: 8px; margin: 16px 0; font-size: 14px; line-height: 1.8; }
.info strong { color: #333; display: inline-block; min-width: 80px; }
label { display: block; font-weight: bold; font-size: 13px; margin: 16px 0 6px; color: #333; }
textarea { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: inherit; min-height: 80px; }
.warn { background: #fff3cd; color: #856404; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin: 16px 0; }
.actions { display: flex; gap: 12px; margin-top: 24px; }
.btn { flex: 1; padding: 14px; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; text-decoration: none; display: inline-block; text-align: center; color: white; }
.btn-danger { background: #E11D48; }
.btn-back { background: #666; }
</style>
</head><body>
<div class="wrap">
    <h2>❌ 確認取消訂單</h2>
    <div class="info">
        <div><strong>類型：</strong>${esc(type)}</div>
        <div><strong>編號：</strong>${esc(orderId)}</div>
        <div><strong>客戶：</strong>${esc(c.customerCode ? '【' + c.customerCode + '】' : '')}${esc(c.company || c.name || '-')}</div>
        ${data.totalAmount ? `<div><strong>金額：</strong>$${data.totalAmount}</div>` : ''}
        <div><strong>商品：</strong>${esc(itemSummary || '-')}</div>
    </div>
    <div class="warn">⚠️ 取消後訂單狀態會變成 cancelled，並寄 email 通知助理。此動作無法復原。</div>
    <form method="POST" action="">
        <input type="hidden" name="token" value="${esc(token)}">
        <input type="hidden" name="orderId" value="${esc(orderId)}">
        <label>取消原因 (選填)</label>
        <textarea name="cancelReason" placeholder="例：客戶改單、倉庫缺貨、誤下單..."></textarea>
        <div class="actions">
            <a class="btn btn-back" href="javascript:history.back()">← 返回</a>
            <button type="submit" class="btn btn-danger" onclick="return confirm('確定要取消此訂單嗎？')">❌ 確認取消</button>
        </div>
    </form>
</div>
</body></html>`;

        res.set('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        console.error('[orderCancel]', err);
        res.status(500).send(`<h2>Error: ${err.message}</h2>`);
    }
});

// --- 訂單編輯 (GET 表單 / POST 儲存或取消) ---
exports.orderEdit = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const token = req.query.token || req.body?.token;
    const expected = process.env.DASHBOARD_TOKEN || 'KinyoDash2026!pQ7wN';
    if (!token || token !== expected) {
        return res.status(401).send('<h2>⛔ Unauthorized</h2>');
    }

    const orderId = req.query.orderId || req.body?.orderId;
    if (!orderId) return res.status(400).send('<h2>缺少訂單編號</h2>');

    const ref = db.collection('PendingOrders').doc(orderId);
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // POST：儲存或取消
    if (req.method === 'POST') {
        try {
            const doc = await ref.get();
            if (!doc.exists) return res.status(404).send('<h2>找不到訂單</h2>');
            const oldData = doc.data();
            const oldC = oldData.customer || {};

            // 狀態防呆：已出貨的不能改/取消
            const status = oldData.status || '';
            if (['已出貨', '處理完成_已派車', 'cancelled'].includes(status)) {
                return res.status(400).send(`<h2 style="text-align:center;padding:40px;color:#856404;background:#fff3cd;">⚠️ 訂單狀態為「${esc(status)}」，無法修改</h2>`);
            }

            const action = req.body.action;

            if (action === 'cancel') {
                await ref.update({
                    status: 'cancelled',
                    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
                    cancelReason: req.body.cancelReason || '',
                });
                // 寄 email 通知助理
                transporter.sendMail({
                    from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                    to: process.env.ORDER_NOTIFY_EMAILS ? process.env.ORDER_NOTIFY_EMAILS.split(',') : ['sam.kuo@kinyo.tw', 'din@kinyo.tw'],
                    subject: `❌ [訂單取消] ${orderId} ${oldC.company || ''}${oldC.customerCode ? ' [' + oldC.customerCode + ']' : ''}`,
                    html: `
                        <h2 style="color:#E11D48">❌ 訂單已取消</h2>
                        <p><strong>編號：</strong>${orderId}</p>
                        <p><strong>客戶：</strong>${oldC.company || '-'}</p>
                        ${req.body.cancelReason ? `<p><strong>取消原因：</strong>${esc(req.body.cancelReason)}</p>` : ''}
                        <p style="color:#666">此訂單已於 ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })} 取消。</p>
                    `
                }).catch(e => console.error('[取消通知 SMTP]', e));

                return res.send(`<div style="font-family:sans-serif;text-align:center;padding:60px;"><h2 style="color:#E11D48">❌ 訂單已取消</h2><p>${esc(orderId)}</p><p style="color:#666">已寄通知給助理</p><a href="javascript:window.close();" style="color:#0055aa">關閉此頁</a></div>`);
            }

            // action === 'save'
            const newC = {
                name: (req.body.name || '').trim(),
                phone: (req.body.phone || '').trim(),
                address: (req.body.address || '').trim(),
                logistics: (req.body.logistics || '').trim(),
                deliveryTime: (req.body.deliveryTime || '').trim(),
                returnDate: (req.body.returnDate || '').trim(),
                projectName: (req.body.projectName || '').trim(),
                remark: (req.body.remark || '').trim(),
            };

            // 比對 diff
            const diffs = [];
            const fieldLabels = { name: '收件人', phone: '聯絡電話', address: '送貨地址', logistics: '物流方式', deliveryTime: '預期到貨', returnDate: '預計歸還', projectName: '借樣案名', remark: '備註' };
            Object.keys(fieldLabels).forEach(k => {
                const oldV = oldC[k] || '';
                const newV = newC[k];
                if (oldV !== newV && (oldV || newV)) {
                    diffs.push({ label: fieldLabels[k], old: oldV, new: newV });
                }
            });

            if (diffs.length === 0) {
                return res.send(`<div style="font-family:sans-serif;text-align:center;padding:60px;"><h2 style="color:#856404">📝 無變更</h2><p>沒有欄位被修改</p><a href="javascript:history.back()">← 返回</a></div>`);
            }

            // 更新
            const updates = {};
            Object.keys(newC).forEach(k => {
                updates[`customer.${k}`] = newC[k];
            });
            updates.modifiedAt = admin.firestore.FieldValue.serverTimestamp();
            await ref.update(updates);

            // 寄 email 通知助理 (含 diff)
            const diffHtml = diffs.map(d =>
                `<tr><td>${esc(d.label)}</td><td style="text-decoration:line-through;color:#888">${esc(d.old || '(空)')}</td><td style="color:#E11D48;font-weight:bold">${esc(d.new || '(空)')}</td></tr>`
            ).join('');
            transporter.sendMail({
                from: 'KINYO 系統通知 <sam.kuo@kinyo.tw>',
                to: process.env.ORDER_NOTIFY_EMAILS ? process.env.ORDER_NOTIFY_EMAILS.split(',') : ['sam.kuo@kinyo.tw', 'din@kinyo.tw'],
                subject: `✏️ [訂單已修改] ${orderId} ${oldC.company || ''}${oldC.customerCode ? ' [' + oldC.customerCode + ']' : ''}`,
                html: `
                    <h2 style="color:#F59E0B">✏️ 訂單內容已修改</h2>
                    <p><strong>編號：</strong>${orderId}</p>
                    <p><strong>客戶：</strong>${esc(oldC.company || '-')}</p>
                    <table border="1" cellpadding="8" style="border-collapse:collapse;margin-top:12px">
                        <tr style="background:#f2f2f2"><th>欄位</th><th>舊值</th><th>新值</th></tr>
                        ${diffHtml}
                    </table>
                    <p style="color:#666;font-size:12px;margin-top:16px">修改時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</p>
                `
            }).catch(e => console.error('[修改通知 SMTP]', e));

            return res.send(`
                <div style="font-family:sans-serif;text-align:center;padding:60px;background:#d4edda;color:#155724;border-radius:8px;max-width:600px;margin:40px auto;">
                    <h2>✅ 訂單已更新</h2>
                    <p>${esc(orderId)}</p>
                    <p>已寄變更通知 email 給助理（共 ${diffs.length} 項變更）</p>
                    <a href="javascript:window.close();" style="color:#0055aa">關閉此頁</a>
                </div>
            `);
        } catch (err) {
            console.error('[orderEdit POST]', err);
            return res.status(500).send(`<h2>Error: ${err.message}</h2>`);
        }
    }

    // GET：顯示表單
    try {
        const doc = await ref.get();
        if (!doc.exists) return res.status(404).send('<h2>找不到訂單</h2>');
        const data = doc.data();
        const c = data.customer || {};
        const status = data.status || '';

        const isEditable = ['處理中', '處理中_借樣品', '處理中_來回件', '處理中_批次'].includes(status);
        if (!isEditable) {
            return res.send(`<div style="font-family:sans-serif;text-align:center;padding:60px;"><h2 style="color:#856404">⚠️ 此訂單狀態為「${esc(status)}」，無法修改</h2><a href="javascript:history.back()">← 返回</a></div>`);
        }

        const isRma = orderId.startsWith('RMA');
        const isSample = orderId.startsWith('SMP');
        const itemsList = Array.isArray(data.items) ? data.items : (Array.isArray(data.orderItems) ? data.orderItems : []);
        const itemRows = itemsList.map(it => `<tr><td>${esc(it.model || '')}</td><td style="text-align:right">${Number(it.qty || it.quantity || 0)}</td>${isRma ? '' : `<td style="text-align:right">${it.unitPrice ? '$' + it.unitPrice : '-'}</td>`}</tr>`).join('');

        const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>編輯訂單 ${esc(orderId)}</title>
<style>
body { font-family: 'Microsoft JhengHei', Arial, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
.wrap { max-width: 700px; margin: 0 auto; padding: 20px; }
.section { background: white; padding: 24px; border-radius: 12px; margin-bottom: 16px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
.section h2 { margin: 0 0 16px; font-size: 18px; display: flex; gap: 12px; align-items: center; }
.readonly { background: #f9f9f9; padding: 12px; border-radius: 6px; font-size: 14px; color: #666; }
.field { margin-bottom: 14px; }
.field label { display: block; font-weight: bold; font-size: 13px; margin-bottom: 6px; color: #333; }
.field input, .field select, .field textarea { width: 100%; padding: 10px 12px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; font-family: inherit; }
.field textarea { min-height: 60px; resize: vertical; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px; border-bottom: 1px solid #eee; }
th { background: #fafafa; text-align: left; color: #666; }
.notice { background: #fff3cd; color: #856404; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; }
.actions { display: flex; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
.btn { padding: 12px 24px; border: none; border-radius: 8px; font-size: 15px; font-weight: bold; cursor: pointer; text-decoration: none; display: inline-block; color: white; }
.btn-save { background: #28a745; }
.btn-cancel-order { background: #E11D48; }
.btn-back { background: #666; }
.type-badge { background: #0055aa; color: white; padding: 3px 10px; border-radius: 4px; font-size: 13px; }
</style>
<script>
function confirmCancel(form) {
    const reason = prompt('取消原因 (會一併寄給助理)：');
    if (reason === null) return false;
    form.cancelReason.value = reason;
    form.action_.value = 'cancel';
    return confirm('確定要取消此訂單嗎？此動作會通知助理。');
}
</script>
</head><body>
<div class="wrap">

<div class="section">
    <h2><span class="type-badge">${esc(isRma ? '派車單' : isSample ? '借樣品' : orderId.startsWith('BCH') ? '行動屋' : '訂單')}</span> 編輯 ${esc(orderId)}</h2>
    <div class="readonly">
        <strong>客戶：</strong>【${esc(c.customerCode || '未建檔')}】${esc(c.company || '-')}
    </div>
</div>

<div class="section">
    <h2>🛒 商品明細 (不可修改)</h2>
    <div class="notice">⚠️ 如需修改品項/數量/單價，請使用下方「取消訂單」按鈕取消後，重新用 LINE 下單。</div>
    <table>
        <thead><tr><th>型號</th><th style="text-align:right">數量</th>${isRma ? '' : '<th style="text-align:right">單價</th>'}</tr></thead>
        <tbody>${itemRows || '<tr><td colspan="3" style="text-align:center;color:#888;padding:20px">無明細</td></tr>'}</tbody>
    </table>
    ${!isRma && data.totalAmount ? `<p style="text-align:right;margin-top:12px"><strong>總計：$${data.totalAmount}</strong> (運費 ${data.shippingFee > 0 ? '$' + data.shippingFee : '免運'})</p>` : ''}
</div>

<form method="POST" action="">
    <input type="hidden" name="action" id="action_">
    <input type="hidden" name="token" value="${esc(token)}">
    <input type="hidden" name="orderId" value="${esc(orderId)}">
    <input type="hidden" name="cancelReason" value="">

    <div class="section">
        <h2>✏️ 收件資訊</h2>
        <div class="field"><label>收件人</label><input name="name" value="${esc(c.name || '')}"></div>
        <div class="field"><label>聯絡電話</label><input name="phone" value="${esc(c.phone || '')}"></div>
        <div class="field"><label>送貨地址</label><input name="address" value="${esc(c.address || '')}"></div>
    </div>

    ${!isRma ? `
    <div class="section">
        <h2>🚚 物流 / 時程</h2>
        <div class="field">
            <label>物流方式</label>
            <select name="logistics">
                <option value=""${!c.logistics ? ' selected' : ''}>未指定</option>
                ${['大榮貨運', '郵局', '專車', '自取'].map(opt => `<option value="${opt}"${c.logistics === opt ? ' selected' : ''}>${opt}</option>`).join('')}
            </select>
        </div>
        ${isSample ? `
            <div class="field"><label>借樣案名</label><input name="projectName" value="${esc(c.projectName || '')}"></div>
            <div class="field"><label>預計歸還</label><input name="returnDate" value="${esc(c.returnDate || '')}" placeholder="2026/05/31"></div>
        ` : `
            <div class="field"><label>預期到貨</label><input name="deliveryTime" value="${esc(c.deliveryTime || '')}" placeholder="例：5/15、下週三"></div>
        `}
    </div>
    ` : ''}

    <div class="section">
        <h2>📝 備註</h2>
        <div class="field"><textarea name="remark">${esc(c.remark || '')}</textarea></div>
    </div>

    <div class="section">
        <div class="actions">
            <button type="submit" class="btn btn-save" onclick="document.getElementById('action_').value='save'">💾 儲存變更</button>
            <button type="submit" class="btn btn-cancel-order" onclick="return confirmCancel(this.form)">❌ 取消訂單</button>
            <a class="btn btn-back" href="javascript:history.back()">← 返回</a>
        </div>
    </div>
</form>

</div>
</body></html>`;

        res.set('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        console.error('[orderEdit GET]', err);
        res.status(500).send(`<h2>Error: ${err.message}</h2>`);
    }
});

// --- 訂單明細頁 (HTML，顯示單筆完整內容) ---
exports.orderDetail = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const token = req.query.token;
    const expected = process.env.DASHBOARD_TOKEN || 'KinyoDash2026!pQ7wN';
    if (!token || token !== expected) {
        return res.status(401).send('<h2>⛔ Unauthorized</h2>');
    }

    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).send('<h2>缺少訂單編號</h2>');

    try {
        const doc = await db.collection('PendingOrders').doc(orderId).get();
        if (!doc.exists) return res.status(404).send('<h2>找不到訂單</h2>');
        const data = doc.data();

        const toDate = (ts) => {
            if (!ts) return null;
            if (typeof ts.toDate === 'function') return ts.toDate();
            if (ts._seconds) return new Date(ts._seconds * 1000);
            return null;
        };
        const fmtDate = (d) => {
            if (!d) return '-';
            const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
            return `${tw.getUTCFullYear()}-${String(tw.getUTCMonth()+1).padStart(2,'0')}-${String(tw.getUTCDate()).padStart(2,'0')} ${String(tw.getUTCHours()).padStart(2,'0')}:${String(tw.getUTCMinutes()).padStart(2,'0')}`;
        };
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const getType = (id) => id.startsWith('SMP') ? '借樣品' : id.startsWith('RMA') ? '派車單' : id.startsWith('BCH') ? '行動屋' : '訂單';

        const type = getType(orderId);
        const c = data.customer || {};
        const itemsList = Array.isArray(data.items) ? data.items : (Array.isArray(data.orderItems) ? data.orderItems : []);
        const status = data.status || '';

        // 類型決定項目欄位
        const isRma = orderId.startsWith('RMA');
        const isSample = orderId.startsWith('SMP');

        // 計算 row 用
        let totalQty = 0;
        let totalAmount = 0;
        const itemRows = itemsList.map(it => {
            const model = esc(it.model || '');
            const qty = Number(it.qty || it.quantity || 0);
            const price = Number(it.unitPrice || it.price || 0);
            const subtotal = Number(it.subtotal) || (qty * price);
            totalQty += qty;
            if (subtotal > 0) totalAmount += subtotal;
            const boxNote = it.origBoxes ? `<span style="color:#888">(${it.origBoxes}${it.unit}×${it.cartonQty})</span>` : '';
            const priceMark = it.fixedPrice ? '🔒 固定' : (it.autoPriced ? '🔒 自動' : '');
            const reason = it.reason ? ` <span style="color:#E11D48; font-size:12px">${esc(it.reason)}</span>` : '';
            return `<tr>
                <td>${model}${boxNote}${reason}</td>
                <td class="num">${qty}</td>
                ${isRma ? '' : `<td class="num">${price > 0 ? '$' + price : '-'} <span style="font-size:11px; color:#888">${priceMark}</span></td>`}
                ${isRma ? '' : `<td class="num">${subtotal > 0 ? '$' + subtotal : '-'}</td>`}
            </tr>`;
        }).join('');

        const shipBtn = isRma
            ? `https://asia-east1-kinyo-price.cloudfunctions.net/markRMACompleted?rmaId=${encodeURIComponent(orderId)}`
            : `https://asia-east1-kinyo-price.cloudfunctions.net/markOrderShipped?orderId=${encodeURIComponent(orderId)}`;
        const exceptionUrl = `https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${encodeURIComponent(orderId)}`;

        const isProcessed = ['已出貨', '處理中_已發送異常通知', '處理完成_已派車'].includes(status);
        const statusColor = isProcessed ? '#1DB446' : '#F59E0B';

        const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(orderId)} - 訂單明細</title>
<style>
body { font-family: 'Microsoft JhengHei', Arial, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
.wrap { max-width: 900px; margin: 0 auto; padding: 20px; }
.header { background: white; padding: 24px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
.header h1 { margin: 0; font-size: 22px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.type-badge { background: #0055aa; color: white; padding: 4px 10px; border-radius: 6px; font-size: 14px; }
.status-badge { padding: 4px 12px; border-radius: 6px; font-size: 14px; color: white; background: ${statusColor}; }
.meta { color: #888; font-size: 13px; margin-top: 8px; }

.section { background: white; border-radius: 12px; padding: 20px 24px; margin-bottom: 20px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
.section h2 { margin: 0 0 16px; font-size: 16px; color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px; }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 10px 16px; font-size: 14px; }
.kv .k { color: #888; }
.kv .v { color: #222; }
.kv .v.highlight { color: #E11D48; font-weight: bold; }

table { width: 100%; border-collapse: collapse; font-size: 14px; margin-top: 8px; }
th, td { padding: 10px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #fafafa; font-size: 13px; color: #666; }
td.num { text-align: right; }
tfoot td { font-weight: bold; background: #fffbea; }

.actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
.btn { display: inline-block; padding: 12px 24px; border-radius: 8px; text-decoration: none; color: white; font-weight: bold; font-size: 14px; }
.btn-ship { background: #28a745; }
.btn-edit { background: #0055aa; }
.btn-cancel-order { background: #E11D48; }
.btn-warn { background: #F59E0B; }
.btn-back { background: #666; }
.btn:hover { opacity: 0.9; }

.note { background: #fff3cd; color: #856404; padding: 10px 14px; border-radius: 6px; font-size: 13px; margin-top: 12px; }
</style></head><body>
<div class="wrap">

<div class="header">
    <h1>
        <span class="type-badge">${esc(type)}</span>
        ${esc(orderId)}
        <span class="status-badge">${esc(status)}</span>
    </h1>
    <div class="meta">
        建立時間：${fmtDate(toDate(data.createdAt))}
        ${data.shippedAt ? ' | 出貨時間：' + fmtDate(toDate(data.shippedAt)) : ''}
        ${data.backfilledAt ? ' | <span style="color:#888">※ 歷史資料 backfill</span>' : ''}
    </div>
</div>

<div class="section">
    <h2>🏢 客戶資訊</h2>
    <div class="kv">
        <div class="k">客戶編號</div><div class="v">${esc(c.customerCode || '未建檔')}</div>
        <div class="k">採購公司</div><div class="v">${esc(c.company || '-')}</div>
        <div class="k">收件人</div><div class="v">${esc(c.name || '-')}${c.hasOverride ? ' <span style="color:#E11D48">(指定)</span>' : ''}</div>
        <div class="k">聯絡電話</div><div class="v">${esc(c.phone || '-')}</div>
        <div class="k">送貨地址</div><div class="v ${c.hasOverride ? 'highlight' : ''}">${esc(c.address || '-')}</div>
        ${c.projectName ? `<div class="k">借樣案名</div><div class="v highlight">${esc(c.projectName)}</div>` : ''}
        ${c.returnDate ? `<div class="k">預計歸還</div><div class="v highlight">${esc(c.returnDate)}</div>` : ''}
        ${c.deliveryTime ? `<div class="k">預期到貨</div><div class="v">${esc(c.deliveryTime)}</div>` : ''}
        ${c.logistics ? `<div class="k">物流方式</div><div class="v">${esc(c.logistics)}</div>` : ''}
        ${data.tracking ? `<div class="k">物流單號</div><div class="v" style="font-family:monospace">${esc(data.tracking)}</div>` : ''}
        ${c.remark ? `<div class="k">備註</div><div class="v">${esc(c.remark)}</div>` : ''}
    </div>
</div>

<div class="section">
    <h2>🛒 ${isRma ? '不良品明細' : isSample ? '樣品明細' : '商品明細'}</h2>
    <table>
        <thead><tr>
            <th>型號</th>
            <th style="text-align:right">數量</th>
            ${isRma ? '' : '<th style="text-align:right">單價</th><th style="text-align:right">小計</th>'}
        </tr></thead>
        <tbody>${itemRows || '<tr><td colspan="4" style="text-align:center; color:#888; padding:20px">無明細</td></tr>'}</tbody>
        ${!isRma && itemsList.length > 0 ? `
        <tfoot>
            <tr>
                <td colspan="${isRma ? 1 : 2}" style="text-align:right">運費</td>
                ${isRma ? '' : `<td colspan="2" class="num">${data.shippingFee > 0 ? '$' + data.shippingFee : '免運'}</td>`}
            </tr>
            <tr>
                <td colspan="${isRma ? 1 : 2}" style="text-align:right; color:#E11D48">總計</td>
                ${isRma ? '' : `<td colspan="2" class="num" style="color:#E11D48; font-size:16px">${data.totalAmount > 0 ? '$' + data.totalAmount : '待確認'}</td>`}
            </tr>
        </tfoot>` : ''}
    </table>
    <div style="margin-top:8px; font-size:12px; color:#888">共 ${itemsList.length} 項 ${isRma ? '' : `/ ${totalQty} 件`}</div>
</div>

${data.exceptionMessage ? `
<div class="section" style="border-left: 4px solid #F59E0B;">
    <h2>⚠️ 異常通知</h2>
    <div style="white-space:pre-wrap; color:#856404">${esc(data.exceptionMessage)}</div>
    ${data.exceptionNotifiedAt ? `<div class="meta" style="margin-top:8px">通知時間：${fmtDate(toDate(data.exceptionNotifiedAt))}</div>` : ''}
</div>` : ''}

${!isProcessed ? `
<div class="section">
    <h2>⚡ 動作</h2>
    <div class="actions">
        <a class="btn btn-ship" href="${shipBtn}" target="_blank">${isRma ? '✅ 派車完成' : '✅ 出貨並填物流單號'}</a>
        <a class="btn btn-edit" href="https://asia-east1-kinyo-price.cloudfunctions.net/orderEdit?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}" target="_blank">✏️ 修改訂單</a>
        <a class="btn btn-cancel-order" href="https://asia-east1-kinyo-price.cloudfunctions.net/orderCancel?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}" target="_blank">❌ 取消訂單</a>
        <a class="btn btn-warn" href="${exceptionUrl}" target="_blank">⚠️ 通知客戶異常</a>
    </div>
</div>` : `
<div class="section" style="background: #d4edda; color: #155724;">
    ✅ 此訂單已於 ${fmtDate(toDate(data.shippedAt)) || '-'} 完成處理
</div>`}

<div class="actions">
    <a class="btn btn-back" href="javascript:history.back()">← 返回</a>
</div>

</div>
</body></html>`;

        res.set('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        console.error('[orderDetail]', err);
        res.status(500).send(`<h2>Error: ${err.message}</h2>`);
    }
});

// --- 訂單狀況 Dashboard (HTML 頁面, 需要 token) ---
exports.orderDashboard = functions.region('asia-east1').https.onRequest(async (req, res) => {
    const token = req.query.token;
    const expected = process.env.DASHBOARD_TOKEN || 'KinyoDash2026!pQ7wN';
    if (!token || token !== expected) {
        return res.status(401).send('<h2>⛔ Unauthorized</h2>');
    }

    try {
        const PENDING = ['處理中', '處理中_借樣品', '處理中_來回件', '處理中_批次'];
        const PROCESSED = ['已出貨', '處理中_已發送異常通知', '處理完成_已派車'];

        const [pendSnap, procSnap, reserveSnap] = await Promise.all([
            db.collection('PendingOrders').where('status', 'in', PENDING).get(),
            db.collection('PendingOrders').where('status', 'in', PROCESSED).get(),
            db.collection('ReservedOrders').where('status', '==', 'active').get(),
        ]);

        const toDate = (ts) => {
            if (!ts) return null;
            if (typeof ts.toDate === 'function') return ts.toDate();
            if (ts._seconds) return new Date(ts._seconds * 1000);
            return null;
        };
        const fmtDate = (d) => {
            if (!d) return '';
            const tw = new Date(d.getTime() + 8 * 60 * 60 * 1000);
            return `${tw.getUTCFullYear()}-${String(tw.getUTCMonth()+1).padStart(2,'0')}-${String(tw.getUTCDate()).padStart(2,'0')} ${String(tw.getUTCHours()).padStart(2,'0')}:${String(tw.getUTCMinutes()).padStart(2,'0')}`;
        };
        const getType = (id) => id.startsWith('SMP') ? '借樣品' : id.startsWith('RMA') ? '派車單' : id.startsWith('BCH') ? '行動屋' : '訂單';
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

        const now = Date.now();
        const rowify = (docs, mode) => docs.map(d => {
            const data = d.data();
            const id = d.id;
            const type = getType(id);
            const created = toDate(data.createdAt);
            const ageDays = created ? Math.floor((now - created.getTime()) / 86400000) : 0;
            const code = data.customer?.customerCode || '';
            const company = data.customer?.company || data.customer?.name || '';
            const amount = data.totalAmount || '';
            const status = data.status || '';
            const logistics = data.customer?.logistics || '';
            const tracking = data.tracking || '';
            const itemCount = Array.isArray(data.items) ? data.items.length : (Array.isArray(data.orderItems) ? data.orderItems.length : 0);
            return {
                id, type, code, company, amount, status, logistics, tracking, itemCount,
                createdAt: created, ageDays,
                _row: mode === 'pending' ? (ageDays >= 2 ? 'overdue' : (ageDays >= 1 ? 'warn' : 'fresh')) : 'done'
            };
        });

        const pendingRows = rowify(pendSnap.docs, 'pending').sort((a, b) => (a.createdAt?.getTime() || 0) - (b.createdAt?.getTime() || 0));
        const processedRows = rowify(procSnap.docs, 'processed').sort((a, b) => (b.createdAt?.getTime() || 0) - (a.createdAt?.getTime() || 0));

        // 保留訂單：計算剩餘天數（以台灣時區 00:00 為基準）
        const twNow = new Date(now + 8 * 60 * 60 * 1000);
        const todayUtc = Date.UTC(twNow.getUTCFullYear(), twNow.getUTCMonth(), twNow.getUTCDate());
        const reservedRows = reserveSnap.docs.map(d => {
            const data = d.data();
            const id = d.id;
            const created = toDate(data.createdAt);
            const code = data.customer?.customerCode || '';
            const company = data.customer?.company || data.customer?.name || '';
            const amount = data.totalAmount || '';
            const logistics = data.customer?.logistics || '';
            const itemCount = Array.isArray(data.orderItems) ? data.orderItems.length : (Array.isArray(data.items) ? data.items.length : 0);
            const deadlineStr = data.reserveDeadline || '';
            let daysLeft = null;
            if (deadlineStr) {
                const [y, m, dd] = String(deadlineStr).replace(/\//g, '-').split('-').map(Number);
                if (y && m && dd) {
                    daysLeft = Math.round((Date.UTC(y, m - 1, dd) - todayUtc) / 86400000);
                }
            }
            let cls = 'fresh';
            if (daysLeft !== null) {
                if (daysLeft < 0) cls = 'overdue';
                else if (daysLeft <= 7) cls = 'warn';
            }
            return { id, code, company, amount, logistics, itemCount, deadlineStr, daysLeft, createdAt: created, _row: cls };
        }).sort((a, b) => {
            if (a.daysLeft === null && b.daysLeft === null) return 0;
            if (a.daysLeft === null) return 1;
            if (b.daysLeft === null) return -1;
            return a.daysLeft - b.daysLeft;
        });

        // 計算已處理的所有月份 (台灣時區 YYYY-MM)
        const monthSet = new Set();
        for (const r of processedRows) {
            if (!r.createdAt) continue;
            const tw = new Date(r.createdAt.getTime() + 8 * 60 * 60 * 1000);
            const ym = `${tw.getUTCFullYear()}-${String(tw.getUTCMonth() + 1).padStart(2, '0')}`;
            monthSet.add(ym);
        }
        const sortedMonths = Array.from(monthSet).sort().reverse();
        const currentTw = new Date(Date.now() + 8 * 60 * 60 * 1000);
        const currentYm = `${currentTw.getUTCFullYear()}-${String(currentTw.getUTCMonth() + 1).padStart(2, '0')}`;

        const overdueCount = pendingRows.filter(r => r._row === 'overdue').length;
        const warnCount = pendingRows.filter(r => r._row === 'warn').length;

        const detailUrl = (id) => `https://asia-east1-kinyo-price.cloudfunctions.net/orderDetail?orderId=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
        const renderPendingRow = (r) => `
            <tr class="${r._row}">
                <td>${esc(r.type)}</td>
                <td class="id"><a href="${detailUrl(r.id)}" target="_blank">${esc(r.id)}</a></td>
                <td>${esc(r.code)}</td>
                <td class="company">${esc(r.company)}</td>
                <td class="num">${r.amount ? '$' + r.amount : '-'}</td>
                <td>${esc(r.logistics || '-')}</td>
                <td class="num">${r.itemCount}</td>
                <td>${esc(r.status)}</td>
                <td class="date">${fmtDate(r.createdAt)}</td>
                <td class="num age">${r.ageDays} 天${r._row === 'overdue' ? ' 🔴' : r._row === 'warn' ? ' 🟡' : ''}</td>
                <td class="actions">
                    <a class="btn btn-ship" href="https://asia-east1-kinyo-price.cloudfunctions.net/${r.id.startsWith('RMA') ? 'markRMACompleted?rmaId=' : 'markOrderShipped?orderId='}${encodeURIComponent(r.id)}" target="_blank">出貨</a>
                    <a class="btn btn-edit" href="https://asia-east1-kinyo-price.cloudfunctions.net/orderEdit?orderId=${encodeURIComponent(r.id)}&token=${encodeURIComponent(token)}" target="_blank">修改</a>
                    <a class="btn btn-cancel-order" href="https://asia-east1-kinyo-price.cloudfunctions.net/orderCancel?orderId=${encodeURIComponent(r.id)}&token=${encodeURIComponent(token)}" target="_blank">取消</a>
                    <a class="btn btn-warn" href="https://asia-east1-kinyo-price.cloudfunctions.net/orderExceptionForm?orderId=${encodeURIComponent(r.id)}" target="_blank">異常</a>
                </td>
            </tr>
        `;

        const renderProcessedRow = (r) => `
            <tr>
                <td>${esc(r.type)}</td>
                <td class="id"><a href="${detailUrl(r.id)}" target="_blank">${esc(r.id)}</a></td>
                <td>${esc(r.code)}</td>
                <td class="company">${esc(r.company)}</td>
                <td class="num">${r.amount ? '$' + r.amount : '-'}</td>
                <td>${esc(r.logistics || '-')}</td>
                <td>${esc(r.tracking || '-')}</td>
                <td>${esc(r.status)}</td>
                <td class="date">${fmtDate(r.createdAt)}</td>
            </tr>
        `;

        const renderReservedRow = (r) => `
            <tr class="${r._row}">
                <td class="id">${esc(r.id)}</td>
                <td>${esc(r.code)}</td>
                <td class="company">${esc(r.company)}</td>
                <td class="num">${r.amount ? '$' + r.amount : '-'}</td>
                <td>${esc(r.logistics || '-')}</td>
                <td class="num">${r.itemCount}</td>
                <td class="date">${esc(r.deadlineStr || '-')}</td>
                <td class="num age">${r.daysLeft === null ? '-' : r.daysLeft + ' 天'}${r._row === 'overdue' ? ' 🔴' : r._row === 'warn' ? ' 🟡' : ''}</td>
                <td class="date">${fmtDate(r.createdAt)}</td>
                <td class="actions">
                    <button type="button" class="toggle-btn" data-rsv="${esc(r.id)}" onclick="markReserveDone(this)" title="點一下標記為已完成"></button>
                    <span class="toggle-label">未完成</span>
                </td>
            </tr>
        `;

        const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>KINYO 訂單狀況儀表板</title>
<style>
body { font-family: 'Microsoft JhengHei', Arial, sans-serif; margin: 0; background: #f5f5f5; color: #222; }
.wrap { max-width: 1400px; margin: 0 auto; padding: 20px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.subtitle { color: #888; margin-bottom: 24px; font-size: 13px; }
.summary { display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
.card { background: white; padding: 16px 20px; border-radius: 12px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); flex: 1; min-width: 180px; }
.card h3 { margin: 0 0 6px; font-size: 13px; color: #666; font-weight: normal; }
.card .num { font-size: 28px; font-weight: bold; }
.card.red { border-left: 4px solid #E11D48; }
.card.yellow { border-left: 4px solid #F59E0B; }
.card.green { border-left: 4px solid #1DB446; }
.card.indigo { border-left: 4px solid #6366F1; }
.card.red .num { color: #E11D48; }
.card.yellow .num { color: #F59E0B; }
.card.green .num { color: #1DB446; }
.card.indigo .num { color: #6366F1; }

.section { background: white; border-radius: 12px; padding: 20px; margin-bottom: 24px; box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
.section h2 { margin: 0 0 16px; font-size: 18px; display: flex; align-items: center; gap: 10px; }
.filter-bar { margin-bottom: 12px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 13px; }
.filter-bar input, .filter-bar select { padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
.filter-bar label { color: #666; }

table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid #eee; }
th { background: #fafafa; font-weight: bold; color: #333; font-size: 12px; position: sticky; top: 0; }
tr.overdue { background: #fff0f3; }
tr.warn { background: #fffaf0; }
tr.overdue:hover, tr.warn:hover, tr:hover { background: #f0f4fa; }
td.num { text-align: right; }
td.id a { color: #0055aa; text-decoration: none; font-family: monospace; }
td.id a:hover { text-decoration: underline; }
td.date { color: #666; font-size: 12px; white-space: nowrap; }
td.age { font-weight: bold; white-space: nowrap; }
td.company { max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
td.actions { white-space: nowrap; }
.btn { display: inline-block; padding: 4px 10px; border-radius: 4px; text-decoration: none; color: white; font-size: 12px; margin-right: 4px; }
.btn-ship { background: #28a745; }
.btn-edit { background: #0055aa; }
.btn-cancel-order { background: #E11D48; }
.btn-warn { background: #F59E0B; }
.toggle-btn { display: inline-block; width: 44px; height: 24px; background: #ccc; border-radius: 12px; position: relative; cursor: pointer; transition: background 0.25s; border: none; padding: 0; vertical-align: middle; }
.toggle-btn::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; background: white; border-radius: 50%; transition: left 0.25s; box-shadow: 0 1px 2px rgba(0,0,0,0.2); }
.toggle-btn.on { background: #28a745; }
.toggle-btn.on::after { left: 22px; }
.toggle-btn:disabled { cursor: not-allowed; opacity: 0.7; }
.toggle-label { font-size: 12px; color: #888; margin-left: 6px; vertical-align: middle; }
.empty { padding: 40px; text-align: center; color: #888; }
.refresh-btn { margin-left: auto; padding: 6px 14px; background: #0055aa; color: white; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
</style></head><body>
<div class="wrap">
<h1>📊 KINYO 訂單狀況儀表板</h1>
<div class="subtitle">更新時間：${fmtDate(new Date())} <button class="refresh-btn" onclick="location.reload()">🔄 重新整理</button></div>

<div class="summary">
    <div class="card red"><h3>🔴 超時 (≥ 2 天)</h3><div class="num">${overdueCount}</div></div>
    <div class="card yellow"><h3>🟡 接近超時 (1-2 天)</h3><div class="num">${warnCount}</div></div>
    <div class="card"><h3>📋 待處理合計</h3><div class="num">${pendingRows.length}</div></div>
    <div class="card indigo"><h3>📌 預留中</h3><div class="num">${reservedRows.length}</div></div>
    <div class="card green"><h3>✅ 已處理 (歷史累計)</h3><div class="num">${processedRows.length}</div></div>
</div>

<div class="section">
    <h2>📌 預留訂單 <span style="color:#888; font-size:13px; font-weight:normal;">(${reservedRows.length} 筆，快到期的在上)</span></h2>
    <div class="filter-bar">
        <label>搜尋：</label>
        <input id="rsv-q" placeholder="客戶 / 編號..." oninput="filterTable('rsv')">
    </div>
    ${reservedRows.length === 0 ? '<div class="empty">目前無進行中的預留訂單</div>' : `
    <table id="rsv-table">
        <thead><tr>
            <th>編號</th><th>客戶編號</th><th>客戶</th><th>金額</th><th>物流</th><th>項目</th><th>預留期限</th><th>剩餘</th><th>建立時間</th><th>動作</th>
        </tr></thead>
        <tbody>${reservedRows.map(renderReservedRow).join('')}</tbody>
    </table>`}
</div>

<div class="section">
    <h2>📋 待處理 <span style="color:#888; font-size:13px; font-weight:normal;">(${pendingRows.length} 筆，舊的在上)</span></h2>
    <div class="filter-bar">
        <label>類型：</label>
        <select id="pend-type" onchange="filterTable('pend')">
            <option value="">全部</option><option>訂單</option><option>借樣品</option><option>派車單</option><option>行動屋</option>
        </select>
        <label>搜尋：</label>
        <input id="pend-q" placeholder="客戶 / 編號..." oninput="filterTable('pend')">
    </div>
    ${pendingRows.length === 0 ? '<div class="empty">✅ 全部處理完畢，辛苦了！</div>' : `
    <table id="pend-table">
        <thead><tr>
            <th>類型</th><th>編號</th><th>客戶編號</th><th>客戶</th><th>金額</th><th>物流</th><th>項目</th><th>狀態</th><th>建立時間</th><th>天數</th><th>動作</th>
        </tr></thead>
        <tbody>${pendingRows.map(renderPendingRow).join('')}</tbody>
    </table>`}
</div>

<div class="section">
    <h2>✅ 已處理 <span style="color:#888; font-size:13px; font-weight:normal;">(${processedRows.length} 筆，新的在上)</span></h2>
    <div class="filter-bar">
        <label>月份：</label>
        <select id="proc-month" onchange="pickMonth()">
            <option value="">全部</option>
            ${sortedMonths.map(m => `<option value="${m}"${m === currentYm ? ' selected' : ''}>${m}</option>`).join('')}
        </select>
        <label>類型：</label>
        <select id="proc-type" onchange="filterTable('proc')">
            <option value="">全部</option><option>訂單</option><option>借樣品</option><option>派車單</option><option>行動屋</option>
        </select>
        <label>狀態：</label>
        <select id="proc-status" onchange="filterTable('proc')">
            <option value="">全部</option><option>已出貨</option><option>處理中_已發送異常通知</option><option>處理完成_已派車</option>
        </select>
        <label>自訂從：</label>
        <input id="proc-from" type="date" onchange="filterTable('proc')">
        <label>到：</label>
        <input id="proc-to" type="date" onchange="filterTable('proc')">
        <label>搜尋：</label>
        <input id="proc-q" placeholder="客戶 / 編號 / 單號..." oninput="filterTable('proc')">
    </div>
    ${processedRows.length === 0 ? '<div class="empty">尚無已處理訂單</div>' : `
    <table id="proc-table">
        <thead><tr>
            <th>類型</th><th>編號</th><th>客戶編號</th><th>客戶</th><th>金額</th><th>物流</th><th>物流單號</th><th>狀態</th><th>建立時間</th>
        </tr></thead>
        <tbody>${processedRows.map(renderProcessedRow).join('')}</tbody>
    </table>`}
</div>

</div>
<script>
function pickMonth() {
    const m = document.getElementById('proc-month').value;
    const fromEl = document.getElementById('proc-from');
    const toEl = document.getElementById('proc-to');
    if (!m) {
        fromEl.value = '';
        toEl.value = '';
    } else {
        const [y, mo] = m.split('-');
        const lastDay = new Date(parseInt(y), parseInt(mo), 0).getDate();
        fromEl.value = m + '-01';
        toEl.value = m + '-' + String(lastDay).padStart(2, '0');
    }
    filterTable('proc');
}
// 頁面載入時若 select 已有預設值 (current month)，自動套用日期範圍
window.addEventListener('DOMContentLoaded', () => {
    const monthSel = document.getElementById('proc-month');
    if (monthSel && monthSel.value) pickMonth();
});

async function markReserveDone(btn) {
    if (btn.disabled) return;
    const rsvId = btn.dataset.rsv;
    if (!rsvId) return;
    btn.disabled = true;
    btn.classList.add('on');
    const label = btn.parentElement.querySelector('.toggle-label');
    if (label) { label.textContent = '已完成'; label.style.color = '#28a745'; }
    try {
        const resp = await fetch('https://asia-east1-kinyo-price.cloudfunctions.net/markReserveCompleted?reserveId=' + encodeURIComponent(rsvId), { method: 'POST' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const tr = btn.closest('tr');
        const countCard = document.querySelector('.card.indigo .num');
        if (countCard) countCard.textContent = Math.max(0, (parseInt(countCard.textContent, 10) || 0) - 1);
        setTimeout(() => {
            tr.style.transition = 'opacity 0.5s';
            tr.style.opacity = '0';
            setTimeout(() => tr.remove(), 500);
        }, 400);
    } catch (e) {
        alert('標記失敗：' + e.message + '\n請重試或聯絡管理員');
        btn.classList.remove('on');
        btn.disabled = false;
        if (label) { label.textContent = '未完成'; label.style.color = ''; }
    }
}

function filterTable(prefix) {
    const tbl = document.getElementById(prefix + '-table');
    if (!tbl) return;
    const qEl = document.getElementById(prefix + '-q');
    const typeEl = document.getElementById(prefix + '-type');
    const q = (qEl && qEl.value || '').toLowerCase();
    const typeSel = typeEl ? typeEl.value : '';
    const statusSel = prefix === 'proc' ? (document.getElementById('proc-status').value || '') : '';
    const fromD = prefix === 'proc' ? (document.getElementById('proc-from').value || '') : '';
    const toD = prefix === 'proc' ? (document.getElementById('proc-to').value || '') : '';

    for (const tr of tbl.querySelectorAll('tbody tr')) {
        const cells = Array.from(tr.cells).map(c => c.textContent);
        const rowText = cells.join('|').toLowerCase();

        let show = true;
        if (typeSel) {
            const rowType = cells[0];
            if (rowType !== typeSel) show = false;
        }
        if (q && !rowText.includes(q)) show = false;
        if (prefix === 'proc') {
            const rowStatus = cells[7];
            const rowDate = (cells[8] || '').substring(0, 10);
            if (statusSel && rowStatus !== statusSel) show = false;
            if (fromD && rowDate < fromD) show = false;
            if (toD && rowDate > toD) show = false;
        }
        tr.style.display = show ? '' : 'none';
    }
}
</script>
</body></html>`;

        res.set('Cache-Control', 'no-store');
        res.send(html);
    } catch (err) {
        console.error('[orderDashboard]', err);
        res.status(500).send(`<h2>Error: ${err.message}</h2>`);
    }
});

exports.testQueryKH198 = functions.https.onRequest(async (req, res) => {
    try {
        const modelId = req.query.model || 'KH198';
        const col = req.query.col || 'ProductImages';
        const docSnap = await db.collection(col).doc(modelId).get();
        if (docSnap.exists) {
            res.status(200).json(docSnap.data());
        } else {
            // 嘗試搜尋
            const snap = await db.collection(col).where('model', '==', modelId).limit(1).get();
            if (!snap.empty) {
                res.status(200).json({ _docId: snap.docs[0].id, ...snap.docs[0].data() });
            } else {
                res.status(404).json({ error: "Not found", collection: col, model: modelId });
            }
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── 圖片同步：從 kinyo.tw 抓商品首圖寫入 ProductImages ──
exports.syncProductImages = functions
    .region('asia-east1')
    .runWith({ timeoutSeconds: 540, memory: '512MB' })
    .https.onRequest(async (req, res) => {
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

        // Token 驗證
        const token = req.query.token || req.body?.token || '';
        if (token !== process.env.SYNC_TOKEN) {
            res.status(403).json({ error: 'Invalid token' });
            return;
        }

        const force = req.query.force === 'true' || req.body?.force === true;
        try {
            const { syncImages } = require('./src/services/imageSync');
            const results = await syncImages({ force });
            res.status(200).json({
                success: true,
                message: `圖片同步完成：${results.created} 新建、${results.updated} 更新、${results.skipped} 已有圖跳過、${results.notFound} 找不到`,
                ...results
            });
        } catch (e) {
            console.error('syncProductImages error:', e);
            res.status(500).json({ error: e.message });
        }
    });

