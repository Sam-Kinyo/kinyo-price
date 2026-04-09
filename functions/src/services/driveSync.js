const { google } = require('googleapis');
const { admin, db } = require('../utils/firebase');
const path = require('path');
const stream = require('stream');
const { getBaseModelForImages } = require('../utils/imageUtils');

const TARGET_FOLDER_ID = "1Vv8tO1IjxtI-R2SiNcpdOeKkH0saqKDI";
const SERVICE_ACCOUNT_FILE = path.join(__dirname, '../../credentials.json');

// 初始化 Google Auth
let driveService = null;
function getDriveService() {
    if (!driveService) {
        const auth = new google.auth.GoogleAuth({
            keyFile: SERVICE_ACCOUNT_FILE,
            scopes: ['https://www.googleapis.com/auth/drive.readonly'],
        });
        driveService = google.drive({ version: 'v3', auth });
    }
    return driveService;
}

// 產生帶有 Firebase Auth Token 的公開 URL
const { v4: uuidv4 } = require('uuid');

function getStoragePublicUrl(bucketName, destination, token) {
    if (!token) return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(destination)}?alt=media`;
    return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(destination)}?alt=media&token=${token}`;
}

// 抓取網址
function getFolderLink(fileId) {
    return `https://drive.google.com/drive/folders/${fileId}`;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// --- 同步時間戳記（增量同步用）---
const SYNC_METADATA_COLLECTION = 'SyncMetadata';
const SYNC_METADATA_DOC = 'driveSync';

async function getLastSyncTime() {
    const doc = await db.collection(SYNC_METADATA_COLLECTION).doc(SYNC_METADATA_DOC).get();
    if (doc.exists && doc.data().lastSyncTime) {
        return doc.data().lastSyncTime.toDate();
    }
    return null; // 無紀錄 → 觸發全量同步
}

async function updateLastSyncTime(timestamp) {
    await db.collection(SYNC_METADATA_COLLECTION).doc(SYNC_METADATA_DOC).set({
        lastSyncTime: admin.firestore.Timestamp.fromDate(timestamp),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
}

async function executeWithRetry(apiCall, maxRetries = 5) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await apiCall();
        } catch (e) {
            if (e.code === 403 || e.code === 429 || e.code >= 500) {
                await sleep(Math.pow(2, i) * 1000 + Math.random() * 1000);
            } else {
                throw e;
            }
        }
    }
    return null;
}

async function listFilesInFolder(service, folderId) {
    let results = [];
    let pageToken = null;
    try {
        do {
            const query = `'${folderId}' in parents and trashed = false`;
            const resp = await executeWithRetry(() => service.files.list({
                q: query,
                fields: "nextPageToken, files(id, name, mimeType, modifiedTime)",
                pageToken: pageToken,
                pageSize: 1000
            }));
            
            if (resp && resp.data && resp.data.files) {
                results = results.concat(resp.data.files);
                pageToken = resp.data.nextPageToken;
            } else {
                break;
            }
        } while (pageToken);
    } catch (e) {
        console.error(`❌ 讀取資料夾 ${folderId} 時發生錯誤:`, e);
    }
    return results;
}

function normalizeModelKey(filename) {
    let base = filename.split('.')[0].split('_')[0].split(' ')[0].toUpperCase();
    if (base.startsWith("WV-")) {
        const matchWv = base.match(/^(WV-[A-Z0-9]+)([A-Z]*)$/);
        if (matchWv) return matchWv[1];
        return base;
    }
    const cleanBase = base.replace(/-/g, '');
    const match = cleanBase.match(/^([A-Z]+)(\d+)([A-Z]*)$/);
    if (match) {
        return match[1] + match[2];
    }
    return cleanBase;
}

async function getNetImagesSorted(service, folderId) {
    const items = await listFilesInFolder(service, folderId);
    const imageFiles = items.filter(item => item.mimeType && item.mimeType.includes("image"));
    // 讓 _01 等排前面
    imageFiles.sort((a, b) => a.name.localeCompare(b.name));
    return imageFiles;
}

