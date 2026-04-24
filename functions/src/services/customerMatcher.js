/**
 * customerMatcher.js
 * 以公司名稱（全稱/簡稱）比對 Customers 集合，自動回填 customerCode。
 *
 * 用於：借樣品 / 預留訂單 / 新品不良 等「template-paste」流程。
 * 對話式流程（orderConversation / sampleConversation / reserveConversation）已經
 * 自己處理 shortName/fullName 比對，不需要用這個。
 *
 * 匹配策略（越前面優先級越高）：
 *   1. fullName 完全相等
 *   2. shortName 完全相等
 *   3. fullName 或 shortName 雙向 includes（單一結果）
 *
 * 回傳：
 *   { matched: true,  code, shortName, fullName, customer }  → 找到唯一客戶
 *   { matched: false, ambiguous: true, candidates: [...] }   → 多筆符合
 *   { matched: false }                                       → 找不到
 */

const { db } = require('../utils/firebase');

// 常見雜訊：公司後綴、空白、全形括號
function normalize(s) {
    return String(s || '')
        .trim()
        .replace(/[\s　]+/g, '')
        .replace(/[（）()]/g, '')
        .replace(/股份有限公司|有限公司|企業社|商行|行|公司$/g, '');
}

async function matchCustomerByCompany(companyText) {
    const raw = String(companyText || '').trim();
    if (!raw) return { matched: false };

    const snap = await db.collection('Customers').get();
    const all = [];
    snap.forEach(d => {
        const data = d.data();
        all.push({ id: d.id, ...data });
    });

    // 1. fullName 完全相等
    let hits = all.filter(c => (c.fullName || '').trim() === raw);
    if (hits.length === 1) return hitResult(hits[0]);

    // 2. shortName 完全相等
    hits = all.filter(c => (c.shortName || '').trim() === raw);
    if (hits.length === 1) return hitResult(hits[0]);

    // 3. normalize 後相等（去掉「有限公司」等後綴）
    const rawNorm = normalize(raw);
    if (rawNorm) {
        hits = all.filter(c => {
            const fn = normalize(c.fullName);
            const sn = normalize(c.shortName);
            return fn === rawNorm || sn === rawNorm;
        });
        if (hits.length === 1) return hitResult(hits[0]);
        if (hits.length > 1) return ambiguousResult(hits);
    }

    // 4. 雙向 includes
    hits = all.filter(c => {
        const fn = (c.fullName || '').trim();
        const sn = (c.shortName || '').trim();
        if (!fn && !sn) return false;
        return (fn && (fn.includes(raw) || raw.includes(fn)))
            || (sn && (sn.includes(raw) || raw.includes(sn)));
    });
    if (hits.length === 1) return hitResult(hits[0]);
    if (hits.length > 1) return ambiguousResult(hits);

    return { matched: false };
}

function hitResult(c) {
    return {
        matched: true,
        code: c.code || c.id || '',
        shortName: c.shortName || '',
        fullName: c.fullName || '',
        customer: c,
    };
}

function ambiguousResult(candidates) {
    return {
        matched: false,
        ambiguous: true,
        candidates: candidates.slice(0, 5).map(c => ({
            code: c.code || c.id || '',
            shortName: c.shortName || '',
            fullName: c.fullName || '',
        })),
    };
}

module.exports = { matchCustomerByCompany };
