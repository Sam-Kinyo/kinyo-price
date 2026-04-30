/**
 * OEM 產品批量匯入工具
 *
 * 支援兩種輸入：
 *   (1) 金葉 ERP 下載的 xlsx (產品價格查詢匯出檔)
 *   (2) 簡單 CSV (customer_email, model, name, stock, image_url, notes)
 *
 * 使用方式：
 *   cd kinyo-price/functions
 *
 *   # 從 ERP xlsx 匯入（必須指定該檔屬於哪個 OEM 客戶）
 *   node scripts/import-oem-products.js "C:/.../5.產品價格查詢.xlsx" --owner=oem-acme@kinyo.com
 *
 *   # 從 CSV 匯入（CSV 首欄就帶 customer_email）
 *   node scripts/import-oem-products.js path/to/oem-stock.csv
 *
 * 庫存計算（xlsx 模式）：可用 = 成品倉 + 專賣倉 - 總預留（不會小於 0）
 *
 * 行為：
 *   - 同一 owner 內，model 為唯一 key
 *   - 已存在 → 更新；不存在 → 新增
 *   - 該 owner 下未出現在本批次的 model → soft delete (deleted=true, stock=0)
 *
 * 安全：寫入透過 Admin SDK；firestore.rules 拒絕所有前端寫入 OEMProducts。
 */

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');

// 本機跑 admin SDK 時需要明確 project ID（部署在 Cloud Functions 時會自動帶）
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'kinyo-price';
const { db, admin } = require('../src/utils/firebase');

const CSV_REQUIRED = ['customer_email', 'model', 'name', 'stock'];

// xlsx 欄位對應 (金葉 ERP「產品價格查詢」匯出格式)
const XLSX_COL = {
    bigCategory: 2,      // 大類別
    model: 4,            // 產品代碼 (例: A1101)
    nameWithCode: 5,     // 含代碼的全名 (例: "A-1101 多合一旅行萬國轉接頭")
    saleStatus: 7,       // 銷售狀態 (OEM)
    netStatus: 8,        // 網銷狀態
    barcode: 12,
    factoryPrice: 13,    // 廠價
    mainStock: 22,       // 成品倉
    retailStock: 23,     // 專賣倉
    reserved: 24,        // 總預留
    confirmIncoming1: 25,
    confirmIncoming2: 26,
    plannedIncoming1: 27,
    plannedIncoming2: 28,
    plannedIncoming3: 29,
    unfulfilled: 30,     // 未交單
};
const XLSX_DATA_START_ROW = 4;   // R1=結果筆數, R2-R3=表頭, R4起=資料

// ---- CSV ----
function parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = []; let row = []; let field = ''; let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else inQuotes = false;
            } else field += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === ',') { row.push(field); field = ''; }
            else if (ch === '\r') {}
            else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
            else field += ch;
        }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    return rows.filter(r => !(r.length === 1 && r[0].trim() === ''));
}

function readCSVRecords(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const rows = parseCSV(raw);
    if (rows.length < 2) throw new Error('CSV 至少需要一行標題 + 一行資料');
    const header = rows[0].map(h => h.trim().toLowerCase());
    for (const c of CSV_REQUIRED) {
        if (!header.includes(c)) throw new Error(`CSV 缺少必要欄位: ${c}`);
    }
    return rows.slice(1)
        .map(r => {
            const rec = {};
            header.forEach((col, idx) => { rec[col] = (r[idx] ?? '').trim(); });
            return rec;
        })
        .filter(r => r.customer_email && r.model)
        .map(r => ({
            ownerEmail: r.customer_email.toLowerCase(),
            model: r.model,
            name: r.name || r.model,
            stock: Number(r.stock) || 0,
            imageUrl: r.image_url || '',
            notes: r.notes || '',
            extra: {},
        }));
}

// ---- XLSX (金葉 ERP 格式) ----
function cellNum(cell) {
    if (cell == null) return 0;
    const v = cell.value;
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && v.result != null) return Number(v.result) || 0;
    const n = Number(String(v).replace(/,/g, ''));
    return Number.isNaN(n) ? 0 : n;
}
function cellStr(cell) {
    if (cell == null) return '';
    const v = cell.value;
    if (v == null) return '';
    if (typeof v === 'object') return String(v.text || v.result || '').trim();
    return String(v).trim();
}

// "A-1101 多合一旅行萬國轉接頭" → { code: "A-1101", name: "多合一旅行萬國轉接頭" }
// "WD-01可折疊負離子吹風機" → { code: "WD-01", name: "可折疊負離子吹風機" }
// "MSG-1 隨身舒緩按摩槍" → { code: "MSG-1", name: "隨身舒緩按摩槍" }
function splitNameWithCode(s) {
    if (!s) return { code: '', name: '' };
    const m = s.match(/^([A-Za-z0-9\-]+)[\s　]*(.*)$/);
    if (m && m[1]) return { code: m[1].trim(), name: m[2].trim() };
    return { code: '', name: s };
}