async function uploadToFirebaseStorage(service, fileId, fileName, modelKey) {
    const bucket = admin.storage().bucket('kinyo-price.firebasestorage.app'); 
    // 若預設 bucket 名稱不同，可以改用 admin.storage().bucket() 讓它抓 Firebase default
    
    const ext = path.extname(fileName) || '.jpg';
    // 檔名加入檔案 ID 以避免衝突並記錄對應關係
    const destFileName = `product_images/${modelKey}/${fileId}${ext}`;
    const file = bucket.file(destFileName);

    const [exists] = await file.exists();
    if (exists) {
        const [metadata] = await file.getMetadata();
        let token = metadata.metadata?.firebaseStorageDownloadTokens;
        if (!token) {
            token = uuidv4();
            await file.setMetadata({
                metadata: { firebaseStorageDownloadTokens: token }
            });
        }
        return getStoragePublicUrl(bucket.name, destFileName, token);
    }

    try {
        console.log(`📥 正在從 GDrive 下載圖片... [${modelKey}] ${fileName}`);
        const response = await executeWithRetry(() => service.files.get({
            fileId: fileId,
            alt: 'media'
        }, { responseType: 'stream' }));

        if (!response || !response.data) throw new Error("GDrive Stream Empty");

        const token = uuidv4();
        await new Promise((resolve, reject) => {
            response.data
                .pipe(file.createWriteStream({
                    metadata: { 
                        contentType: 'image/jpeg',
                        metadata: { firebaseStorageDownloadTokens: token }
                    } 
                }))
                .on('error', err => reject(err))
                .on('finish', () => resolve());
        });

        // 取消 file.makePublic() 因為預設 GCP buckets 通常有 uniform bucket-level access 限制
        return getStoragePublicUrl(bucket.name, destFileName, token);
    } catch (e) {
        console.error(`❌ 下載/上傳失敗 [${fileId}]:`, e);
        return null; // 若失敗回傳 null
    }
}

async function scanRecursive(service, folderId, currentModelData, lastSyncTime = null) {
    const items = await listFilesInFolder(service, folderId);
    for (const item of items) {
        const mime = item.mimeType;
        const fid = item.id;
        const fname = item.name;

        if (mime === "application/vnd.google-apps.folder") {
            const lowerName = fname.toLowerCase();
            if (fname.includes("網路圖") || fname.includes("網") || fname.includes("Net") || lowerName.includes("net")) {
                // 增量模式：跳過未更新的 Net 資料夾
                if (lastSyncTime && item.modifiedTime) {
                    const folderModified = new Date(item.modifiedTime);
                    if (folderModified <= lastSyncTime) {
                        console.log(`   ⏭️ 跳過未更新的 Net 資料夾: ${fname}`);
                        continue;
                    }
                }
                console.log(`   Found Net Folder: ${fname}`);
                const sortedImgs = await getNetImagesSorted(service, fid);
                
                // 並行上傳機制 (加速處理 10 張/批)
                const BATCH_SIZE = 10;
                for (let i = 0; i < sortedImgs.length; i += BATCH_SIZE) {
                    const batch = sortedImgs.slice(i, i + BATCH_SIZE);
                    await Promise.all(batch.map(async (img) => {
                        let storageUrl = currentModelData.driveMapping[img.id];
                        if (!storageUrl) {
                            storageUrl = await uploadToFirebaseStorage(service, img.id, img.name, currentModelData.mainModel);
                            if (storageUrl) {
                                currentModelData.driveMapping[img.id] = storageUrl;
                            }
                        }
                    }));
                }
                
                // 確保 netImages 的順序與 Google Drive 檔名順序 (sortedImgs) 完全一致
                currentModelData.netImages = [];
                for (const img of sortedImgs) {
                    const storageUrl = currentModelData.driveMapping[img.id];
                    if (storageUrl && !currentModelData.netImages.includes(storageUrl)) {
                        currentModelData.netImages.push(storageUrl);
                    }
                }
                
                // 設定 mainImage 永遠為 netImages 的第一張 (如果有的話)
                if (currentModelData.netImages.length > 0) {
                    currentModelData.mainImage = currentModelData.netImages[0];
                }
                currentModelData.netFolderUrl = getFolderLink(fid);
            } else {
                await scanRecursive(service, fid, currentModelData, lastSyncTime);
            }
        }
    }
}

