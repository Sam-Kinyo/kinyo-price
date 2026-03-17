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
    }
}

module.exports = {
    getRepairFlexMessage,
    handleFaqRequest
};
