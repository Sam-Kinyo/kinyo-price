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
const normalize = (s) => String(s).replace(/[-\s]/g, '').toUpperCase().trim();

function getImageUrl(modelName) {
  // 預設佔位圖片 (若查無圖片時顯示)
  const fallbackUrl = "https://images.weserv.nl/?url=raw.githubusercontent.com/firebase/firebase-ios-sdk/master/Firebase/Messaging/Logo/fcm_logo.png&w=400"; 
  if (!modelName) return fallbackUrl;

  // 1. 型號正規化 (去除連字號與空白，全轉大寫)
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
        },
        request_image_links: {
            type: Type.BOOLEAN,
            description: "若使用者輸入中包含「大圖」、「網路圖」、「照片」、「圖片」、「素材」等強烈索取圖庫連結的語氣，請設為 true，否則為 false。"
        }
    },
    required: ["keyword", "request_image_links"]
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
            let summaryText = ""; // 用於暫停文字摘要，延後到最後與卡片一起發送
            let customToken = ''; // 提升作用域供底部 QuickReply 存取

            let shouldSkipSearch = false; // 用於標記是否純切換指令，跳過後面的商品搜尋

            if (event.type === 'message' && event.message.type === 'text') {
                userText = event.message.text.trim();
                
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
                const params = new URLSearchParams(event.postback.data);
                if (params.get('action') === 'show_level_menu') {
                    shouldSkipSearch = true;
                    userText = "切換選單顯示";
                } else if (params.get('action') === 'set_level') {
                    shouldSkipSearch = true;
                    simulatedLevel = parseInt(params.get('value'), 10);
                    userText = "設定權限等級";
                } else if (params.get('action') === 'get_text_quote') {
                    shouldSkipSearch = true;
                    userText = "產生單一文字報價";
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
                        
                        // 計算特定數量的單價
                        let divisor = 0.73;
                        if (level === 1) {
                            divisor = evalQty >= 100 ? 0.76 : 0.73;
                        } else if (level === 2) {
                            if (evalQty >= 300) divisor = 0.80;
                            else if (evalQty >= 100) divisor = 0.76;
                            else divisor = 0.73;
                        } else if (level >= 3) {
                            if (evalQty >= 1000) divisor = 0.858;
                            else if (evalQty >= 300) divisor = 0.80;
                            else if (evalQty >= 100) divisor = 0.76;
                            else divisor = 0.73;
                        }
                        
                        const finalPrice = Math.ceil((cost / divisor) * 1.05);
                        
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

            // --- 嚴格預算與庫存過濾 ---
            if (intentParams.min_budget !== null || intentParams.max_budget !== null || intentParams.target_qty !== null) {
                const maxB = intentParams.max_budget !== null ? parseInt(intentParams.max_budget) : Infinity;
                const minB = intentParams.min_budget !== null ? parseInt(intentParams.min_budget) : 0;
                const qty = intentParams.target_qty !== null ? parseInt(intentParams.target_qty) : null;
                
                products = products.filter(p => {
                    const cost = parseInt(p.cost) || 0;
                    if (cost === 0) return false;

                    // 計算對應單價 (finalPrice)
                    let evalQty = qty !== null ? qty : 50; 
                    let divisor = 0.73;
                    if (level === 1) {
                        divisor = evalQty >= 100 ? 0.76 : 0.73;
                    } else if (level === 2) {
                        if (evalQty >= 300) divisor = 0.80;
                        else if (evalQty >= 100) divisor = 0.76;
                        else divisor = 0.73;
                    } else if (level >= 3) {
                        if (evalQty >= 1000) divisor = 0.858;
                        else if (evalQty >= 300) divisor = 0.80;
                        else if (evalQty >= 100) divisor = 0.76;
                        else divisor = 0.73;
                    }
                    
                    const finalPrice = Math.ceil((cost / divisor) * 1.05);
                    p.finalPrice = finalPrice; // 存入物件供後續渲染

                    // 嚴格預算防線
                    return finalPrice >= minB && finalPrice <= maxB;
                });
            }

            // 權重排序: 庫存由高至低
            products.sort((a, b) => b.currentStock - a.currentStock);

            // 雙軌輸出：文字摘要清單 (Text Summary)
            if (products.length > 0 && (intentParams.min_budget !== null || intentParams.max_budget !== null)) {
                try {
                    const targetEmail = userEmail; 
                    if (!targetEmail) throw new Error("找不到使用者的 Email 變數");
                    
                    const userRecord = await admin.auth().getUserByEmail(targetEmail);
                    customToken = await admin.auth().createCustomToken(userRecord.uid);
                    console.log("Token 生成成功:", customToken.substring(0, 15) + "...");
                } catch (error) {
                    console.error('SSO Token 生成失敗:', error.message);
                }

                const maxB = intentParams.max_budget !== null ? intentParams.max_budget : '無上限';
                const minB = intentParams.min_budget !== null ? intentParams.min_budget : 0;
                
                // 1. 初始化摘要字串
                summaryText = `🔍 預算區間 $${minB} - $${maxB}\n`;
                summaryText += `共找到 ${products.length} 筆符合之商品 (依庫存排序)：\n\n`;

                // 2. 宣告 textList 變數 (截取前 15 筆)
                const textList = products.slice(0, 15);

                // 3. 執行迴圈組裝字串
                textList.forEach((p, index) => {
                    // 判斷庫存狀態，若小於等於 0 則強制加上標籤
                    const stockTag = p.currentStock <= 0 ? " ⚠️[缺貨]" : "";

                    summaryText += `${index + 1}. 【${p.model}】${p.name || '未命名'}${stockTag}\n   💰$${p.finalPrice || 0} (庫存: ${p.currentStock})\n`;
                });
                
                // 註解：我們將純文字合併在 Flex Message Array 後端發送 `messages.push({ type: 'text', text: summaryText.trim() });` 
                // 若在這裡直接送出 client.replyMessage()，replyToken 將會遭到消耗，導致稍後的卡片傳遞失敗 (LINE SDK: Invalid replyToken)
            }

            // --- 擴充：處理「圖庫索取」意圖分流 ---
            if (intentParams.request_image_links && products.length > 0) {
                const product = products[0]; // 取精準度最高的第一筆
                const targetModelNorm = normalize(product.model);
                
                // 查找 modelData.json 內的連結
                const imageInfo = modelData.models.find(m => normalize(m.mainModel) === targetModelNorm);
                const folderUrl = imageInfo && imageInfo.folderUrl ? imageInfo.folderUrl : '未提供';
                const netFolderUrl = imageInfo && imageInfo.netFolderUrl ? imageInfo.netFolderUrl : '未提供';

                const imageReplyText = `【${product.model}】圖庫連結\n📁 商品大圖：${folderUrl}\n📁 網路素材：${netFolderUrl}`;

                await lineClient.replyMessage({
                    replyToken: replyToken,
                    messages: [{ type: 'text', text: imageReplyText }]
                });
                console.log(`✅ [圖庫索取] 已傳送圖庫連結給 ${userEmail} (型號: ${product.model})`);
                continue; // 中斷後續的 Flex Message 報價流程
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

                // 加入產生文字報價的 Footer 按鈕
                bubble.footer = {
                    type: "box",
                    layout: "vertical",
                    spacing: "sm",
                    contents: [
                        {
                            type: "button",
                            style: "primary",
                            height: "sm",
                            action: {
                                type: "postback",
                                label: "產生文字報價",
                                data: `action=get_text_quote&model=${encodeURIComponent(p.model || '')}&qty=${intentParams.target_qty || 0}`
                            }
                        }
                    ]
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

            // 準備 Quick Reply 基礎結構 (空陣列)
            const quickReplyItems = [];

            // 全局切換視角掛載 (僅限 真實 Level 4 使用者)
            if (realLevel === 4) {
                quickReplyItems.push({ 
                    type: 'action', 
                    action: { type: 'postback', label: '切換查價視角', data: 'action=show_level_menu' } 
                });
            }

            // --- 擴展：若商品總數大於 9 筆，加入進入大看板的專屬按鈕 ---
            if (products.length > 9) {
                const ssoMin = intentParams.min_budget !== null ? intentParams.min_budget : 0;
                const ssoMax = intentParams.max_budget !== null ? intentParams.max_budget : '';
                const ssoQty = intentParams.target_qty || 0;
                
                // 如果 customToken 是空的，就在網址塞入 ERROR 讓我們知道它失敗了
                const safeToken = customToken || 'TOKEN_GENERATION_FAILED';
                const ssoUrl = `https://kinyo-gift.com/system?auth_token=${safeToken}&min=${ssoMin}&max=${ssoMax}&qty=${ssoQty}&level=${level}`;
                
                // 安插在陣列開頭，讓使用者最先看到
                quickReplyItems.unshift({
                    type: "action",
                    action: {
                        type: "uri",
                        label: "✨ 進入大看板挑選",
                        uri: ssoUrl
                    }
                });
            }

            // 若最終有需要掛載的 Quick Reply，塞進 Flex Message 根目錄
            if (quickReplyItems.length > 0) {
                flexMessageObj.quickReply = { items: quickReplyItems };
            }

            const messages = [];
            // 若有文字摘要，先推送在陣列最前端
            if (summaryText !== "") {
                messages.push({ type: 'text', text: summaryText.trim() });
            }
            messages.push(flexMessageObj);

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