async function runStorageSync(startIndex = 0, targetModel = null, { incremental = false } = {}) {
    const startTime = Date.now();
    const syncStartTime = new Date(); // 記錄在處理前，避免漏掉處理期間的新變更

    // 增量模式：讀取上次同步時間
    let lastSyncTime = null;
    if (incremental && !targetModel) {
        lastSyncTime = await getLastSyncTime();
        if (!lastSyncTime) {
            console.log('⚠️ 找不到上次同步時間，自動降級為全量同步。');
        } else {
            console.log(`🔄 增量模式：只處理 ${lastSyncTime.toISOString()} 之後有更新的資料夾`);
        }
    }

    console.log(`🔍 開始背景同步 GDrive 圖庫 (${incremental && lastSyncTime ? '增量' : '全量'}模式) ... 處理索引 ${startIndex} 之後${targetModel ? `, 目標型號: ${targetModel}` : ''}`);
    try {
        const service = getDriveService();
        const rootItems = await listFilesInFolder(service, TARGET_FOLDER_ID);
        // 按名稱排序確保分批接力時順序一致
        rootItems.sort((a, b) => a.name.localeCompare(b.name));
        console.log(`✅ 根目錄共找到 ${rootItems.length} 個項目`);

        let count = startIndex;
        let skippedCount = 0;
        for (let i = startIndex; i < rootItems.length; i++) {
            const item = rootItems[i];
            count++;
            if (count % 10 === 0) console.log(`⏳ 進度: ${count}/${rootItems.length}... (跳過: ${skippedCount})`);

            // 如果執行時間超過 7.5 分鐘 (450,000 毫秒)，中斷並回傳接續點
            if (Date.now() - startTime > 450000) {
                console.log(`⚠️ 執行時間已達 7.5 分鐘，暫停目前批次，準備回傳接力 (下一個索引: ${i})`);
                return { success: true, continueFrom: i, total: rootItems.length, incremental };
            }

            const name = item.name;
            const fid = item.id;
            const mime = item.mimeType;

            const mainModel = getBaseModelForImages(name);
            if (!mainModel) continue; // Skip invalid folders

            // 單機強制更新特定型號機制：如果提供了 targetModel，就只讓它通過
            if (targetModel && mainModel !== getBaseModelForImages(targetModel)) {
                continue;
            }

            // 增量模式：跳過未更新的根層級型號資料夾
            if (lastSyncTime && item.modifiedTime) {
                const folderModified = new Date(item.modifiedTime);
                if (folderModified <= lastSyncTime) {
                    skippedCount++;
                    continue;
                }
            }

            const docRef = db.collection('ProductImages').doc(mainModel);
            const docSnap = await docRef.get();

            let currentModelData = docSnap.exists ? docSnap.data() : {
                mainModel: mainModel,
                mainImage: "",
                netImages: [],
                folderUrl: "",
                netFolderUrl: "",
                driveMapping: {}
            };
            currentModelData.mainModel = mainModel;
            currentModelData.driveMapping = currentModelData.driveMapping || {};
            currentModelData.netImages = currentModelData.netImages || [];
            if (mime === "application/vnd.google-apps.folder") {
                currentModelData.folderUrl = getFolderLink(fid);
                await scanRecursive(service, fid, currentModelData, lastSyncTime);
            }

            // 將結果寫回 Firestore
            currentModelData.netImages = [...new Set(currentModelData.netImages)];
            await docRef.set(currentModelData, { merge: true });

            await sleep(50); // 防節流
        }

        // 同步完成（非 continueFrom 中斷）才寫入時間戳記
        await updateLastSyncTime(syncStartTime);

        const modeLabel = incremental && lastSyncTime ? '增量' : '全量';
        console.log(`🎉 圖庫${modeLabel}同步完成！跳過 ${skippedCount} 個未更新型號。`);
        return { success: true, message: `Sync finished successfully. Skipped: ${skippedCount}`, incremental };
    } catch (err) {
        console.error("同步遭遇錯誤:", err);
        return { success: false, error: err.message };
    }
}

module.exports = { runStorageSync };
