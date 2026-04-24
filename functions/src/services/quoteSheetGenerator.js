/**
 * quoteSheetGenerator.js
 * 產出管理員報價單 (xlsx),上傳到 Firebase Storage,回傳下載連結。
 *
 * 欄位對照 (Firestore Products):
 *   型號      → model
 *   圖檔      → getImageUrl(model, imageUrl)  // netImages[0] > mainImage > imageUrl
 *   條碼      → internationalBarcode
 *   商品連結  → productUrl (fallback https://www.kinyo.tw/)
 *   箱入數    → cartonQty  (number → "{n}入/箱")
 *   市售價    → marketPrice (電商售價)
 *   報價含稅  → 管理員輸入 unitPrice
 *   數量      → 管理員輸入 qty
 *   總價      → 公式 =qty*unitPrice
 */

const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { fetch } = require('undici');
const { admin, db } = require('../utils/firebase');
const { getImageUrl } = require('../utils/imageUtils');

const FONT = '微軟正黑體';
const KAI = '標楷體';
const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'kinyo_logo.jpg');

const COMPANY = {
    name: '耐嘉股份有限公司',
    address: '地址:新竹市經國路一段187號',
    tel: 'TEL:03-5396966#266',
    fax: 'FAX:03-5396655',
    contact: '聯絡人:郭庭豪',
};

const REMARKS = [
    '備註:',
    '(1) 以上報價為含稅價格,自報價日起30日內有效。',
    '(2) 保固:一年內(非人為因素)。',
    '(3) 付款條件:訂單確認回傳後,請於七日內付三成訂金',
    '              尾款                        請於交貨後當月結算。',
    '(4) 付款帳號:收款銀行 合作金庫 新竹分行',
    '                          戶名 耐嘉股份有限公司 ',
    '                          銀行代碼 006-0176',
    '                          銀行帳號 0170 717 115379   ',
    '                          匯款後, *請提供後五碼* 以便查核,謝謝',
];

function thinBox() {
    return {
        top:    { style: 'thin' },
        bottom: { style: 'thin' },
        left:   { style: 'thin' },
        right:  { style: 'thin' },
    };
}

function todayLabel() {
    const d = new Date();
    return `${d.getFullYear()}年${String(d.getMonth() + 1).padStart(2, '0')}月${String(d.getDate()).padStart(2, '0')}日`;
}

function fmtCarton(qty) {
    if (qty === null || qty === undefined || qty === '') return '';
    const n = Number(qty);
    return Number.isFinite(n) ? `${n}入/箱` : String(qty);
}

async function fetchImageBuffer(url, timeoutMs = 8000) {
    if (!url) return null;
    try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        if (!res.ok) return null;
        const ab = await res.arrayBuffer();
        return Buffer.from(ab);
    } catch (err) {
        console.warn(`[quoteSheet] 圖片下載失敗: ${url}`, err.message);
        return null;
    }
}

function detectImageExt(buf) {
    if (!buf || buf.length < 8) return 'png';
    // PNG 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
    // JPEG FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
    // GIF 47 49 46
    if (buf[0] === 0x47 && buf[1] === 0x49) return 'gif';
    return 'png';
}

/**
 * 查 Products collection 取得單筆商品資訊
 */
async function lookupProductByModel(model) {
    if (!model) return null;
    const target = String(model).toUpperCase().trim();
    const snap = await db.collection('Products').get();
    for (const doc of snap.docs) {
        const data = doc.data();
        if ((data.model || '').toUpperCase().trim() === target) {
            return { id: doc.id, ...data };
        }
    }
    return null;
}

/**
 * 主函式:產 xlsx + 上傳 Storage
 * @param {Object} opts
 * @param {Object} opts.customer - { name, phone, contactPerson, email }
 * @param {Array}  opts.items    - [{ model, qty, unitPrice }]
 * @param {string} opts.sellerName - 賣方代表人姓名(會寫進簽名區)
 * @returns {Promise<{url:string, filename:string, totalAmount:number, productCount:number}>}
 */
