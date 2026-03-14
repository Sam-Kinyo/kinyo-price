const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { setGlobalDispatcher, ProxyAgent } = require('undici');
const { line, messagingApi } = require('@line/bot-sdk');
const { GoogleGenAI } = require('@google/genai');

admin.initializeApp();
const db = admin.firestore();

// --- 環境變數與設定 ---
// 根據 Firebase Functions v3+ 官方規範，.env 檔案的變數會在中介層自動掛載進 process.env
const modelData = require('./modelData.json');

// --- Helper Functions ---
function getImageUrl(model) {
    if (!model) return 'https://via.placeholder.com/400?text=No+Image';
    const cleanModel = model.trim().toUpperCase();
    const found = modelData.models.find(m => m.mainModel && m.mainModel.toUpperCase() === cleanModel);
    if (found && found.mainImage) {
        const fileIdMatch = found.mainImage.match(/id=([a-zA-Z0-9_-]+)/) || found.mainImage.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
        if (fileIdMatch && fileIdMatch[1]) {
            return `https://images.weserv.nl/?url=drive.google.com/uc?export=view&id=${fileIdMatch[1]}&w=400`;
        }
    }
    return 'https://via.placeholder.com/400?text=No+Image';
}

function calculatePrice(cost, divisor) {
    return Math.ceil((cost / divisor) * 1.05);
}
const getConfig = () => ({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    geminiApiKey: process.env.GEMINI_API_KEY
});

