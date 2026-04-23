/**
 * conversationState.js
 * 管理使用者對話式 flow 的 state（預留訂單、未來可能的訂單/借樣品）
 * 存放在 Firestore: ConversationStates/{lineUid}
 * TTL: 10 分鐘，超過視為過期（讀取時檢查）
 */

const { admin, db } = require('../utils/firebase');

const TTL_MINUTES = 10;
const COLLECTION = 'ConversationStates';

/**
 * 取得使用者的對話 state；若過期或不存在則 return null，並清掉過期的 doc
 * @param {string} lineUid
 * @returns {Promise<Object|null>}
 */
async function getState(lineUid) {
    if (!lineUid) return null;
    const docRef = db.collection(COLLECTION).doc(lineUid);
    const doc = await docRef.get();
    if (!doc.exists) return null;

    const data = doc.data();
    const updatedAt = data.updatedAt?.toDate?.() || new Date(0);
    const ageMs = Date.now() - updatedAt.getTime();
    if (ageMs > TTL_MINUTES * 60 * 1000) {
        // 過期，刪掉
        await docRef.delete().catch(() => {});
        return null;
    }

    return data;
}

/**
 * 寫入/更新對話 state
 * @param {string} lineUid
 * @param {Object} state - { flow, step, data, groupId?, ... }
 */
async function setState(lineUid, state) {
    if (!lineUid) return;
    const docRef = db.collection(COLLECTION).doc(lineUid);
    await docRef.set({
        ...state,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: false });
}

/**
 * 清除對話 state（使用者取消、完成、或超時）
 * @param {string} lineUid
 */
async function clearState(lineUid) {
    if (!lineUid) return;
    await db.collection(COLLECTION).doc(lineUid).delete().catch(() => {});
}

module.exports = { getState, setState, clearState, TTL_MINUTES };
