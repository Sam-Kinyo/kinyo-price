// src/workflows/faqWorkflow.js

/**
 * 產生維修指南的 Flex Message 卡片
 * @returns {Object} LINE Flex Message Object
 */
function getRepairFlexMessage() {
    return {
        type: "flex",
        altText: "產品維修與寄件指南",
        contents: {
            type: "bubble",
            size: "kilo",
            header: {
                type: "box",
                layout: "vertical",
                contents: [{ type: "text", text: "🔧 產品維修與寄件指南", color: "#ffffff", weight: "bold", size: "md" }],
                backgroundColor: "#d32f2f",
                paddingAll: "15px"
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "本公司商品享有一年保固。請將商品寄回本公司維修部，修復後我們將為您寄回。", wrap: true, size: "sm", color: "#666666" },
                    { type: "separator", margin: "md" },
                    {
                        type: "box", layout: "vertical", margin: "md",
                        contents: [
                            { type: "text", text: "📍 寄送資訊", weight: "bold", size: "sm", color: "#111111" },
                            { type: "text", text: "收件人：耐嘉維修部", size: "sm", color: "#666666", margin: "sm" },
                            { type: "text", text: "電話：03-5396627", size: "sm", color: "#666666" },
                            { type: "text", text: "地址：300新竹市東區經國路一段187號", size: "sm", color: "#666666", wrap: true }
                        ]
                    },
                    { type: "separator", margin: "md" },
                    {
                        type: "box", layout: "vertical", margin: "md",
                        contents: [
                            { type: "text", text: "📦 包裹內請務必附上紙條註明：", weight: "bold", size: "sm", color: "#d32f2f" },
                            { type: "text", text: "1. 故障原因\n2. 聯絡人姓名與電話\n3. 寄回地址\n4. 購買證明 (發票或收據)", size: "sm", color: "#666666", wrap: true, margin: "sm" }
                        ]
                    },
                    { type: "separator", margin: "md" },
                    {
                        type: "box", layout: "vertical", margin: "md",
                        contents: [
                            { type: "text", text: "📞 使用問題詢問：03-5396627", size: "xs", color: "#aaaaaa" },
                            { type: "text", text: "📱 線上客服 LINE ID：@kinyo", size: "xs", color: "#aaaaaa" }
                        ]
                    }
                ]
            }
        }
    };
}

/**
 * 產生操作指南的 Flex Message 卡片
 */
function getUserGuideFlexMessage() {
    return {
        type: "flex",
        altText: "『挺好的』操作指南",
        contents: {
            type: "bubble",
            size: "giga",
            header: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "🤖 『挺好的』助手操作指南", weight: "bold", size: "lg", color: "#ffffff" }
                ],
                backgroundColor: "#0055aa",
                paddingAll: "15px"
            },
            body: {
                type: "box",
                layout: "vertical",
                spacing: "lg",
                contents: [
                    {
                        type: "box", layout: "vertical", spacing: "sm",
                        contents: [
                            { type: "text", text: "⚠️ 溫馨提示", weight: "bold", color: "#d32f2f", size: "sm" },
                            { type: "text", text: "在群組中呼叫機器人時，記得一定要標註 @KINYO挺好的 哦！", wrap: true, size: "sm", color: "#555555" }
                        ]
                    },
                    { type: "separator" },
                    {
                        type: "box", layout: "vertical", spacing: "sm",
                        contents: [
                            { type: "text", text: "🔍 1. 快速商品查價", weight: "bold", color: "#1DB446" },
                            { type: "text", text: "輸入『商品型號(如: kh198)』『商品名稱(如: 吹風機)』或是各種口語都支援查詢。也可以輸入預算區間與數量，自動跳出商品推薦。", wrap: true, size: "sm", color: "#666666" }
                        ]
                    },
                    { type: "separator" },
                    {
                        type: "box", layout: "vertical", spacing: "sm",
                        contents: [
                            { type: "text", text: "🛒 2. 自動下單與特殊申請建立", weight: "bold", color: "#E11D48" },
                            { type: "text", text: "輸入『訂單』；『客服』；『借樣』；『維修』；『新品不良』；都會有不同的模板指引方向，快速建立。", wrap: true, size: "sm", color: "#666666" }
                        ]
                    },
                    { type: "separator" },
                    {
                        type: "box", layout: "vertical", spacing: "sm",
                        contents: [
                            { type: "text", text: "📁 3. 專屬圖庫", weight: "bold", color: "#8a2be2" },
                            { type: "text", text: "輸入『商品型號』+『商品大圖』 (如： kh198商品大圖)，機器人立刻送上連結。", wrap: true, size: "sm", color: "#666666" }
                        ]
                    }
                ]
            }
        }
    };
}

/**
 * 處理 FAQ 相關請求
 * @param {Object} event - LINE event object
 * @param {Object} client - LINE Messaging API client
 * @param {string} faqType - FAQ 類型 (例如: 'repair')
 */
async function handleFaqRequest(event, client, faqType) {
    if (faqType === 'repair') {
        const message = getRepairFlexMessage();
        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [message]
        });
    } else if (faqType === 'user_guide') {
        const message = getUserGuideFlexMessage();
        await client.replyMessage({
            replyToken: event.replyToken,
            messages: [message]
        });
    }
}

module.exports = {
    getRepairFlexMessage,
    getUserGuideFlexMessage,
    handleFaqRequest
};
