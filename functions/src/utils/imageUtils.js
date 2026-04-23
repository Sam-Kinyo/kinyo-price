const { db } = require('./firebase');

const getBaseModelForImages = (modelName) => {
    if (!modelName) return '';
    
    // 特例優先處理：WV-KHP1230 系列 (涵蓋各種格式與中文前綴)
    const upperName = modelName.toUpperCase();
    if (upperName.includes('WV-KHP1230') || upperName.includes('WV-KHP-1230') || upperName.includes('WVKHP1230')) {
        return 'WV-KHP1230';
    }

    // 1. 去副檔名 + 2. 切割底線 + 3. 切割空白
    let base = modelName.split('.')[0].split('_')[0].split(' ')[0].toUpperCase();
    
    // 4. 特例處理：WV- 開頭 (保留 WV-KHP1230 等一般格式)
    if (base.startsWith("WV-")) {
        const matchWv = base.match(/^(WV-[A-Z0-9]+)([A-Z]*)$/);
        if (matchWv) return matchWv[1];
        return base;
    }

    // 5. 一般處理：去除連字號
    let cleanBase = base.replace(/-/g, '');
    
    // 6. 抓取核心 (英文字母+數字)，忽略後面的色碼
    const match = cleanBase.match(/^([A-Z]+)(\d+)([A-Z]*)$/);
    if (match) {
        return match[1] + match[2];
    }
    
    return cleanBase;
};

function normalizeFirebaseUrl(url) {
    if (!url || typeof url !== 'string') return url;
    // 不再轉換為 storage.googleapis.com，直接使用帶有 token 的 firebasestorage 連結，避免 403 Forbidden
    return url;
}

function enforceHttps(url) {
    if (!url || typeof url !== 'string') return null;
    let strUrl = url.trim();
    if (!strUrl) return null;
    if (strUrl.startsWith('//')) {
        return 'https:' + strUrl;
    } else if (strUrl.startsWith('http://')) {
        return strUrl.replace('http://', 'https://');
    } else if (strUrl.startsWith('/')) {
        return 'https://www.kinyo.tw' + strUrl;
    } else if (!strUrl.startsWith('http')) {
        return 'https://www.kinyo.tw/' + strUrl;
    }
    return strUrl;
}

async function getImageUrl(modelName, fallbackProductImageUrl = null) {
    // 預設佔位圖片 (改用乾淨直連的 png 避免 LINE 無法載入)
    const validFallback = enforceHttps(fallbackProductImageUrl);
    const fallbackUrl = validFallback || "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ac/No_image_available.svg/600px-No_image_available.svg.png";
    if (!modelName) return fallbackUrl;

    // 1. 取得去色的主型號
    const targetModel = getBaseModelForImages(modelName);

    try {
        const docSnap = await db.collection('ProductImages').doc(targetModel).get();
        if (docSnap.exists) {
            const data = docSnap.data();
            if (data.netImages && data.netImages.length > 0 && data.netImages[0]) {
                return normalizeFirebaseUrl(data.netImages[0]);
            }
            if (data.mainImage) {
                return normalizeFirebaseUrl(data.mainImage);
            }
        }
    } catch (err) {
        console.error(`[getImageUrl] Failed to fetch image for ${targetModel}:`, err);
    }
    return fallbackUrl;
}

module.exports = { getBaseModelForImages, getImageUrl };