async function generateQuoteSheet({ customer, items, sellerName = '郭庭豪' }) {
    // 1. 補齊商品資料
    const enriched = [];
    for (const it of items) {
        const p = await lookupProductByModel(it.model);
        const model = it.model.toUpperCase().trim();
        const imageUrl = await getImageUrl(model, p?.imageUrl || null);
        enriched.push({
            model,
            qty: Number(it.qty) || 0,
            unitPrice: Number(it.unitPrice) || 0,
            barcode: p?.internationalBarcode || '',
            productUrl: p?.productUrl || 'https://www.kinyo.tw/',
            cartonQty: fmtCarton(p?.cartonQty),
            marketPrice: Number(p?.marketPrice) || null,
            imageUrl,
            _imgBuf: await fetchImageBuffer(imageUrl),
        });
    }

    // 2. 建 workbook
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('sheet1', {
        views: [{ showGridLines: false }],
    });

    // 欄寬
    const widths = { A: 16, B: 16, C: 16, D: 26, E: 11, F: 9, G: 10, H: 12, I: 14 };
    Object.entries(widths).forEach(([col, w]) => { ws.getColumn(col).width = w; });

    // Row 1 LOGO
    ws.getRow(1).height = 55;
    ws.mergeCells('A1:B1');
    if (fs.existsSync(LOGO_PATH)) {
        const imgId = wb.addImage({
            buffer: fs.readFileSync(LOGO_PATH),
            extension: 'jpeg',
        });
        // logo 180px 寬,等比估算高度(原圖 ~3:1),置中於 A1:B1
        const LOGO_W = 180;
        const LOGO_H = 60;
        // A1:B1 合併總寬 ≈ (16+16)*7 = 224 px,列高 55pt ≈ 73 px
        const mergedWPx = (widths.A + widths.B) * 7;
        const rowHPx = Math.round(55 * 96 / 72);
        const xOffFrac = Math.max(0, (mergedWPx - LOGO_W) / 2) / (widths.A * 7);
        const yOffFrac = Math.max(0, (rowHPx - LOGO_H) / 2) / rowHPx;
        ws.addImage(imgId, {
            tl: { col: xOffFrac, row: yOffFrac },
            ext: { width: LOGO_W, height: LOGO_H },
            editAs: 'oneCell',
        });
    } else {
        const c = ws.getCell('A1');
        c.value = 'KINYO';
        c.font = { name: 'Arial Black', size: 28, bold: true };
        c.alignment = { horizontal: 'center', vertical: 'middle' };
    }

    // Rows 2-4 公司抬頭 / 日期
    const headerRows = [
        [COMPANY.name, COMPANY.tel],
        [COMPANY.address, COMPANY.fax],
        [COMPANY.contact, `日期:${todayLabel()}`],
    ];
    headerRows.forEach(([left, right], idx) => {
        const r = idx + 2;
        ws.getRow(r).height = 16;
        ws.mergeCells(`A${r}:E${r}`);
        ws.mergeCells(`F${r}:I${r}`);
        const cl = ws.getCell(`A${r}`);
        cl.value = left;
        cl.font = { name: FONT, size: 9 };
        cl.alignment = { horizontal: 'left', vertical: 'middle' };
        const cr = ws.getCell(`F${r}`);
        cr.value = right;
        cr.font = { name: FONT, size: 9 };
        cr.alignment = { horizontal: 'left', vertical: 'middle' };
    });

    // Row 5 大標題
    ws.getRow(5).height = 32;
    ws.mergeCells('A5:I5');
    const title = ws.getCell('A5');
    title.value = '報價單';
    title.font = { name: FONT, size: 19, bold: true };
    title.alignment = { horizontal: 'center', vertical: 'middle' };

    // Rows 6-7 客戶資訊
    const custRows = [
        [`客戶:${customer.name || ''}`, `TEL:${customer.phone || ''}`],
        [`聯絡人:${customer.contactPerson || ''}`, `E-mail:${customer.email || ''}`],
    ];
    custRows.forEach(([left, right], idx) => {
        const r = idx + 6;
        ws.getRow(r).height = 16;
        ws.mergeCells(`A${r}:E${r}`);
        ws.mergeCells(`F${r}:I${r}`);
        const cl = ws.getCell(`A${r}`);
        cl.value = left;
        cl.font = { name: FONT, size: 9 };
        cl.alignment = { horizontal: 'left', vertical: 'middle' };
        const cr = ws.getCell(`F${r}`);
        cr.value = right;
        cr.font = { name: FONT, size: 9 };
        cr.alignment = { horizontal: 'left', vertical: 'middle' };
    });

    // Row 8 表頭
    const headers = ['型號', '圖檔', '條碼', '商品連結', '箱入數', '數量', '市售價', '報價(含稅)', '總價(含稅)'];
    ws.getRow(8).height = 22;
    headers.forEach((h, i) => {
        const c = ws.getCell(8, i + 1);
        c.value = h;
        c.font = { name: FONT, size: 9, bold: true };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCFFFF' } };
        c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
        c.border = thinBox();
    });

    // Rows 9+ 商品
    const startRow = 9;
    for (let idx = 0; idx < enriched.length; idx++) {
        const p = enriched[idx];
        const r = startRow + idx;
        ws.getRow(r).height = 75;

        ws.getCell(r, 1).value = p.model;
        // B 欄留空給圖片
        ws.getCell(r, 3).value = p.barcode;
        if (p.productUrl) {
            ws.getCell(r, 4).value = { text: p.productUrl, hyperlink: p.productUrl };
            ws.getCell(r, 4).font = { name: FONT, size: 9, color: { argb: 'FF0000FF' }, underline: true };
        }
        ws.getCell(r, 5).value = p.cartonQty;
        ws.getCell(r, 6).value = p.qty;
        ws.getCell(r, 7).value = p.marketPrice;
        ws.getCell(r, 8).value = p.unitPrice;
        ws.getCell(r, 9).value = { formula: `F${r}*H${r}` };

        for (let col = 1; col <= 9; col++) {
            const c = ws.getCell(r, col);
            if (col !== 4) {
                c.font = c.font || { name: FONT, size: 9 };
                if (!c.font.name) c.font = { ...c.font, name: FONT, size: 9 };
            }
            c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
            c.border = thinBox();
            if ([6, 7, 8, 9].includes(col)) c.numFmt = '#,##0';
        }

        // 圖片
        if (p._imgBuf) {
            const ext = detectImageExt(p._imgBuf);
            const imgId = wb.addImage({ buffer: p._imgBuf, extension: ext });
            // 圖 ~85px 正方,B 欄寬 16*7=112px,列高 75pt≈100px,置中
            const cellWpx = widths.B * 7;
            const cellHpx = Math.round(75 * 96 / 72);
            const IMG_W = 85, IMG_H = 85;
            const xFrac = Math.max(0, (cellWpx - IMG_W) / 2) / cellWpx;
            const yFrac = Math.max(0, (cellHpx - IMG_H) / 2) / cellHpx;
            ws.addImage(imgId, {
                tl: { col: 1 + xFrac, row: (r - 1) + yFrac },
                ext: { width: IMG_W, height: IMG_H },
                editAs: 'oneCell',
            });
        }
    }

    // 合計列
    const totalRow = startRow + enriched.length;
    ws.getRow(totalRow).height = 24;
    ws.mergeCells(`A${totalRow}:H${totalRow}`);
    const tl = ws.getCell(totalRow, 1);
    tl.value = '合計 (含稅)';
    tl.font = { name: FONT, size: 10, bold: true };
    tl.alignment = { horizontal: 'right', vertical: 'middle' };
    // 合併範圍每格都要套 fill + border (合併後框線才完整)
    for (let col = 1; col <= 8; col++) {
        const c = ws.getCell(totalRow, col);
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
        c.border = thinBox();
    }
    const tv = ws.getCell(totalRow, 9);
    tv.value = { formula: `SUM(I${startRow}:I${totalRow - 1})` };
    tv.font = { name: FONT, size: 10, bold: true };
    tv.alignment = { horizontal: 'center', vertical: 'middle' };
    tv.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    tv.border = thinBox();
    tv.numFmt = '#,##0';

    // 空列
    let r = totalRow + 1;
    ws.getRow(r).height = 8;
    r++;

    // 備註
    for (const text of REMARKS) {
        ws.getRow(r).height = 16;
        ws.mergeCells(`A${r}:I${r}`);
        const c = ws.getCell(r, 1);
        c.value = text;
        c.font = { name: FONT, size: 9, bold: text === '備註:' };
        c.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
        r++;
    }

    // 空列
    ws.getRow(r).height = 8;
    r++;

    // 簽名標題 (跨欄置中)
    const signRow = r;
    ws.getRow(signRow).height = 24;
    ws.mergeCells(`A${signRow}:B${signRow}`);
    ws.mergeCells(`F${signRow}:G${signRow}`);
    const sellerHdr = ws.getCell(signRow, 1);
    sellerHdr.value = '賣方代表人';
    sellerHdr.font = { name: FONT, size: 14, bold: true };
    sellerHdr.alignment = { horizontal: 'center', vertical: 'middle' };
    const buyerHdr = ws.getCell(signRow, 6);
    buyerHdr.value = '買方代表人';
    buyerHdr.font = { name: FONT, size: 14, bold: true };
    buyerHdr.alignment = { horizontal: 'center', vertical: 'middle' };

    // 簽名名字列
    const signNameRow = signRow + 1;
    ws.getRow(signNameRow).height = 34;
    ws.mergeCells(`A${signNameRow}:B${signNameRow}`);
    ws.mergeCells(`F${signNameRow}:G${signNameRow}`);
    const sellerName2 = ws.getCell(signNameRow, 1);
    sellerName2.value = sellerName;
    sellerName2.font = { name: FONT, size: 14, bold: true };
    sellerName2.alignment = { horizontal: 'center', vertical: 'middle' };
    // 買方簽名格下緣粗線
    ws.getCell(signNameRow, 6).border = { bottom: { style: 'medium' } };
    ws.getCell(signNameRow, 7).border = { bottom: { style: 'medium' } };

    // 3. 輸出 xlsx 上傳 Storage
    const xlsxBuffer = Buffer.from(await wb.xlsx.writeBuffer());

    const safeCust = (customer.name || 'quote').replace(/[^A-Za-z0-9\u4e00-\u9fa5]/g, '').slice(0, 20) || 'quote';
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const timeTag = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    const bucketName = 'kinyo-price.firebasestorage.app';
    const bucket = admin.storage().bucket(bucketName);
    const filename = `quote_sheets/KINYO_報價單_${safeCust}_${timeTag}.xlsx`;
    const file = bucket.file(filename);
    const downloadToken = crypto.randomUUID();

    await file.save(xlsxBuffer, {
        metadata: {
            contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            metadata: { firebaseStorageDownloadTokens: downloadToken },
        },
    });

    const url = `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(filename)}?alt=media&token=${downloadToken}`;

    const totalAmount = enriched.reduce((s, p) => s + (p.qty * p.unitPrice), 0);
    return { url, filename, totalAmount, productCount: enriched.length };
}

module.exports = { generateQuoteSheet };
