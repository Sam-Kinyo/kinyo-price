// src/utils/messagePreprocessor.js
// 負責在送交 Gemini 前清洗與分析訊息
// 註：指令完全相等 / 模糊提示已由 commandRegistry 在 webhook 入口攔截，這裡只剩純型號查價與 PPT 匯出 fast path。

/**
 * 預先處理使用者訊息，判斷是否需要呼叫 AI 大腦，或直接回覆靜態內容
 * @param {string} rawMessage - LINE 傳來的原始文字訊息
 * @returns {Object} { requireAi: boolean, cleanText: string, actionInfo: string|null, intentInfo: string|null }
 */
function analyzeAndCleanMessage(rawMessage) {
    // 1. 清洗掉群組中呼叫機器人的標籤
    let cleanText = rawMessage.replace(/@KINYO挺好的\s*/g, '').trim();

    // 2. Fast Path: 純型號查價判斷 (例如: KBB-123 或 KBB123A，以及支援多型號如 KBB-123 Uf168)
    const multiModelRegex = /^([A-Z]{2,4}-?\d{3,4}[A-Za-z]*)(\s+[A-Z]{2,4}-?\d{3,4}[A-Za-z]*)*$/i;
    if (multiModelRegex.test(cleanText)) {
        return {
            requireAi: false,
            actionInfo: null,
            intentInfo: 'query',
            cleanText
        };
    }

    // 3. Fast Path: PPT 產生指令
    const pptMatch = cleanText.match(/^(產生簡報|匯出簡報|產生ppt|匯出ppt)\s*(.+)$/i);
    if (pptMatch) {
        return {
            requireAi: false,
            actionInfo: 'export_ppt',
            intentInfo: 'query',
            cleanText: pptMatch[2].trim()
        };
    }

    // 4. 需要 AI 判斷的複雜語句
    return {
        requireAi: true,
        actionInfo: null,
        intentInfo: null,
        cleanText
    };
}

module.exports = { analyzeAndCleanMessage };
