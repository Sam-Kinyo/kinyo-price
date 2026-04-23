const { admin, db } = require('../utils/firebase');
const { calculateLevelPrice } = require('../utils/priceCalculator');
const { getImageUrl, getBaseModelForImages } = require('../utils/imageUtils');

const synonymDict = { "藍芽": "藍牙", "捕蚊拍": "電蚊拍", "台": "臺" };
function normalizeKeyword(str) {
    if (!str) return str;
    let normalized = String(str);
    for (const [key, value] of Object.entries(synonymDict)) {
        normalized = normalized.split(key).join(value);
    }
    return normalized;
}

const fallbackMessage = {
    type: 'text',
    text: `🤖 系統提示：無法辨識指令\n\n很抱歉，『挺好的』目前無法完全理解您的需求。為加快處理速度，請參考以下標準指令：\n\n🔍 商品查價：請輸入「查價 + 型號」\n🛒 建立訂單：請填寫完整「下單模板」\n🛠️ 維修資訊：請輸入「維修」或「客服」\n📦 樣品/不良品：請直接填寫完整申請模板\n\n若需專人協助，請直接於群組內標註業務人員，謝謝您！`
};

async function processQuote(intentParams, userContext, event, lineClient) {
    const { level, userEmail, realLevel } = userContext;
    const replyToken = event.replyToken;
    let summaryText = "";
    let customToken = "";

    console.log(`[搜尋] 開始拉取 Firestore 商品資料...`);
    const productsSnapshot = await db.collection('Products').get();
    let products = productsSnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(p => !p.status || p.status === 'active');

    console.log(`[過濾前] 總計取得有效商品數: ${products.length}`);

    if (intentParams.intent === 'query' || intentParams.action === 'query' || intentParams.action === 'search') {
        let keywordStr = '';
        if (typeof intentParams.keyword === 'string') {
            keywordStr = intentParams.keyword.trim();
        } else if (Array.isArray(intentParams.keywords) && intentParams.keywords.length > 0) {
            keywordStr = intentParams.keywords.join(' ').trim();
        }

        const searchKw = normalizeKeyword(keywordStr).toLowerCase();

        intentParams.keywords = searchKw ? searchKw.split(/\s+/).filter(k => k.length > 0) : [];

        const minB = intentParams.min_budget;
        const maxB = intentParams.max_budget;
        const hasKeyword = intentParams.keywords.length > 0;
        const hasBudget = (minB !== null && minB !== undefined) || (maxB !== null && maxB !== undefined);

        if (!hasKeyword && !hasBudget) {
            await lineClient.replyMessage({
                replyToken: replyToken,
                messages: [fallbackMessage]
            });
            return;
        }

        if (keywordStr !== searchKw && searchKw !== "") {
            console.log(`[正規化] 關鍵字轉換: "${keywordStr}" -> "${searchKw}"`);
        }

        const kwArray = intentParams.keywords;
        products = products.filter(p => {
            const pName = normalizeKeyword(p.name || "").toLowerCase();
            const pModel = normalizeKeyword(p.model || "").toLowerCase();
            if (kwArray.length === 0) return true;
            return kwArray.some(kw => pName.includes(kw) || pModel.includes(kw));
        });
    }

    if (products.length === 0) {
        console.warn(`[Miss] 找不到符合關鍵字的商品: "${intentParams.keyword}"`);
    }

    products = products.map(p => {
        p.currentStock = Number(p.inventory || 0);
        return p;
    });

    if (intentParams.min_stock !== undefined && intentParams.min_stock !== null) {
        products = products.filter(p => p.currentStock >= parseInt(intentParams.min_stock));
    }

    let target_qty = intentParams.target_qty !== null ? parseInt(intentParams.target_qty) : null;

    if (intentParams.min_budget !== null || intentParams.max_budget !== null || intentParams.target_qty !== null) {
        const maxB = intentParams.max_budget !== null ? parseInt(intentParams.max_budget) : Infinity;
        const minB = intentParams.min_budget !== null ? parseInt(intentParams.min_budget) : 0;

        products = products.filter(p => {
            const cost = parseInt(p.cost) || 0;
            if (cost === 0) return false;

            let evalQty = target_qty !== null ? target_qty : 50;
            const finalPrice = calculateLevelPrice(cost, level, evalQty);
            p.finalPrice = finalPrice;

            return finalPrice >= minB && finalPrice <= maxB;
        });
    }

    products.sort((a, b) => {
        const aInStock = a.currentStock > 0 ? 1 : 0;
        const bInStock = b.currentStock > 0 ? 1 : 0;
        if (aInStock !== bInStock) {
            return bInStock - aInStock;
        }
        return Math.random() - 0.5;
    });

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

        summaryText = `🔍 預算區間 $${minB} - $${maxB}\n`;
        summaryText += `隨機為您推薦 ${Math.min(products.length, 15)} 筆符合之商品：\n\n`;

        const textList = products.slice(0, 15);

        textList.forEach((p, index) => {
            const stockTag = p.currentStock <= 0 ? " ⚠️[缺貨]" : "";
            const etaValue = p.ETA || p.eta;
            const etaText = etaValue ? ` | 到貨: ${etaValue}` : '';
            const inventoryDisplay = (level >= 2) ? ` (庫存: ${p.currentStock}${etaText})` : (p.currentStock > 0 ? ` (庫存: 充足${etaText})` : ` (庫存: 缺貨${etaText})`);
            summaryText += `${index + 1}. 【${p.model}】${p.name || '未命名'}${stockTag}\n   💰$${p.finalPrice || 0}${inventoryDisplay}\n`;
        });
    }

    if (intentParams.request_image_links && products.length > 0) {
        const product = products[0];
        const targetModelNorm = getBaseModelForImages(product.model);

        let folderUrl = '未提供';
        let netFolderUrl = '未提供';
        try {
            const imageDocSnap = await db.collection('ProductImages').doc(targetModelNorm).get();
            if (imageDocSnap.exists) {
                const imageInfo = imageDocSnap.data();
                if (imageInfo.folderUrl) folderUrl = imageInfo.folderUrl;
                if (imageInfo.netFolderUrl) netFolderUrl = imageInfo.netFolderUrl;
            }
        } catch (e) {}

        const imageReplyText = `【${product.model}】圖庫連結\n📁 商品大圖：${folderUrl}\n📁 網路素材：${netFolderUrl}`;

        await lineClient.replyMessage({
            replyToken: replyToken,
            messages: [{ type: 'text', text: imageReplyText }]
        });
        console.log(`✅ [圖庫索取] 已傳送圖庫連結給 ${userEmail} (型號: ${product.model})`);
        return;
    }

    const groupedProducts = Object.values(products.reduce((acc, current) => {
        const match = current.model.match(/^([a-zA-Z0-9-]+?\d+)([a-zA-Z]*)$/);
        const baseModel = match ? match[1].toUpperCase() : current.model.toUpperCase();
        const suffix = match && match[2] ? match[2].toUpperCase() : '標準';

        if (!acc[baseModel]) {
            acc[baseModel] = { ...current };
            acc[baseModel].model = baseModel;
            acc[baseModel].skus = [];
            acc[baseModel].totalStock = 0;
        }

        acc[baseModel].skus.push({
            suffix: suffix,
            stock: current.currentStock,
            originalModel: current.model
        });
        acc[baseModel].totalStock += current.currentStock;

        return acc;
    }, {}));

    products = groupedProducts.slice(0, 10);

    console.log(`[過濾後] 符合條件並送到 Carousel 的商品數: ${products.length}`);

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
        }
        return;
    }

    const bubblePromises = products.map(async p => {
        try {
            const cost = parseInt(p.cost) || 0;
            const priceScale = [];

            if (level >= 1) {
                let text50 = `50個: $${calculateLevelPrice(cost, level, 50)}`;
                let text100 = `100個: $${calculateLevelPrice(cost, level, 100)}`;

                if (intentParams.target_qty && intentParams.target_qty >= 50 && intentParams.target_qty < 100) {
                    text50 = `🔥 ${text50}`;
                } else if (intentParams.target_qty && intentParams.target_qty >= 100 && intentParams.target_qty < 300) {
                    text100 = `🔥 ${text100}`;
                }
                priceScale.push(text50);
                priceScale.push(text100);
            }

            if (level >= 2) {
                let text300 = `300個: $${calculateLevelPrice(cost, level, 300)}`;
                let text500 = `500個: $${calculateLevelPrice(cost, level, 500)}`;

                if (intentParams.target_qty && intentParams.target_qty >= 300 && intentParams.target_qty < 500) {
                    text300 = `🔥 ${text300}`;
                } else if (intentParams.target_qty && intentParams.target_qty >= 500 && intentParams.target_qty < 1000) {
                    text500 = `🔥 ${text500}`;
                }

                priceScale[0] = `50個: $${calculateLevelPrice(cost, level, 50)}`;
                priceScale[1] = `100個: $${calculateLevelPrice(cost, level, 100)}`;

                if (intentParams.target_qty && intentParams.target_qty >= 50 && intentParams.target_qty < 100) {
                    priceScale[0] = `🔥 ${priceScale[0]}`;
                } else if (intentParams.target_qty && intentParams.target_qty >= 100 && intentParams.target_qty < 300) {
                    priceScale[1] = `🔥 ${priceScale[1]}`;
                }

                priceScale.push(text300);
                priceScale.push(text500);
            }

            if (level >= 3) {
                let text1000 = `1000個: $${calculateLevelPrice(cost, level, 1000)}`;

                if (intentParams.target_qty && intentParams.target_qty >= 1000 && intentParams.target_qty < 3000) {
                    text1000 = `🔥 ${text1000}`;
                }

                priceScale[0] = `50個: $${calculateLevelPrice(cost, level, 50)}`;
                priceScale[1] = `100個: $${calculateLevelPrice(cost, level, 100)}`;
                priceScale[2] = `300個: $${calculateLevelPrice(cost, level, 300)}`;
                priceScale[3] = `500個: $${calculateLevelPrice(cost, level, 500)}`;

                if (intentParams.target_qty && intentParams.target_qty >= 50 && intentParams.target_qty < 100) {
                    priceScale[0] = `🔥 ${priceScale[0]}`;
                } else if (intentParams.target_qty && intentParams.target_qty >= 100 && intentParams.target_qty < 300) {
                    priceScale[1] = `🔥 ${priceScale[1]}`;
                } else if (intentParams.target_qty && intentParams.target_qty >= 300 && intentParams.target_qty < 500) {
                    priceScale[2] = `🔥 ${priceScale[2]}`;
                } else if (intentParams.target_qty && intentParams.target_qty >= 500 && intentParams.target_qty < 1000) {
                    priceScale[3] = `🔥 ${priceScale[3]}`;
                }

                priceScale.push(text1000);
            }

            if (level >= 4) {
                let text3000 = `3000個: $${calculateLevelPrice(cost, level, 3000)}`;
                if (intentParams.target_qty && intentParams.target_qty >= 3000) {
                    text3000 = `🔥 ${text3000}`;
                }
                priceScale.push(text3000);
            }

            let stockText = ' ';
            if (level >= 2) {
                const stockDetails = p.skus.map(sku => `${sku.suffix} ${sku.stock}`).join(' | ');
                stockText = `庫存: ${stockDetails}`;
            } else if (level === 1) {
                stockText = p.totalStock > 0 ? '庫存: 充足' : '庫存: 缺貨';
            }

            const etaValue = p.ETA || p.eta;
            if (etaValue) {
                stockText += ` | 到貨: ${etaValue}`;
            }

            const imgUrl = await getImageUrl(p.model, p.imageUrl);

            let targetUrl = "https://www.kinyo.tw/";
            if (p.productUrl && typeof p.productUrl === 'string' && p.productUrl.startsWith('http')) {
                targetUrl = p.productUrl;
            }

            const bubble = {
                type: "bubble",
                hero: {
                    type: "image",
                    url: imgUrl,
                    size: "4xl",
                    aspectRatio: "20:13",
                    aspectMode: "fit",
                    action: { type: "uri", label: "查看商品介紹", uri: targetUrl }
                },
                body: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: p.name || '未命名商品', weight: "bold", size: "xl", wrap: true },
                        { type: "text", text: `型號: ${p.model || '無'}`, size: "sm", color: "#aaaaaa", wrap: true },
                        { type: "text", text: `條碼: ${p.internationalBarcode || '無'}`, size: "sm", color: "#aaaaaa", flex: 0, wrap: true },
                        { type: "text", text: `箱入數: ${p.cartonQty || '未提供'}`, size: "sm", color: "#aaaaaa" },
                        { type: "text", text: stockText, size: "sm", color: "#aaaaaa", wrap: true },
                        { type: "separator", margin: "md" }
                    ]
                }
            };

            const formattedPriceRows = [];
            for (let i = 0; i < priceScale.length; i += 2) {
                const rowContents = [
                    { type: 'text', text: priceScale[i], size: 'sm', color: priceScale[i].includes('🔥') ? '#ff0000' : '#666666', weight: priceScale[i].includes('🔥') ? "bold" : "regular", flex: 1, wrap: true }
                ];

                if (i + 1 < priceScale.length) {
                    rowContents.push({ type: 'text', text: priceScale[i + 1], size: 'sm', color: priceScale[i + 1].includes('🔥') ? '#ff0000' : '#666666', weight: priceScale[i + 1].includes('🔥') ? "bold" : "regular", flex: 1, wrap: true });
                } else {
                    rowContents.push({ type: 'text', text: ' ', size: 'sm', flex: 1 });
                }

                formattedPriceRows.push({
                    type: 'box',
                    layout: 'horizontal',
                    spacing: 'sm',
                    margin: 'sm',
                    contents: rowContents
                });
            }

            bubble.body.contents.push({
                type: "box",
                layout: "vertical",
                margin: "md",
                spacing: "sm",
                contents: formattedPriceRows
            });

            bubble.footer = {
                type: 'box',
                layout: 'vertical',
                spacing: 'sm',
                contents: [
                    {
                        type: 'button',
                        style: 'primary',
                        color: '#1DB446',
                        height: 'sm',
                        action: {
                            type: 'postback',
                            label: '產生文字報價',
                            data: `action=get_text_quote&model=${encodeURIComponent(p.model || '')}&qty=${intentParams.target_qty || 0}`
                        }
                    },

                    {
                        type: 'button',
                        style: 'secondary',
                        height: 'sm',
                        margin: 'sm',
                        action: {
                            type: 'uri',
                            label: '📄 查看商品介紹',
                            uri: targetUrl
                        }
                    }
                ]
            };

            return bubble;
        } catch (bubbleErr) {
            console.error(`❌ [卡片組裝失敗] 商品型號: ${p.model}`, bubbleErr);
            return null;
        }
    });

    const bubbles = (await Promise.all(bubblePromises)).filter(b => b !== null);

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
        } catch (e) { }
        return;
    }

    let flexMessageObj = {
        type: 'flex',
        altText: `為您尋找到 ${bubbles.length} 筆商品報價`,
        contents: {
            type: 'carousel',
            contents: bubbles
        }
    };

    const quickReplyItems = [];

    if (realLevel === 4) {
        quickReplyItems.push({
            type: 'action',
            action: { type: 'postback', label: '切換查價視角', data: 'action=show_level_menu' }
        });
    }

    if (products.length > 9) {
        const ssoMin = intentParams.min_budget !== null ? intentParams.min_budget : 0;
        const ssoMax = intentParams.max_budget !== null ? intentParams.max_budget : '';
        const ssoQty = intentParams.target_qty || 0;

        const safeToken = customToken || 'TOKEN_GENERATION_FAILED';
        const ssoUrl = `https://kinyo-gift.com/system?auth_token=${safeToken}&min=${ssoMin}&max=${ssoMax}&qty=${ssoQty}&level=${level}`;

        quickReplyItems.unshift({
            type: "action",
            action: {
                type: "uri",
                label: "✨ 進入大看板挑選",
                uri: ssoUrl
            }
        });
    }

    if (quickReplyItems.length > 0) {
        flexMessageObj.quickReply = { items: quickReplyItems };
    }

    const messages = [];
    if (summaryText !== "") {
        messages.push({ type: 'text', text: summaryText.trim() });
    }
    messages.push(flexMessageObj);

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
    }
}

module.exports = { processQuote };
