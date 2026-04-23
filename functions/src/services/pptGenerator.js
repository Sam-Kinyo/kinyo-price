const { admin, db } = require('../utils/firebase');
const { calculateLevelPrice } = require('../utils/priceCalculator');
const { getImageUrl } = require('../utils/imageUtils');
const PptxGenJS = require('pptxgenjs');

const synonymDict = { "藍芽": "藍牙", "捕蚊拍": "電蚊拍", "台": "臺" };
function normalizeKeyword(str) {
    if (!str) return str;
    let normalized = String(str);
    for (const [key, value] of Object.entries(synonymDict)) {
        normalized = normalized.split(key).join(value);
    }
    return normalized;
}

async function processPptExport(intentParams, userContext, event, lineClient) {
    const { level, userEmail, realLevel } = userContext;
    const replyToken = event.replyToken;

    console.log(`[PPT Generator] 開始為請求進行 PPT 生成... 關鍵字: ${intentParams.keyword}`);

    // 通知使用者正在繪製 (若操作需時超過 2-3 秒)
    await lineClient.replyMessage({
        replyToken: replyToken,
        messages: [{ type: 'text', text: '⏳ 正在為您繪製專屬簡報中，請稍候...' }]
    });

    try {
        const productsSnapshot = await db.collection('Products').get();
        let products = productsSnapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(p => !p.status || p.status === 'active');

        let keywordStr = '';
        if (typeof intentParams.keyword === 'string') {
            keywordStr = intentParams.keyword.trim();
        } else if (Array.isArray(intentParams.keywords) && intentParams.keywords.length > 0) {
            keywordStr = intentParams.keywords.join(' ').trim();
        }

        const searchKw = normalizeKeyword(keywordStr).toLowerCase();
        const kwArray = searchKw ? searchKw.split(/\s+/).filter(k => k.length > 0) : [];

        products = products.filter(p => {
            const pName = normalizeKeyword(p.name || "").toLowerCase();
            const pModel = normalizeKeyword(p.model || "").toLowerCase();
            if (kwArray.length === 0) return true;
            return kwArray.some(kw => pName.includes(kw) || pModel.includes(kw));
        });

        if (products.length === 0) {
            await lineClient.pushMessage({
                to: event.source.userId,
                messages: [{ type: 'text', text: '❌ 找不到符合條件的商品，無法產生簡報。' }]
            });
            return;
        }

        // Apply Budget & Quantity rules (same as quote)
        let target_qty = intentParams.target_qty !== null ? parseInt(intentParams.target_qty) : 50;
        
        products = products.filter(p => {
            const cost = parseInt(p.cost) || 0;
            if (cost === 0) return false;
            p.finalPrice = calculateLevelPrice(cost, level, target_qty);

            if (intentParams.min_budget !== null || intentParams.max_budget !== null) {
                const maxB = intentParams.max_budget !== null ? parseInt(intentParams.max_budget) : Infinity;
                const minB = intentParams.min_budget !== null ? parseInt(intentParams.min_budget) : 0;
                return p.finalPrice >= minB && p.finalPrice <= maxB;
            }
            return true;
        });

        // Grouping
        const groupedProducts = Object.values(products.reduce((acc, current) => {
            const match = current.model.match(/^([a-zA-Z0-9-]+?\d+)([a-zA-Z]*)$/);
            const baseModel = match ? match[1].toUpperCase() : current.model.toUpperCase();
            
            if (!acc[baseModel]) {
                acc[baseModel] = { ...current };
                acc[baseModel].model = baseModel;
            }
            return acc;
        }, {}));

        const finalProducts = groupedProducts.slice(0, 10); // 上限 10 張

        if (finalProducts.length === 0) {
            await lineClient.pushMessage({
                to: event.source.userId,
                messages: [{ type: 'text', text: '❌ 無符合預算與數量的商品可產生簡報。' }]
            });
            return;
        }

        // ==============================
        // 執行 PptxGenJS (雲端產生 PPT)
        // ==============================
        let pptx = new PptxGenJS();
        pptx.layout = 'LAYOUT_16x9';

        for (const p of finalProducts) {
            let slide = pptx.addSlide();
            
            // Background Header
            slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 1, fill: { color: "0055aa" } });
            
            // Title
            slide.addText(`【${p.model}】${p.name || ''}`, {
                x: 0.5, y: 0.2, w: '90%', h: 0.6,
                fontSize: 24, bold: true, color: "ffffff", align: 'center'
            });

            // Product Image (Using network URL mapped via getImageUrl)
            const imgUrl = await getImageUrl(p.model, p.imageUrl);
            try {
                slide.addImage({ path: imgUrl, x: 0.5, y: 1.5, w: 5, h: 5, sizing: { type: "contain" } });
            } catch (err) {
                console.warn(`[PPT] 圖片載入失敗: ${imgUrl}`);
                slide.addText(`(圖片無法載入)`, { x: 0.5, y: 1.5, w: 5, h: 5, color:"cccccc" });
            }

            // Specs and Price
            slide.addText("產品規格與報價", { 
                x: 6, y: 1.5, w: 4, h: 0.5, 
                fontSize: 18, bold: true, color: "0055aa",
                border: { type: 'solid', pt: 1, color: '0055aa' }
            });

            let details = `\n`;
            details += `建議採購：${target_qty} 件\n`;
            details += `單項售價：$${p.finalPrice || '未提供'}\n`;
            details += `\n`;
            details += `末端售價：${p.minPrice ? '$' + p.minPrice : '未提供'}\n`;
            details += `電商售價：${p.marketPrice ? '$' + p.marketPrice : '未提供'}\n`;
            details += `\n`;
            details += `庫存數量：${(p.inventory && Number(p.inventory) > 0) ? p.inventory : '缺貨'}\n`;
            details += `標準箱入：${p.cartonQty || '未提供'}\n`;
            if (p.ETA || p.eta) details += `預計到貨：${p.ETA || p.eta}\n`;

            slide.addText(details, { 
                x: 6, y: 2.2, w: 4.5, h: 3, 
                fontSize: 16, color: "333333", bullet: true
            });
            
            // Footer
            slide.addText("KINYO 專屬報價系統 - " + new Date().toISOString().split('T')[0], {
                x: 0, y: 7.0, w: '100%', h: 0.4,
                fontSize: 10, color: "999999", align: "center"
            });
        }

        // ==============================
        // 匯出 Buffer 並上傳 Firebase Storage
        // ==============================
        const pptBuffer = await pptx.write({ outputType: 'nodebuffer' });

        const bucketName = 'kinyo-price.firebasestorage.app'; // User specified bucket
        const bucket = admin.storage().bucket(bucketName);
        
        const filename = `ppt_exports/KINYO_QUOTE_${Date.now()}.pptx`;
        const file = bucket.file(filename);
        
        const crypto = require('crypto');
        const downloadToken = crypto.randomUUID();

        await file.save(pptBuffer, {
            metadata: { 
                contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                metadata: {
                    firebaseStorageDownloadTokens: downloadToken
                }
            }
        });

        // 產生 Firebase 原生下載用的 Token 網址 (避開 IAM signBlob 權限問題)
        const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(filename)}?alt=media&token=${downloadToken}`;

        // 回傳給客戶
        const flexMessage = {
            type: "flex",
            altText: "您的專屬簡報已產生成功",
            contents: {
                type: "bubble",
                size: "kilo",
                header: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        { type: "text", text: "📊 專屬簡報已產生", weight: "bold", size: "md", color: "#ffffff" }
                    ],
                    backgroundColor: "#1DB446"
                },
                body: {
                    type: "box",
                    layout: "vertical",
                    spacing: "md",
                    contents: [
                        { type: "text", text: `為您匯出了 ${finalProducts.length} 個商品的簡報。`, size: "sm", wrap: true },
                        { type: "text", text: "請點擊下方按鈕下載 PPTX 檔案 (連結有效期限為 24 小時)。", size: "xs", color: "#666666", wrap: true }
                    ]
                },
                footer: {
                    type: "box",
                    layout: "vertical",
                    contents: [
                        {
                            type: "button",
                            style: "primary",
                            color: "#0055aa",
                            action: { type: "uri", label: "📥 點此下載簡報", uri: url }
                        }
                    ]
                }
            }
        };

        await lineClient.pushMessage({
            to: event.source.userId,
            messages: [flexMessage]
        });

        console.log(`✅ [PPT Generator] 成功產生並回傳 PPT 連結! Url: ${url.substring(0, 50)}...`);

    } catch (err) {
        console.error(`❌ [PPT Generator Error]`, err);
        await lineClient.pushMessage({
            to: event.source.userId,
            messages: [{ type: 'text', text: `⚠️ 簡報產生失敗，系統發生未預期錯誤。` }]
        });
    }
}

module.exports = { processPptExport };
