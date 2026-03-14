const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { setGlobalDispatcher, ProxyAgent } = require('undici');
const { line, messagingApi } = require('@line/bot-sdk');
const { GoogleGenAI, Type, Schema } = require('@google/genai');

admin.initializeApp();
const db = admin.firestore();

// --- 環境變數與設定 ---
// 根據 Firebase Functions v3+ 官方規範，.env 檔案的變數會在中介層自動掛載進 process.env
const modelData = require('./modelData.json');

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

// --- Helper Functions ---
function getImageUrl(modelName) {
  // 預設佔位圖片 (若查無圖片時顯示)
  const fallbackUrl = "https://images.weserv.nl/?url=raw.githubusercontent.com/firebase/firebase-ios-sdk/master/Firebase/Messaging/Logo/fcm_logo.png&w=400"; 
  if (!modelName) return fallbackUrl;

  // 1. 型號正規化 (去除連字號與空白，全轉小寫)
  const normalize = (str) => String(str).replace(/[-\s]/g, '').toLowerCase();
  const targetModel = normalize(modelName);

  // 2. 尋找匹配的商品
  const foundItem = modelData.models.find(m => m.mainModel && normalize(m.mainModel) === targetModel);
  if (!foundItem || !foundItem.mainImage) return fallbackUrl;

  // 3. 提取 Google Drive File ID
  const match = foundItem.mainImage.match(/id=([a-zA-Z0-9_-]+)/);
  if (match && match[1]) {
    // 4. 轉換為 LINE 100% 相容的 Thumbnail API
    return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w600`;
  }

  return fallbackUrl;
}

function calculatePrice(cost, divisor) {
    return Math.ceil((cost / divisor) * 1.05);
}
const getConfig = () => ({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET,
    geminiApiKey: process.env.GEMINI_API_KEY
});

// 定義 Gemini JSON Schema 結構
const intentSchema = {
    type: Type.OBJECT,
    properties: {
        keyword: {
            type: Type.STRING,
            description: "使用者想要搜尋的商品型號或名稱 (例如：KPB-2990, 吹風機)。必填寫。"
        },
        target_qty: {
            type: Type.INTEGER,
            description: "使用者預計購買的數量。純數字，無則為 null",
            nullable: true
        },
        min_budget: {
            type: Type.INTEGER,
            description: "使用者指定的預算下限或最低預算，純數字，無則為 null",
            nullable: true
        },
        max_budget: {
            type: Type.INTEGER,
            description: "使用者指定的預算上限或最高預算，純數字，無則為 null",
            nullable: true
        },
        min_stock: {
            type: Type.INTEGER,
            description: "使用者要求的最低安全庫存量限制，純數字，無則為 null",
            nullable: true
        }
    },
    required: ["keyword"]
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

            let shouldSkipSearch = false; // 用於標記是否純切換指令，跳過後面的商品搜尋

            if (event.type === 'message' && event.message.type === 'text') {
                userText = event.message.text.trim();
            } else if (event.type === 'postback') {
                const params = new URLSearchParams(event.postback.data);
                if (params.get('action') === 'show_level_menu') {
                    shouldSkipSearch = true;
                    userText = "切換選單顯示";
                } else if (params.get('action') === 'set_level') {
                    shouldSkipSearch = true;
                    simulatedLevel = parseInt(params.get('value'), 10);
                    userText = "設定權限等級";
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
            let realLevel = parseInt(userData.level) || 0; // 真實權限
            let level = parseInt(userData.currentViewLevel) || realLevel; // 套用最高設定，若無則為真實權限
            const isVip = !!userData.vipColumn;
            
            if (realLevel < 1 && !isVip) {
                console.log(`[權限阻擋] 帳號 ${userEmail} 權限不足 (Level: ${realLevel}, VIP: ${isVip})`);
                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: [{ type: 'text', text: '權限不足，請聯絡管理員開通查詢權限。' }]
                });
                continue;
            }

            console.log(`✅ [權限通過] 用戶: ${userEmail} | 真實等級: ${realLevel} | 目前檢視等級: ${level} | VIP: ${isVip}`);

            // 處理全局快速切換指令 (跳過 Gemini 與搜尋)
            if (shouldSkipSearch) {
                if (realLevel !== 4) {
                    await lineClient.replyMessage({ replyToken: replyToken, messages: [{ type: 'text', text: '您無權限執行此指令。' }] });
                    continue;
                }
                
                const params = new URLSearchParams(event.postback.data);
                if (params.get('action') === 'show_level_menu') {
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
                    await usersRef.doc(userDoc.id).update({ currentViewLevel: newLevel });
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
                }
                continue;
            }

            let intentParams = {
                keyword: simulatedKeyword || null,
                target_qty: null,
                min_budget: null,
                max_budget: null,
                min_stock: null
            };

            if (event.type === 'message') {
                // ---------------------------------------------------------
                // 模組 2：呼叫 Gemini 解析意圖 (JSON Schema)
                // ---------------------------------------------------------
                console.log(`[Gemini] 開始解析輸入文字: "${userText}"`);

                try {
                    await lineClient.showLoadingAnimation({
                        chatId: lineUid,
                        loadingSeconds: 10
                    });
                } catch (loadErr) {
                    console.error(`⚠️ [Line SDK 警告] showLoadingAnimation failed:`, loadErr);
                }

                const prompt = `你是一個專業的商品查詢意圖萃取機器人。
主要任務：分析使用者的對話，並將其中的「關鍵字(商品名/型號)」、「數量」、「預算上限/下限」、「庫存限制」萃取出來。
絕對限制：
1. 你「不可以」直接回答使用者的問題。
2. 你「不可以」幫使用者計算價格。
3. 若使用者沒有給出具體的商品名稱（例如只說「東西」、「產品」、「推薦」或單純給預算），請將 keyword 參數設定為空字串 ""。
4. 你「必須」回傳嚴格的 JSON 格式。
使用者輸入内容：「${userText}」`;

                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: prompt,
                    config: {
                        responseMimeType: "application/json",
                        responseSchema: intentSchema
                    }
                });

                try {
                    const jsonText = response.candidates?.[0]?.content?.parts?.[0]?.text;
                    if (jsonText) {
                        const parsed = JSON.parse(jsonText);
                        intentParams = { ...intentParams, ...parsed };
                    }
                } catch (jsonErr) {
                    console.error(`[Gemini Warn] JSON 解析失敗:`, jsonErr);
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

            console.log(`[過濾前] 總計取得有效商品數: ${products.length}`);

            // 過濾 keyword
            if (intentParams.keyword !== null && intentParams.keyword !== undefined) {
                const rawKw = intentParams.keyword;
                const kw = normalizeKeyword(rawKw).toLowerCase();
                const searchKw = kw || ""; // 確保轉為空字串

                if (rawKw !== kw && searchKw !== "") {
                    console.log(`[正規化] 關鍵字轉換: "${rawKw}" -> "${searchKw}"`);
                }
                
                products = products.filter(p => {
                    const pName = normalizeKeyword(p.name || "").toLowerCase();
                    const pModel = normalizeKeyword(p.model || "").toLowerCase();
                    return searchKw === "" || pName.includes(searchKw) || pModel.includes(searchKw);
                });
            }

            // 未命中觀測機制 (Log Missing Keywords)
            if (products.length === 0 && intentParams.keyword) {
                console.warn(`[Miss] 找不到符合關鍵字的商品: "${intentParams.keyword}"`);
                // 這裡未來可以實作寫入 Firestore 統計表
            }

            // 防禦性讀取庫存
            products = products.map(p => {
                p.currentStock = Number(p.inventory || 0);
                return p;
            });

            // 過濾 min_stock
            if (intentParams.min_stock !== undefined && intentParams.min_stock !== null) {
                products = products.filter(p => p.currentStock >= parseInt(intentParams.min_stock));
            }

            // 過濾預算 (Loose Budget Filter)
            if (intentParams.min_budget !== null || intentParams.max_budget !== null) {
                const maxB = intentParams.max_budget !== null ? parseInt(intentParams.max_budget) : Infinity;
                const minB = intentParams.min_budget !== null ? parseInt(intentParams.min_budget) : 0;
                
                products = products.filter(p => {
                    const cost = parseInt(p.cost) || 0;
                    if (cost === 0) return false;

                    const qty = intentParams.target_qty !== null ? parseInt(intentParams.target_qty) : null;
                    
                    if (qty !== null) {
                        // 情境 A: 有指定數量
                        let exactDivisor = 0;
                        if (level === 4) {
                            if (qty >= 3000) exactDivisor = 0.89;
                            else if (qty >= 1000) exactDivisor = 0.858;
                            else if (qty >= 500) exactDivisor = 0.835;
                            else if (qty >= 300) exactDivisor = 0.80;
                            else if (qty >= 100) exactDivisor = 0.76;
                            else exactDivisor = 0.73;
                        } else if (level === 3) {
                            if (qty >= 1000) exactDivisor = 0.858;
                            else if (qty >= 500) exactDivisor = 0.835;
                            else if (qty >= 300) exactDivisor = 0.80;
                            else if (qty >= 100) exactDivisor = 0.76;
                            else exactDivisor = 0.73;
                        } else if (level === 2) {
                            if (qty >= 300) exactDivisor = 0.80;
                            else if (qty >= 100) exactDivisor = 0.76;
                            else exactDivisor = 0.73;
                        } else {
                            if (qty >= 100) exactDivisor = 0.76;
                            else exactDivisor = 0.73;
                        }
                        const exactPrice = calculatePrice(cost, exactDivisor);
                        return exactPrice >= minB && exactPrice <= maxB;
                    } else {
                        // 情境 B: 無指定數量，寬鬆比對
                        let highestPrice = 0; // 最貴的情況 (量最少)
                        let lowestPrice = 0;  // 最便宜的情況 (量最多)
                        
                        // 統一最低起訂量為 50 個做為最高售價標準 (0.73)
                        highestPrice = calculatePrice(cost, 0.73);
                        
                        // 依據 level 決定可用到的最極端低價 (最低售價標準)
                        if (level === 4) lowestPrice = calculatePrice(cost, 0.89);
                        else if (level === 3) lowestPrice = calculatePrice(cost, 0.858);
                        else if (level === 2) lowestPrice = calculatePrice(cost, 0.80);
                        else lowestPrice = calculatePrice(cost, 0.76); // level 1 最優是 100 個

                        // 只要最便宜的情況低於最高預算，且最貴的情況高於最低預算，就放行
                        if (maxB !== Infinity && lowestPrice > maxB) return false;
                        if (minB !== 0 && highestPrice < minB) return false;
                        return true;
                    }
                });
            }

            // Base Model 聚合邏輯 (SPU Grouping)
            const groupedProducts = Object.values(products.reduce((acc, current) => {
                // 分離主型號與尾綴
                const match = current.model.match(/^([a-zA-Z0-9-]+?\d+)([a-zA-Z]*)$/);
                const baseModel = match ? match[1].toUpperCase() : current.model.toUpperCase();
                const suffix = match && match[2] ? match[2].toUpperCase() : '標準';

                if (!acc[baseModel]) {
                    // 初始化主型號物件，以第一筆遇到的商品資料為基準
                    acc[baseModel] = { ...current };
                    acc[baseModel].model = baseModel; // 顯示用的型號去尾綴
                    acc[baseModel].skus = []; 
                    acc[baseModel].totalStock = 0;
                }

                // 將這筆 SPU 存入陣列
                acc[baseModel].skus.push({
                    suffix: suffix,
                    stock: current.currentStock,
                    originalModel: current.model
                });
                acc[baseModel].totalStock += current.currentStock;
                
                return acc;
            }, {}));

            // 最多取 10 個 Base Model 送到 Carousel
            products = groupedProducts.slice(0, 10);
            
            console.log(`[過濾後] 符合條件並送到 Carousel 的商品數: ${products.length}`);

            // 統一防護：找不到結果的時候強制掛上 Quick Reply
            if (products.length === 0) {
                console.log(`[結果] 找不到對應的商品，準備回覆 Not Found 訊息。`);
                
                let fallbackMsg = { type: 'text', text: '抱歉，依照您的條件找不到對應的商品。' };
                if (realLevel === 4) {
                    fallbackMsg.quickReply = {
                        items: [{ type: 'action', action: { type: 'postback', label: '切換查價視角', data: 'action=show_level_menu' } }]
                    };
                }

                try {
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [fallbackMsg]
                    });
                } catch (err) {
                    console.error(`❌ [Line SDK 錯誤] NotFound replyMessage failed:`, err);
                    if (err.originalError && err.originalError.response && err.originalError.response.data) {
                        console.error(`❌ [Line API 詳細錯誤]`, JSON.stringify(err.originalError.response.data, null, 2));
                    }
                }
                continue;
            }

            // ---------------------------------------------------------
            // 模組 4、5：組裝 Flex Message 與試算價格
            // ---------------------------------------------------------
            const bubbles = products.map(p => {
                try {
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

                // 庫存字串組合
                let stockText = '';
                if (level >= 3) {
                    // 顯示詳細庫存
                    const stockDetails = p.skus.map(sku => `${sku.suffix} ${sku.stock}`).join(' | ');
                    stockText = `庫存: ${stockDetails}`;
                } else {
                    // 只顯示是否缺貨
                    stockText = p.totalStock > 0 ? '庫存: 充足' : '庫存: 缺貨';
                }

                const imgUrl = getImageUrl(p.model);
                
                // 嚴格校驗 URL 格式，若不合法則強迫使用預設
                let targetUrl = "https://www.kinyo.tw/";
                if (p.productUrl && typeof p.productUrl === 'string' && p.productUrl.startsWith('http')) {
                    targetUrl = p.productUrl;
                }
                
                const bubble = {
                    type: "bubble",
                    hero: {
                        type: "image",
                        url: imgUrl,
                        size: "full",
                        aspectRatio: "1:1",
                        aspectMode: "cover",
                        action: { type: "uri", uri: targetUrl }
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
                                text: `型號: ${p.model || '無'}`,
                                size: "sm",
                                color: "#aaaaaa",
                                wrap: true
                            },
                            {
                                type: "text",
                                text: `條碼: ${p.internationalBarcode || '無'}`,
                                size: "sm",
                                color: "#aaaaaa",
                                flex: 0,
                                wrap: true
                            },
                            {
                                type: "text",
                                text: stockText,
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

                return bubble;
                } catch (bubbleErr) {
                    console.error(`❌ [卡片組裝失敗] 商品型號: ${p.model}`, bubbleErr);
                    return null;
                }
            }).filter(b => b !== null);

            if (bubbles.length === 0) {
                console.error(`❌ 所有過濾後的商品卡片皆組裝失敗。`);
                
                let fallbackBubbleMsg = { type: 'text', text: '抱歉，符合條件的商品遇到資料格式問題，無法正常顯示。' };
                if (realLevel === 4) {
                    fallbackBubbleMsg.quickReply = {
                        items: [{ type: 'action', action: { type: 'postback', label: '切換查價視角', data: 'action=show_level_menu' } }]
                    };
                }

                try {
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [fallbackBubbleMsg]
                    });
                } catch (e) {}
                continue;
            }

            let flexMessageObj = {
                type: 'flex',
                altText: `為您尋找到 ${bubbles.length} 筆商品報價`,
                contents: {
                    type: 'carousel',
                    contents: bubbles
                }
            };

            // 全局 Quick Reply 掛載 (僅限 真實 Level 4 使用者)
            if (realLevel === 4) {
                flexMessageObj.quickReply = {
                    items: [
                        { type: 'action', action: { type: 'postback', label: '切換查價視角', data: 'action=show_level_menu' } }
                    ]
                };
            }

            const messages = [flexMessageObj];

            // --- 日誌強化：紀錄發送前的完整 Payload ---
            console.log("=== Final Flex Message Payload ===");
            console.log(JSON.stringify(messages, null, 2));
            console.log("==================================");

            try {
                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: messages
                });
                console.log(`✅ [回覆成功] 已發送 ${products.length} 筆商品與 1 個查價 Carousel.`);
            } catch (err) {
                console.error(`❌ [Line SDK 錯誤] replyMessage failed:`, err);
                if (err.originalError && err.originalError.response && err.originalError.response.data) {
                    console.error(`❌ [Line API 詳細錯誤]`, JSON.stringify(err.originalError.response.data, null, 2));
                }
                if (err.response && err.response.data) {
                    console.error(`❌ [Line API 詳細錯誤 (Axios)]`, JSON.stringify(err.response.data, null, 2));
                }
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
