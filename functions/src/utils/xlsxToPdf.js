/**
 * xlsxToPdf.js
 * 用 Google Drive API 把 xlsx buffer 轉成 PDF buffer。
 *
 * 流程:
 *   1. upload xlsx → 轉成 Google Sheets 格式 (mimeType: application/vnd.google-apps.spreadsheet)
 *   2. files.export({mimeType: 'application/pdf'}) → PDF buffer
 *   3. 刪除 temp Google Sheet
 *
 * 需求: credentials.json (service account) 已存在,Drive API 已啟用。
 */

const { google } = require('googleapis');
const path = require('path');
const { Readable } = require('stream');

const SERVICE_ACCOUNT_FILE = path.join(__dirname, '..', '..', 'credentials.json');
// 共用資料夾 (擁有者: kuo.tinghow@gmail.com,15GB 配額)
// service account 對此資料夾有 editor 權限 → upload 配額算 owner 的
const TEMP_FOLDER_ID = '1rfr21dbZXXvpOHrx0QDKZ8V1M2-d_NhF';

let _drive = null;
function getDriveWriteClient() {
    if (!_drive) {
        const auth = new google.auth.GoogleAuth({
            keyFile: SERVICE_ACCOUNT_FILE,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });
        _drive = google.drive({ version: 'v3', auth });
    }
    return _drive;
}

function bufferToStream(buf) {
    const s = new Readable();
    s.push(buf);
    s.push(null);
    return s;
}

/**
 * @param {Buffer} xlsxBuffer
 * @param {string} displayName - temp Google Sheet 名稱 (會 immediate 刪掉)
 * @returns {Promise<Buffer>} PDF buffer
 */
async function convertXlsxToPdf(xlsxBuffer, displayName = 'temp_quote_sheet') {
    const drive = getDriveWriteClient();

    // 1. upload + convert to Google Sheets
    const createResp = await drive.files.create({
        requestBody: {
            name: displayName,
            mimeType: 'application/vnd.google-apps.spreadsheet',
            parents: [TEMP_FOLDER_ID],
        },
        media: {
            mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            body: bufferToStream(xlsxBuffer),
        },
        fields: 'id',
        supportsAllDrives: true,
    });
    const fileId = createResp.data.id;
    if (!fileId) throw new Error('Drive upload 沒有回傳 fileId');

    try {
        // 2. export as PDF
        const exportResp = await drive.files.export(
            { fileId, mimeType: 'application/pdf' },
            { responseType: 'arraybuffer' }
        );
        return Buffer.from(exportResp.data);
    } finally {
        // 3. cleanup (即使 export 失敗也刪掉)
        drive.files.delete({ fileId, supportsAllDrives: true }).catch((err) => {
            console.warn(`[xlsxToPdf] 清理 temp file 失敗 ${fileId}:`, err.message);
        });
    }
}

module.exports = { convertXlsxToPdf };
