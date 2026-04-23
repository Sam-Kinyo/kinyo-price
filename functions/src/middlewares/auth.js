const crypto = require('crypto'); // Node.js 內建的加密模組，用來產生 UUID
const { db } = require('../utils/firebase'); // 引入 Firestore db

const authCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 分鐘

/**
 * 驗證使用者與群組權限，並回傳完整的上下文狀態 (Context)
 * @param {Object} event - LINE Webhook 傳來的單一 event
 * @returns {Promise<Object>} 包含授權狀態、使用者等級與 traceId 的物件
 */
async function validateAuth(event) {
    // 1. 產生這個 Request 的專屬身分證 (取 UUID 前 8 碼，好唸又好查)
    const traceId = crypto.randomUUID().split('-')[0]; 
    
    console.log(`[${traceId}] ➡️ 開始解析新訊息，來源: ${event.source.type}`);

    const userId = event.source.userId;
    const groupId = event.source.groupId || null;
    const sourceType = event.source.type;
    
    // 建立快取鍵值 (Cache Key)
    const cacheKey = sourceType === 'group' ? 'group_' + groupId : 'user_' + userId;

    // 攔截與讀取快取 (Cache Hit)
    if (authCache.has(cacheKey)) {
        const cached = authCache.get(cacheKey);
        if (Date.now() < cached.expiresAt) {
            // 取出快取的 context，並將當前的 traceId 覆寫進去
            const userContext = { ...cached.data, traceId: traceId };
            console.log(`[${traceId}] ⚡ [Cache Hit] 從快取取得授權狀態 (Level: ${userContext.level})`);
            return userContext;
        }
    }

    // 2. 預設的 Context 狀態，把 traceId 綁定進去一路往下傳
    let userContext = {
        traceId: traceId,       // 🔥 核心：未來的每個模組都能讀取到這組號碼
        isAuthorized: false,
        uid: userId,
        groupId: groupId,
        level: 0,
        realLevel: 0,
        currentViewLevel: null,
        isVip: false,
        userEmail: "Group_User",
        sourceType: sourceType,
        rejectReason: null
    };

    try {
        console.log(`[${traceId}] 正在向 Firestore 查詢使用者/群組權限...`);
        
        const isGroup = sourceType === 'group' || sourceType === 'room';

        if (isGroup) {
            // 若是群組且是文字訊息，不論有無綁定權限，都必須有提到 @KINYO挺好的 才能處理，否則全部靜默忽略
            if (event.type === 'message' && (!event.message.text || !event.message.text.includes('@KINYO挺好的'))) {
                userContext.rejectReason = 'SILENT_IGNORE';
                return userContext;
            }

            const groupDoc = await db.collection('Groups').doc(groupId).get();
            if (groupDoc.exists && groupDoc.data().level) {
                userContext.currentViewLevel = parseInt(groupDoc.data().level) || 0;
                userContext.realLevel = userContext.currentViewLevel;
                userContext.level = userContext.currentViewLevel;
                userContext.isAuthorized = true;
            } else {
                userContext.rejectReason = 'group_no_permission';
                return userContext;
            }
        } else {
            const userSnapshot = await db.collection('Users').where('line_uid', '==', userId).limit(1).get();
            if (!userSnapshot.empty) {
                const userDocData = userSnapshot.docs[0].data();
                userContext.userEmail = userSnapshot.docs[0].id;
                if (userDocData.level) {
                    userContext.realLevel = parseInt(userDocData.level) || 0;
                    userContext.level = parseInt(userDocData.currentViewLevel) || userContext.realLevel;
                    userContext.isVip = !!userDocData.vipColumn;
                    userContext.currentViewLevel = userContext.level;

                    if (userContext.realLevel < 1 && !userContext.isVip) {
                        userContext.rejectReason = 'user_no_permission';
                        return userContext;
                    }
                    userContext.isAuthorized = true;
                } else {
                    userContext.rejectReason = 'user_no_permission';
                    return userContext;
                }
            } else {
                userContext.rejectReason = 'user_not_bound';
                return userContext;
            }
        }
        
        console.log(`[${traceId}] ✅ 權限驗證通過 (Level: ${userContext.level})`);
        
        // 寫入快取 (Cache Miss/Expired)
        authCache.set(cacheKey, {
            data: { ...userContext },
            expiresAt: Date.now() + CACHE_TTL
        });

        return userContext;

    } catch (error) {
        // 印出錯誤時，務必帶上 traceId
        console.error(`[${traceId}] ❌ [Auth Middleware] 權限驗證發生錯誤:`, error);
        userContext.rejectReason = 'db_error';
        // 邊界處理：發生 db_error 不寫入快取
        return userContext;
    }
}

/**
 * 強制清除指定來源的快取
 * @param {string} sourceType - 'group', 'room', 或 'user'
 * @param {string} id - groupId 或 userId
 */
function clearAuthCache(sourceType, id) {
    const cacheKey = sourceType === 'group' || sourceType === 'room' ? 'group_' + id : 'user_' + id;
    if (authCache.has(cacheKey)) {
        authCache.delete(cacheKey);
        console.log(`[Cache Invalidation] ⚡ 已清除快取: ${cacheKey}`);
    }
}

module.exports = { validateAuth, clearAuthCache };
