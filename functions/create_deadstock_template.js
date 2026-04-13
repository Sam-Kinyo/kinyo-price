// 產出呆滯品/福利品匯入的 Excel 範例
const XLSX = require('xlsx');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'templates');
const fs = require('fs');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// --- 呆滯品範例 ---
const deadStockData = [
    ['型號', '出清價', '備註', '狀態'],
    ['KIA-25', 350, '限量50台', 'active'],
    ['KHD-9660', 199, '庫存出清', 'active'],
    ['KCR-195', 450, '限量30台', 'active'],
    ['ACF-3142', 280, '', 'active'],
    ['KHD-2280', 150, '舊款出清，數量不多', 'active'],
    ['DHM-3450', 800, '限企業採購10台以上', 'active']
];

const deadWS = XLSX.utils.aoa_to_sheet(deadStockData);
deadWS['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 25 }, { wch: 10 }];
const deadWB = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(deadWB, deadWS, '呆滯品出清');
const deadPath = path.join(OUT_DIR, '呆滯品匯入範例.xlsx');
XLSX.writeFile(deadWB, deadPath);
console.log('✅ 產生:', deadPath);

// --- 福利品範例 ---
const welfareData = [
    ['型號', '福利價', '備註', '狀態'],
    ['KIA-25', 280, '員工專屬', 'active'],
    ['KHD-9660', 159, '二手整新', 'active'],
    ['KCR-195', 380, '展示品，功能完整', 'active'],
    ['DHM-3450', 720, '限員工每人 1 台', 'active']
];

const welfareWS = XLSX.utils.aoa_to_sheet(welfareData);
welfareWS['!cols'] = [{ wch: 15 }, { wch: 12 }, { wch: 25 }, { wch: 10 }];
const welfareWB = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(welfareWB, welfareWS, '福利品專區');
const welfarePath = path.join(OUT_DIR, '福利品匯入範例.xlsx');
XLSX.writeFile(welfareWB, welfarePath);
console.log('✅ 產生:', welfarePath);

console.log('\n完成！範例檔在 templates/ 資料夾。');
