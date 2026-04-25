/**
 * commandRegistry.js
 * LINE Bot 指令觸發表 — 完全相等才觸發
 *
 * 客戶端自然語言查價（型號、價格區間）走 Gemini，不在此處攔截。
 * 行動屋出貨 prefix 仍在 Gemini，因為後面要帶訂單資料。
 */

const COMMAND_ALIASES = new Map();

const REGISTRY = [
    { action: 'borrow_sample',    aliases: ['借樣品', '樣品', '借樣'] },
    { action: 'order',            aliases: ['訂單', '下單'] },
    { action: 'reserve_order',    aliases: ['預留', '預留訂單', '留貨', '訂單預留'] },
    { action: 'defective_return', aliases: ['來回件', '新品不良'] },
    { action: 'quote_sheet',      aliases: ['報價單'] },
    { action: 'repair_info',      aliases: ['客服', '維修', '維修地址'] },
    { action: 'user_guide',       aliases: ['教學', '使用教學'] },
    { action: 'shipping_info',    aliases: ['寄件地址', '收件資訊', '寄回資訊', '商品寄回', '寄件', '寄件資訊'] },
    { action: 'help',             aliases: ['指令'] },
];

for (const { action, aliases } of REGISTRY) {
    for (const alias of aliases) {
        COMMAND_ALIASES.set(alias, action);
    }
}

const FUZZY_ALLOWLIST = [
    '借樣品', '預留訂單', '訂單預留', '來回件', '新品不良',
    '報價單', '維修地址', '使用教學',
    '寄件地址', '寄件資訊', '收件資訊', '寄回資訊', '商品寄回',
];

function lookupCommand(cleanText) {
    if (!cleanText) return null;
    return COMMAND_ALIASES.get(cleanText) || null;
}

function findFuzzyMatch(cleanText) {
    if (!cleanText) return null;
    if (COMMAND_ALIASES.has(cleanText)) return null;
    for (const keyword of FUZZY_ALLOWLIST) {
        if (cleanText.includes(keyword)) return keyword;
    }
    return null;
}

module.exports = {
    COMMAND_ALIASES,
    FUZZY_ALLOWLIST,
    lookupCommand,
    findFuzzyMatch,
};
