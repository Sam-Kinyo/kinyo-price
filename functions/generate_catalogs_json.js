const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'credentials.json');
const FOLDER_ID = '15yh6b7K9sTOuQj5HX5o-mhFcn0q4x2wh';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'catalogs.json');

// 情境標籤對照表（可手動調整）
const SCENE_MAP = {
    '01': ['客戶送禮'],
    '02': ['員工福利', '客戶送禮'],
    '03': ['員工福利', '客戶送禮'],
    '04': ['員工福利', '客戶送禮'],
    '05': ['員工福利'],
    '06': ['股東會贈品', '員工福利'],
    '07': ['客戶送禮', '員工福利'],
    '08': ['員工福利'],
    '09': ['股東會贈品'],
    '10': ['尾牙抽獎', '客戶送禮'],
    '11': ['尾牙抽獎', '員工福利'],
    '12': ['員工福利'],
    '13': ['員工福利'],
    '14': ['客戶送禮'],
    '15': ['尾牙抽獎', '員工福利']
};

function cleanTitle(folderName) {
    // 「01_型男老爸選物誌」 → 「型男老爸選物誌」
    // 「14_燈燈燈燈-燈具選購指南」 → 「燈燈燈燈：燈具選購指南」
    return folderName.replace(/^\d+_/, '').replace(/-/g, '：');
}

async function main() {
    const auth = new google.auth.GoogleAuth({
        keyFile: SERVICE_ACCOUNT_FILE,
        scopes: ['https://www.googleapis.com/auth/drive.readonly']
    });
    const drive = google.drive({ version: 'v3', auth });

    console.log('=== 開始掃描 ===');
    const subRes = await drive.files.list({
        q: `'${FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
        orderBy: 'name',
        pageSize: 100
    });
    const folders = subRes.data.files || [];
    console.log(`找到 ${folders.length} 個子資料夾`);

    const catalogs = [];
    for (const folder of folders) {
        const orderMatch = folder.name.match(/^(\d+)_/);
        const order = orderMatch ? parseInt(orderMatch[1]) : 999;
        const orderKey = orderMatch ? orderMatch[1].padStart(2, '0') : '99';

        const imgRes = await drive.files.list({
            q: `'${folder.id}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: 'files(id, name)',
            orderBy: 'name',
            pageSize: 200
        });
        const images = imgRes.data.files || [];

        if (images.length === 0) {
            console.log(`  ⚠️ ${folder.name}: 無圖片，跳過`);
            continue;
        }

        const pages = images.map(img => img.id);
        const cover = pages[0];
        const title = cleanTitle(folder.name);
        const scenes = SCENE_MAP[orderKey] || [];

        catalogs.push({
            id: orderKey,
            order,
            title,
            folderName: folder.name,
            folderId: folder.id,
            cover,
            pageCount: pages.length,
            pages,
            scenes
        });

        console.log(`  ✅ ${folder.name}: ${pages.length} 頁, 情境 [${scenes.join(', ')}]`);
    }

    catalogs.sort((a, b) => a.order - b.order);

    const output = {
        updatedAt: new Date().toISOString(),
        parentFolderId: FOLDER_ID,
        catalogs
    };

    // 確保 data 資料夾存在
    const dataDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2), 'utf8');
    console.log(`\n💾 已輸出: ${OUTPUT_FILE}`);
    console.log(`   ${catalogs.length} 本型錄, 共 ${catalogs.reduce((s, c) => s + c.pageCount, 0)} 頁`);
}

main().then(() => process.exit(0)).catch(e => {
    console.error('❌ 失敗:', e.message);
    process.exit(1);
});