// 定義 Gemini Function Calling 結構限制
const parseIntentTool = {
    functionDeclarations: [
        {
            name: "parse_user_intent",
            description: "解析使用者的商品搜尋與報價查詢意圖",
            parameters: {
                type: "OBJECT",
                properties: {
                    keyword: {
                        type: "STRING",
                        description: "使用者想要搜尋的商品型號或名稱 (例如：KPB-2990, 吹風機)。若無則為空。"
                    },
                    target_qty: {
                        type: "INTEGER",
                        description: "使用者預計購買的數量。純數字，無則為空。"
                    },
                    target_budget: {
                        type: "INTEGER",
                        description: "使用者指定的預算上限，純數字，無則為空。"
                    },
                    min_stock: {
                        type: "INTEGER",
                        description: "使用者要求的最低安全庫存量限制，純數字，無則為空。"
                    }
                },
                required: []
            }
        }
    ]
};

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

    const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

    try {
        const events = req.body.events;
        if (!events || events.length === 0) {
            res.status(200).send('OK');
            return;
        }

        for (const event of events) {
            let userText = "";
            let lineUid = event.source.userId;
            const replyToken = event.replyToken;
            let simulatedLevel = null;
            let simulatedKeyword = null;

            if (event.type === 'message' && event.message.type === 'text') {
                userText = event.message.text.trim();
            } else if (event.type === 'postback') {
                const params = new URLSearchParams(event.postback.data);
                if (params.get('action') === 'simulate') {
                    simulatedLevel = parseInt(params.get('level'), 10);
                    simulatedKeyword = params.get('keyword');
                    userText = "模擬查詢"; // 用於日誌
                } else {
                    continue;
                }
            } else {
                continue;
            }

            // ---------------------------------------------------------
            // 模組 3 前置：權限驗證攔截
            // ---------------------------------------------------------
            console.log(`[驗證] 開始查找 LINE UID: ${lineUid}`);
            
            const usersRef = db.collection('Users');
            const snapshot = await usersRef.where('line_uid', '==', lineUid).limit(1).get();

            if (snapshot.empty) {
                console.log(`[權限阻擋] 查無此 LINE UID 綁定紀錄: ${lineUid}`);
                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: [{ type: 'text', text: '尚未綁定帳號或無查詢權限，請透過系統選單進行綁定。' }]
                });
                continue;
            }

            const userDoc = snapshot.docs[0];
            const userData = userDoc.data();
            const userEmail = userDoc.id;
            let level = parseInt(userData.level) || 0;
            const isVip = !!userData.vipColumn;
            
            if (level < 1 && !isVip) {
                console.log(`[權限阻擋] 帳號 ${userEmail} 權限不足 (Level: ${level}, VIP: ${isVip})`);
                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: [{ type: 'text', text: '權限不足，請聯絡管理員開通查詢權限。' }]
                });
                continue;
            }

            console.log(`✅ [權限通過] 用戶: ${userEmail} | 真實等級: ${level} | VIP: ${isVip}`);

            if (simulatedLevel && level === 4) {
                level = simulatedLevel;
                console.log(`[模擬模式] 將顯示層級切換為: Level ${level}`);
            }

            let intentParams = {
                keyword: simulatedKeyword || null,
                target_qty: null,
                target_budget: null,
                min_stock: null
            };

            if (event.type === 'message') {
                // ---------------------------------------------------------
                // 模組 2：呼叫 Gemini 解析意圖 (Function Calling)
                // ---------------------------------------------------------
                console.log(`[Gemini] 開始解析輸入文字: "${userText}"`);

                const prompt = `你是一個專業的商品查詢意圖萃取機器人。
主要任務：分析使用者的對話，並將其中的「關鍵字(商品名/型號)」、「數量」、「預算」、「庫存限制」萃取出來。
絕對限制：
1. 你「不可以」直接回答使用者的問題。
2. 你「不可以」幫使用者計算價格。
3. 你「必須」使用提供的 Function/Tool 來回傳 JSON 格式的結果。如果找不到對應參數就留空。
使用者輸入内容：「${userText}」`;

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                    config: {
                        tools: [parseIntentTool]
                    }
                });

                const parts = response.candidates?.[0]?.content?.parts || [];
                const functionCallPart = parts.find(p => p.functionCall);

                if (functionCallPart && functionCallPart.functionCall) {
                    const call = functionCallPart.functionCall;
                    if (call.name === 'parse_user_intent') {
                        intentParams = { ...intentParams, ...call.args };
                    }
                } else {
                    console.log(`[Gemini Warn] 模型未呼叫 Function。`);
                }

                console.log(`🧠 [Gemini 解析結果]`, JSON.stringify(intentParams, null, 2));
            }

            // ---------------------------------------------------------
            // 模組 3：拉取商品並進行 In-Memory Filter
            // ---------------------------------------------------------
            console.log(`[搜尋] 開始拉取 Firestore 商品資料...`);
            const productsSnapshot = await db.collection('Products').get();
            let products = productsSnapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(p => !p.status || p.status === 'active'); // 相容可能沒有 status 的舊資料

            // 過濾 keyword
            if (intentParams.keyword) {
                const kw = intentParams.keyword.toLowerCase();
                products = products.filter(p => 
                    (p.name && p.name.toLowerCase().includes(kw)) || 
                    (p.model && p.model.toLowerCase().includes(kw))
                );
            }

            // 過濾 min_stock
            if (intentParams.min_stock !== undefined && intentParams.min_stock !== null) {
                products = products.filter(p => parseInt(p.stock || 0) >= parseInt(intentParams.min_stock));
            }

            // 過濾 target_budget
            if (intentParams.target_budget !== undefined && intentParams.target_budget !== null) {
                const budget = parseInt(intentParams.target_budget);
                products = products.filter(p => {
                    const cost = parseInt(p.cost) || 0;
                    if (cost === 0) return false;
                    const lowestPossiblePrice = calculatePrice(cost, 0.89); 
                    return lowestPossiblePrice <= budget * 1.2; 
                });
            }

            // 最多取 10 筆符合 Carousel
            products = products.slice(0, 10);

            if (products.length === 0) {
                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: [{ type: 'text', text: '抱歉，依照您的條件找不到對應的商品。' }]
                });
                continue;
            }

            // ---------------------------------------------------------
            // 模組 4、5：組裝 Flex Message 與試算價格
            // ---------------------------------------------------------
            const bubbles = products.map(p => {
                const cost = parseInt(p.cost) || 0;
                const priceScale = [];
                
                if (level >= 1) {
                    let text50 = `50個: $${calculatePrice(cost, 0.73)}`;
                    let text100 = `100個: $${calculatePrice(cost, 0.76)}`;
                    
                    if (intentParams.target_qty && intentParams.target_qty >= 50 && intentParams.target_qty < 100) {
                        text50 = `🔥 ${text50}`;
                    } else if (intentParams.target_qty && intentParams.target_qty >= 100 && intentParams.target_qty < 300) {
                        text100 = `🔥 ${text100}`;
                    }
                    priceScale.push(text50);
                    priceScale.push(text100);
                }
                
                if (level >= 2) {
                    let text300 = `300個: $${calculatePrice(cost, 0.80)}`;
                    if (intentParams.target_qty && intentParams.target_qty >= 300 && intentParams.target_qty < 500) {
                        text300 = `🔥 ${text300}`;
                    }
                    priceScale.push(text300);
                }
                
                if (level >= 3) {
                    let text500 = `500個: $${calculatePrice(cost, 0.835)}`;
                    let text1000 = `1000個: $${calculatePrice(cost, 0.858)}`;
                    
                    if (intentParams.target_qty && intentParams.target_qty >= 500 && intentParams.target_qty < 1000) {
                        text500 = `🔥 ${text500}`;
                    } else if (intentParams.target_qty && intentParams.target_qty >= 1000 && intentParams.target_qty < 3000) {
                        text1000 = `🔥 ${text1000}`;
                    }
                    priceScale.push(text500);
                    priceScale.push(text1000);
                }
                
                if (level >= 4) {
                    let text3000 = `3000個: $${calculatePrice(cost, 0.89)}`;
                    if (intentParams.target_qty && intentParams.target_qty >= 3000) {
                        text3000 = `🔥 ${text3000}`;
                    }
                    priceScale.push(text3000);
                }

                const stockText = (level >= 3) ? `庫存: ${p.stock || 0}` : (parseInt(p.stock) > 0 ? '庫存: 充足' : '庫存: 缺貨');
                const imgUrl = getImageUrl(p.model);
                
                return {
                    type: "bubble",
                    hero: {
                        type: "image",
                        url: imgUrl,
                        size: "full",
                        aspectRatio: "1:1",
                        aspectMode: "cover",
                        action: { type: "uri", uri: imgUrl }
                    },
                    body: {
                        type: "box",
                        layout: "vertical",
                        contents: [
                            {
                                type: "text",
                                text: p.name || '未命名商品',
                                weight: "bold",
                                size: "xl",
                                wrap: true
                            },
                            {
                                type: "text",
                                text: `型號: ${p.model || '無'} | ${stockText}`,
                                size: "sm",
                                color: "#aaaaaa",
                                wrap: true
                            },
                            {
                                type: "separator",
                                margin: "md"
                            },
                            {
                                type: "box",
                                layout: "vertical",
                                margin: "md",
                                spacing: "sm",
                                contents: priceScale.map(str => ({
                                    type: "text",
                                    text: str,
                                    size: "sm",
                                    color: str.includes('🔥') ? "#ff0000" : "#666666",
                                    weight: str.includes('🔥') ? "bold" : "regular",
                                    wrap: true
                                }))
                            }
                        ]
                    }
                };
            });

            const messages = [{
                type: 'flex',
                altText: `為您尋找到 ${products.length} 筆商品報價`,
                contents: {
                    type: 'carousel',
                    contents: bubbles
                }
            }];

            if (userData.level == 4 && !simulatedLevel) {
                messages.push({
                    type: 'template',
                    altText: '模擬其他等級視角',
                    template: {
                        type: 'buttons',
                        text: `您目前的最高權限有拉出 ${products.length} 筆結果。是否需要模擬其他經銷商查價視角？`,
                        actions: [
                            { type: 'postback', label: '模擬 Level 1 視角', data: `action=simulate&level=1&keyword=${encodeURIComponent(intentParams.keyword || '')}` },
                            { type: 'postback', label: '模擬 Level 2 視角', data: `action=simulate&level=2&keyword=${encodeURIComponent(intentParams.keyword || '')}` },
                            { type: 'postback', label: '模擬 Level 3 視角', data: `action=simulate&level=3&keyword=${encodeURIComponent(intentParams.keyword || '')}` }
                        ]
                    }
                });
            }

            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: messages
            });
        }

        res.status(200).send('OK');
    } catch (e) {
        console.error('Webhook 執行發生錯誤:', e);
        res.status(500).send('Internal Server Error');
    }
});
