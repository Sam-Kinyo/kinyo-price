// src/utils/messagePreprocessor.js
// 負責在送交 Gemini 前清洗與分析訊息

/**
 * 預先處理使用者訊息，判斷是否需要呼叫 AI 大腦，或直接回覆靜態內容
 * @param {string} rawMessage - LINE 傳來的原始文字訊息
 * @returns {Object} { requireAi: boolean, cleanText: string, actionInfo: string|null, intentInfo: string|null }
 */
function analyzeAndCleanMessage(rawMessage) {
    // 1. 清洗掉群組中呼叫機器人的標籤
    let cleanText = rawMessage.replace(/@KINYO挺好的\s*/g, '').trim();

    // 2. Fast Path: 完全比對明確的靜態指令 (極端省成本與時間)
    const exactRepairKeywords = ['維修', '我要維修', '送修', '維修地址', '怎麼修', '客服'];
    if (exactRepairKeywords.includes(cleanText)) {
        return {
            requireAi: false,
            actionInfo: 'repair', // 直接指示系統執行 repair 動作
            intentInfo: 'faq',
            cleanText: cleanText
        };
    }

    // 2.5 Fast Path: 純型號查價判斷 (例如: KBB-123 或 KBB123A)
    const exactModelRegex = /^[A-Z]{2,4}-\d{3,4}[A-Za-z]*$/i; 
    const pureModelRegex = /^[A-Z]{2,4}\d{3,4}[A-Za-z]*$/i;
    
    if (exactModelRegex.test(cleanText) || pureModelRegex.test(cleanText)) {
        return {
            requireAi: false,
            actionInfo: null,
            intentInfo: 'query', // 直接指示系統這是一個查價意圖
            cleanText: cleanText
        };
    }

    // 3. 需要 AI 判斷的複雜語句 (例如：「這台快煮壺壞了，維修費多少？」)
    return {
        requireAi: true,
        actionInfo: null,
        intentInfo: null,
        cleanText: cleanText
    };
}

module.exports = { analyzeAndCleanMessage };