async function readXLSXRecords(filePath, ownerEmail) {
    if (!ownerEmail) throw new Error('xlsx 模式必須加 --owner=<email> 參數');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];

    const records = [];
    for (let r = XLSX_DATA_START_ROW; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        const model = cellStr(row.getCell(XLSX_COL.model));
        if (!model) continue;

        const nameWithCode = cellStr(row.getCell(XLSX_COL.nameWithCode));
        const { code: displayModel, name: cleanName } = splitNameWithCode(nameWithCode);
        const mainStock = cellNum(row.getCell(XLSX_COL.mainStock));
        const retailStock = cellNum(row.getCell(XLSX_COL.retailStock));
        const reserved = cellNum(row.getCell(XLSX_COL.reserved));
        const stock = Math.max(0, mainStock + retailStock - reserved);

        const incomingConfirmed = cellNum(row.getCell(XLSX_COL.confirmIncoming1))
            + cellNum(row.getCell(XLSX_COL.confirmIncoming2));
        const incomingPlanned = cellNum(row.getCell(XLSX_COL.plannedIncoming1))
            + cellNum(row.getCell(XLSX_COL.plannedIncoming2))
            + cellNum(row.getCell(XLSX_COL.plannedIncoming3));

        records.push({
            ownerEmail: ownerEmail.toLowerCase(),
            model,
            displayModel: displayModel || model,
            name: cleanName || nameWithCode || model,
            stock,
            imageUrl: '',
            notes: '',
            extra: {
                bigCategory: cellStr(row.getCell(XLSX_COL.bigCategory)),
                saleStatus: cellStr(row.getCell(XLSX_COL.saleStatus)),
                netStatus: cellStr(row.getCell(XLSX_COL.netStatus)),
                barcode: cellStr(row.getCell(XLSX_COL.barcode)),
                mainStock,
                retailStock,
                reserved,
                incomingConfirmed,
                incomingPlanned,
                unfulfilled: cellNum(row.getCell(XLSX_COL.unfulfilled)),
            },
        });
    }
    return records;
}

// ---- Common ----
function genBatchId() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function commitInChunks(writes) {
    let chunk = db.batch(); let n = 0; let total = 0;
    for (const w of writes) {
        w(chunk); n++; total++;
        if (n >= 450) { await chunk.commit(); chunk = db.batch(); n = 0; }
    }
    if (n > 0) await chunk.commit();
    return total;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const out = { file: null, owner: null };
    for (const a of args) {
        if (a.startsWith('--owner=')) out.owner = a.slice('--owner='.length);
        else if (!out.file) out.file = a;
    }
    return out;
}

async function main() {
    const { file, owner } = parseArgs();
    if (!file) {
        console.error('用法: node scripts/import-oem-products.js <檔案路徑> [--owner=<email>]');
        console.error('  - .xlsx 必須帶 --owner');
        console.error('  - .csv 首欄就要有 customer_email');
        process.exit(1);
    }
    const absPath = path.resolve(file);
    if (!fs.existsSync(absPath)) {
        console.error(`找不到檔案: ${absPath}`);
        process.exit(1);
    }

    const ext = path.extname(absPath).toLowerCase();
    let records;
    if (ext === '.xlsx' || ext === '.xlsm') {
        console.log(`📑 讀取 xlsx: ${absPath}`);
        console.log(`👤 owner: ${owner}`);
        records = await readXLSXRecords(absPath, owner);
    } else if (ext === '.csv') {
        console.log(`📑 讀取 csv: ${absPath}`);
        records = readCSVRecords(absPath);
    } else {
        console.error(`不支援的副檔名: ${ext}`);
        process.exit(1);
    }

    if (records.length === 0) {
        console.error('檔案裡沒有有效的資料行');
        process.exit(1);
    }

    const batchId = genBatchId();
    console.log(`📦 批次 ID: ${batchId}`);
    console.log(`📄 共 ${records.length} 筆資料`);

    const byOwner = new Map();
    for (const rec of records) {
        if (!byOwner.has(rec.ownerEmail)) byOwner.set(rec.ownerEmail, []);
        byOwner.get(rec.ownerEmail).push(rec);
    }

    const writes = [];
    let createCount = 0, updateCount = 0, softDeleteCount = 0;

    for (const [ownerKey, ownerRecords] of byOwner.entries()) {
        console.log(`\n👤 ${ownerKey}: ${ownerRecords.length} 筆`);
        const existingSnap = await db.collection('OEMProducts')
            .where('ownerEmail', '==', ownerKey).get();
        const existingByModel = new Map();
        existingSnap.forEach(doc => existingByModel.set(doc.data().model, doc));

        const seenModels = new Set();
        for (const rec of ownerRecords) {
            if (seenModels.has(rec.model)) {
                console.warn(`  ⚠️  重複 model: ${rec.model}（後者覆蓋前者）`);
            }
            seenModels.add(rec.model);

            const payload = {
                ownerEmail: rec.ownerEmail,
                model: rec.model,
                displayModel: rec.displayModel || rec.model,
                name: rec.name,
                stock: rec.stock,
                imageUrl: rec.imageUrl,
                notes: rec.notes,
                extra: rec.extra || {},
                deleted: false,
                batchId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };

            const existing = existingByModel.get(rec.model);
            if (existing) {
                writes.push(b => b.update(existing.ref, payload));
                updateCount++;
            } else {
                const newRef = db.collection('OEMProducts').doc();
                payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
                writes.push(b => b.set(newRef, payload));
                createCount++;
            }
        }

        for (const [m, doc] of existingByModel.entries()) {
            if (!seenModels.has(m) && doc.data().deleted !== true) {
                writes.push(b => b.update(doc.ref, {
                    deleted: true, stock: 0, batchId,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }));
                softDeleteCount++;
            }
        }
    }

    console.log(`\n📤 寫入：新增 ${createCount} / 更新 ${updateCount} / soft delete ${softDeleteCount}`);
    if (writes.length === 0) { console.log('沒有變更。'); process.exit(0); }
    const total = await commitInChunks(writes);
    console.log(`✅ 完成（共 ${total} 筆寫入，批次 ${batchId}）`);
    process.exit(0);
}

main().catch(err => {
    console.error('❌ 匯入失敗:', err);
    process.exit(1);
});
