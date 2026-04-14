/* =======================================================
   匯入模組 (Import: 產品總表 + 庫存 + 呆滯品 + 福利品)
======================================================= */
import { collection, doc, writeBatch, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from './firebase-init.js';
import { state } from './state.js';
import { getDocsWithRetry } from './data.js';

/* 產品匯入 Excel 解析 */
export function setupProductUpload() {
  const productUpload = document.getElementById("productUpload");
  if (!productUpload) return;

  productUpload.onchange = (e) => {
    const file = e.target.files[0];
    if(!file) return;
    state.currentImportMode = 'product';

    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target.result;
        const workbook = XLSX.read(data, { type: 'binary' });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 }); 

        let h = {
          model: -1, name: -1, 
          market: -1, min: -1, 
          q50: -1, q100: -1, q300: -1, q500: -1, q1000: -1, q3000: -1,
          cat: -1, color: -1, barcode: -1, box: -1, controlled: -1,
          url: -1, perm: -1, bsmi: -1, ncc: -1, groupBuy: -1,
          cost: -1, inventory: -1, finished: -1, exclusive: -1,
          status: -1, eta: -1
        };
        
        let vipHeaders = {}; 

        for(let r=0; r<Math.min(jsonData.length, 10); r++) {
          const row = jsonData[r];
          for(let c=0; c<row.length; c++) {
            const cell = String(row[c] || "").trim();
            const cellLower = cell.toLowerCase();
            
            if(cellLower === 'model' || cellLower === '型號' || cellLower === '產品') h.model = c;
            if(cellLower === 'name' || cellLower === '品名' || cellLower === '產品名稱') h.name = c;
            if(cellLower.includes('賣場') || cellLower.includes('建議售價')) h.market = c;
            if(cellLower.includes('末售') || cellLower.includes('底價')) h.min = c;
            if(cellLower.includes('團購')) h.groupBuy = c; 
            if (cellLower.includes('50') && !cellLower.includes('500') && cellLower.includes('報價')) h.q50 = c;
            if (cellLower.includes('100') && !cellLower.includes('1000') && cellLower.includes('報價')) h.q100 = c;
            if (cellLower.includes('300') && !cellLower.includes('3000') && cellLower.includes('報價')) h.q300 = c;
            if (cellLower.includes('500') && cellLower.includes('報價')) h.q500 = c;
            if (cellLower.includes('1000') && cellLower.includes('報價')) h.q1000 = c;
            if (cellLower.includes('3000') && cellLower.includes('報價')) h.q3000 = c;
            
            if (cellLower.includes('控價') || cellLower === 'controlled') h.controlled = c;
            if(cellLower.includes('顏色')) h.color = c;
            if(cellLower.includes('分類') || cellLower === 'category') h.cat = c;
            if(cellLower.includes('條碼') || cellLower === 'barcode' || cellLower === '國際條碼') h.barcode = c;
            if(cellLower.includes('箱入') || cellLower.includes('carton')) h.box = c;
            if (cellLower.includes('網站') || cellLower.includes('網址') || cellLower.includes('url')) h.url = c;
            if (cellLower.includes('權限') || cellLower.includes('permission')) h.perm = c;
            if (cellLower.includes('bsmi')) h.bsmi = c;
            if (cellLower.includes('ncc')) h.ncc = c;
            if (cellLower === '廠價' || cellLower === 'cost' || cellLower === '成本') h.cost = c;
            if (cellLower.includes('成品倉') || cellLower === '成品') h.finished = c;
            if (cellLower.includes('專賣倉') || cellLower === '專賣') h.exclusive = c;
            if (cellLower === '庫存' || cellLower === '現貨' || cellLower === 'inventory') h.inventory = c;
            if (cellLower.includes('狀態') || cellLower.includes('上下架') || cellLower === 'status') h.status = c;
            if (cellLower.includes('預計') || cellLower.includes('到貨') || cellLower === 'eta') h.eta = c;

            if (cell.toUpperCase().startsWith('VIP')) {
              vipHeaders[cell] = c;
            }
          }
        }

        if(h.barcode === -1) {
          alert("⚠️ 警告：找不到「國際條碼」欄位，無法進行精準更新。");
        }

        let actions = [];
        const hasVal = (v) => v !== undefined && v !== null && String(v).trim() !== "";

        jsonData.forEach((row) => {
          const rawModel = row[h.model];
          if(!rawModel || String(rawModel).includes("型號")) return;

          const modelVal = String(rawModel).trim();
          let obj = {}; 

          if(h.name !== -1 && hasVal(row[h.name])) obj.name = row[h.name];
          if(h.cat !== -1 && hasVal(row[h.cat])) obj.category = row[h.cat];
          if(h.color !== -1 && hasVal(row[h.color])) obj.colorList = row[h.color];
          if(h.barcode !== -1 && hasVal(row[h.barcode])) obj.internationalBarcode = row[h.barcode]; 
          if(h.box !== -1 && hasVal(row[h.box])) obj.cartonQty = row[h.box];
          if(h.url !== -1 && hasVal(row[h.url])) obj.productUrl = row[h.url];
          if(h.perm !== -1 && hasVal(row[h.perm])) obj.netSalesPermission = row[h.perm];
          if(h.bsmi !== -1 && hasVal(row[h.bsmi])) obj.bsmi = row[h.bsmi];
          if(h.ncc !== -1 && hasVal(row[h.ncc])) obj.ncc = row[h.ncc];

          if(h.market !== -1 && hasVal(row[h.market])) obj.marketPrice = row[h.market];
          if(h.min !== -1 && hasVal(row[h.min])) obj.minPrice = row[h.min];
          if(h.groupBuy !== -1 && hasVal(row[h.groupBuy])) obj.groupBuyPrice = row[h.groupBuy];
          
          // 庫存
          if (h.finished !== -1 && h.exclusive !== -1) {
            const finQty = parseInt(row[h.finished] || 0, 10);
            const excQty = parseInt(row[h.exclusive] || 0, 10);
            obj.inventory = Math.floor((finQty + excQty) * 0.85); 
          } else if (h.inventory !== -1 && hasVal(row[h.inventory])) {
            obj.inventory = parseInt(row[h.inventory], 10);
          }

          // 廠價運算
          let tempCost = 0;
          if (h.cost !== -1 && hasVal(row[h.cost])) {
            tempCost = parseFloat(row[h.cost]);
          }

          if (tempCost > 0) {
            obj.cost = tempCost;
          }

          if(h.controlled !== -1 && hasVal(row[h.controlled]) && String(row[h.controlled]).toLowerCase() === 'v') obj.isControlled = true;

          for (const [vKey, vIdx] of Object.entries(vipHeaders)) {
            if (hasVal(row[vIdx])) {
              obj[vKey] = row[vIdx];
            }
          }

          // 上下架狀態
          if (h.status !== -1 && hasVal(row[h.status])) {
            const rawStatus = String(row[h.status]).trim().toLowerCase();
            if (['下架', '停售', 'inactive', 'off', 'n', 'false', '0'].includes(rawStatus)) {
              obj.status = 'inactive';
            } else {
              obj.status = 'active';
            }
          } else {
            obj.status = 'active';
          }

          // ETA (到貨日)
          if (h.eta !== -1 && hasVal(row[h.eta])) {
            let val = row[h.eta];
            if (typeof val === 'number' && val > 40000) {
              const date = new Date(Math.round((val - 25569) * 86400 * 1000));
              const y = date.getFullYear();
              const m = String(date.getMonth() + 1).padStart(2, '0');
              const d = String(date.getDate()).padStart(2, '0');
              obj.eta = `${y}/${m}/${d}`;
            } else {
              obj.eta = String(val).trim();
            }
          }
         
          obj.model = modelVal;
          obj.mainModel = modelVal.split('-')[0]; 

          actions.push({ data: obj, model: modelVal });
        });

        const previewHeader = document.getElementById("previewHeader");
        const previewContent = document.getElementById("previewContent");
        const previewOverlay = document.getElementById("previewOverlay");

        previewHeader.textContent = "全能匯入確認 (雙倉加總 + 廠價公式)";
        previewContent.innerHTML = `
          <div style="padding:20px; text-align:center;">
            <h3 style="color:#2563eb;">已解析 ${actions.length} 筆資料</h3>
            <div style="background:#f0fdf4; border:1px solid #bbf7d0; padding:10px; border-radius:8px; display:inline-block; margin-bottom:10px;">
              ✅ <b>功能已啟動</b><br>
              1. 庫存 = 成品倉 + 專賣倉<br>
              2. 報價 = 依廠價公式自動計算
            </div>
            <ul style="text-align:left; display:inline-block; font-size:14px; color:#444; margin-top:10px;">
              <li>📦 <b>雙倉偵測</b>：${(h.finished !== -1 && h.exclusive !== -1) ? '✅ 成功抓到兩倉' : '⚠️ 只抓到單一庫存或未抓到'}</li>
              <li>💰 <b>廠價運算</b>：${h.cost !== -1 ? '✅ 執行中' : '❌ 未啟用'}</li>
              <li>🏷️ <b>產品資訊</b>：國際條碼比對中...</li>
            </ul>
          </div>
        `;
        state.pendingProductData = actions;
        previewOverlay.style.display = "flex";

      } catch(e) {
        console.error(e);
        alert("檔案讀取失敗，請檢查 Excel 格式");
      }
    };
    reader.readAsBinaryString(file);
  };
}

/* 產品資料寫入 Firestore */
export async function saveProductDataToFirestore(actions) {
    const importProductBtn = document.getElementById("importProductBtn");
    importProductBtn.disabled = true;
    importProductBtn.textContent = "正在抓取原始資料...";

    let batch = writeBatch(db);
    let opCount = 0;
    const BATCH_LIMIT = 400; 
    let successCount = 0;

    try {
        const snap = await getDocsWithRetry(collection(db, "Products"));
        const rawMap = new Map();

        snap.forEach(docSnap => {
            const d = docSnap.data();
            const bc = String(d.internationalBarcode || d.barcode || "").trim();
            if(bc) rawMap.set(bc, docSnap.id);
        });

        importProductBtn.textContent = "正在寫入資料庫...";

        for(const item of actions) {
            const excelBc = String(item.data.internationalBarcode || "").trim();
            if(!excelBc) {
                console.warn("Skipping item without barcode:", item.model);
                continue; 
            }

            item.data.internationalBarcode = excelBc;
            const finalStatus = item.data.status || 'active';

            if(rawMap.has(excelBc)) {
                const docId = rawMap.get(excelBc);
                const docRef = doc(db, "Products", docId);
                batch.update(docRef, { ...item.data, status: finalStatus });
            } else {
                const newDocRef = doc(collection(db, "Products"));
                batch.set(newDocRef, { ...item.data, status: finalStatus, inventory: 0 });
            }
            
            opCount++;
            successCount++;

            if(opCount >= BATCH_LIMIT) {
                await batch.commit();
                batch = writeBatch(db);
                opCount = 0;
            }
        }

        if(opCount > 0) {
            await batch.commit();
        }

        alert(`產品總表同步完成！\n以國際條碼為基準，共處理了 ${successCount} 筆資料。\n系統將自動重新整理。`);
        window.location.reload();

    } catch(e) {
        console.error(e);
        alert("寫入資料庫時發生錯誤，請檢查 Console。");
    } finally {
        importProductBtn.disabled = false;
        importProductBtn.textContent = "📥 匯入產品總表 (同步上下架)";
    }
}

/* 呆滯品 / 福利品匯入解析
   支援兩種 Excel 格式：
   1. 公司後台匯出的「產品價格查詢」格式（Row1+Row2 雙列表頭 + 銷售狀態欄）
   2. 簡易格式：型號 / 特價 / 備註 / 狀態
*/
export function setupSiteListUpload(kind) {
    // kind: 'deadstock' | 'welfare'
    const inputId = kind === 'deadstock' ? 'deadStockUpload' : 'welfareUpload';
    const input = document.getElementById(inputId);
    if (!input) return;

    const LABEL = kind === 'deadstock' ? '呆滯品' : '福利品';
    const STATUS_KEYWORD = kind === 'deadstock' ? '呆滯' : '福利';

    input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        state.currentImportMode = kind;

        const reader = new FileReader();
        reader.onload = (evt) => {
            try {
                const workbook = XLSX.read(evt.target.result, { type: 'binary' });
                const sheet = workbook.Sheets[workbook.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

                // 偵測格式：公司後台 vs 簡易
                const row0 = (rows[0] || []).map(c => String(c || ''));
                const row1 = (rows[1] || []).map(c => String(c || ''));
                const row2 = (rows[2] || []).map(c => String(c || ''));
                const concat = (row1.join('|') + '||' + row2.join('|')).toLowerCase();

                const isCompanyFormat = concat.includes('末售') && concat.includes('銷售') && concat.includes('條碼');

                const items = [];
                const skipped = { noPrice: 0, wrongStatus: 0, noModel: 0 };
                let zeroCostAdjusted = 0, cappedBySmallCheck = 0;

                if (isCompanyFormat) {
                    // === 公司後台格式 ===
                    // Row 1: 主表頭 (大類別/產品/分級/銷售狀態/網銷狀態/生產狀態/條碼/價格(merged)/箱入數(merged)/庫存(merged)/...)
                    // Row 2: 子表頭 (廠價/中現/中票/小現/小票/末售/賣場/外箱/內箱/成品倉/專賣倉/...)
                    let hModel = -1, hName = -1, hCategory = -1, hSalesStatus = -1, hWebStatus = -1;
                    let hCost = -1, hSmallCheck = -1, hEndSale = -1, hMarket = -1, hFinished = -1, hExclusive = -1;

                    for (let c = 0; c < Math.max(row1.length, row2.length); c++) {
                        const h1 = String(row1[c] || '').trim();
                        const h2 = String(row2[c] || '').trim();
                        const combined = (h1 + h2).replace(/\s+/g, '');

                        if (h1 === '產品' && hModel === -1) {
                            // 產品欄跨兩格：col N 是型號, col N+1 是品名
                            hModel = c; hName = c + 1;
                        }
                        if (h1.includes('大類別') || h1 === '類別') hCategory = c;
                        if (h1.includes('銷售') && h1.includes('狀態')) hSalesStatus = c;
                        if (h1.includes('網銷') && h1.includes('狀態')) hWebStatus = c;
                        if (h2 === '廠價' || combined === '廠價') hCost = c;
                        if (h2 === '小票' || combined === '小票') hSmallCheck = c;
                        if (h2 === '末售' || combined === '末售') hEndSale = c;
                        if (h2 === '賣場' || combined === '賣場') hMarket = c;
                        if (h2 === '成品倉' || combined === '成品倉') hFinished = c;
                        if (h2 === '專賣倉' || combined === '專賣倉') hExclusive = c;
                    }

                    if (hModel === -1 || hCost === -1) {
                        alert('⚠️ 偵測到公司後台格式，但找不到「產品」或「廠價」欄位。請確認這是「產品價格查詢」報表。');
                        return;
                    }

                    // 資料列從 row 3 開始（row 0 結果筆數，row 1+2 雙列表頭）
                    // 出清價公式：廠價 / 0.73 * 1.05；廠價=0 用 10；不超過小票
                    for (let r = 3; r < rows.length; r++) {
                        const row = rows[r] || [];
                        const model = String(row[hModel] || '').trim();
                        if (!model) { skipped.noModel++; continue; }

                        // 按狀態過濾：呆滯品 / 福利品
                        const salesStatus = String(row[hSalesStatus] || '').trim();
                        if (!salesStatus.includes(STATUS_KEYWORD)) { skipped.wrongStatus++; continue; }

                        // 廠價處理：若 0 或空，改用 10
                        let cost = parseFloat(row[hCost]) || 0;
                        const costAdjusted = cost <= 0;
                        if (costAdjusted) { cost = 10; zeroCostAdjusted++; }

                        // 公式計算
                        let specialPrice = Math.round(cost / 0.73 * 1.05);

                        // 小票上限：若公式算出 > 小票，改用小票
                        const smallCheck = hSmallCheck !== -1 ? parseFloat(row[hSmallCheck]) || 0 : 0;
                        let capped = false;
                        if (smallCheck > 0 && specialPrice > smallCheck) {
                            specialPrice = Math.round(smallCheck);
                            capped = true;
                            cappedBySmallCheck++;
                        }

                        if (!specialPrice || specialPrice <= 0) { skipped.noPrice++; continue; }

                        const inv = (parseInt(row[hFinished] || 0, 10) + parseInt(row[hExclusive] || 0, 10)) || 0;
                        const name = hName !== -1 ? String(row[hName] || '').trim() : '';
                        // 賣場價（劃掉顯示用）
                        const marketPrice = hMarket !== -1 ? parseInt(parseFloat(row[hMarket]) || 0, 10) : 0;
                        // 自動產生備註：顯示庫存（若有）
                        const autoNote = inv > 0 ? `限量 ${inv} 件` : '';

                        items.push({
                            model, specialPrice, marketPrice, note: autoNote,
                            _name: name, _inv: inv,
                            _cost: parseFloat(row[hCost]) || 0,  // 原始廠價（顯示用）
                            _costAdjusted: costAdjusted,
                            _smallCheck: smallCheck,
                            _capped: capped
                        });
                    }

                } else {
                    // === 簡易格式（我們的範本） ===
                    let hModel = -1, hPrice = -1, hNote = -1, hStatus = -1;
                    outer: for (let r = 0; r < Math.min(rows.length, 5); r++) {
                        const row = rows[r] || [];
                        for (let c = 0; c < row.length; c++) {
                            const cell = String(row[c] || '').trim().toLowerCase();
                            if (cell === 'model' || cell === '型號' || cell === '產品') hModel = c;
                            if (cell.includes('特價') || cell.includes('出清價') || cell.includes('福利價') || cell.includes('專案價') || cell === 'price' || cell === 'specialprice') hPrice = c;
                            if (cell.includes('備註') || cell.includes('note') || cell.includes('說明')) hNote = c;
                            if (cell.includes('狀態') || cell === 'status') hStatus = c;
                        }
                        if (hModel !== -1 && hPrice !== -1) break outer;
                    }

                    if (hModel === -1 || hPrice === -1) {
                        alert('⚠️ 找不到必要欄位。請確認 Excel 第一列包含「型號」和「特價/出清價/福利價」。\n或直接使用公司後台的「產品價格查詢」報表。');
                        return;
                    }

                    rows.forEach((row, idx) => {
                        if (idx === 0) return;
                        const model = String(row[hModel] || '').trim();
                        if (!model || model === '型號' || model.toLowerCase() === 'model') { skipped.noModel++; return; }
                        const specialPrice = parseInt(row[hPrice], 10);
                        if (!specialPrice || specialPrice <= 0) { skipped.noPrice++; return; }
                        const note = hNote !== -1 ? String(row[hNote] || '').trim() : '';
                        const statusRaw = hStatus !== -1 ? String(row[hStatus] || '').trim().toLowerCase() : '';
                        if (['下架', '停售', 'inactive', 'off', 'n', '0'].includes(statusRaw)) { skipped.wrongStatus++; return; }
                        items.push({ model, specialPrice, note });
                    });
                }

                // === 顯示預覽 ===
                const previewHeader = document.getElementById('previewHeader');
                const previewContent = document.getElementById('previewContent');
                const previewOverlay = document.getElementById('previewOverlay');

                previewHeader.textContent = `${LABEL}匯入預覽 ${isCompanyFormat ? '(公司後台格式)' : '(簡易格式)'} — 將覆寫整份清單`;

                const tableRows = items.map((it, i) => {
                    const nameCell = it._name ? `<div style="font-size:11px; color:#666;">${it._name}</div>` : '';
                    let metaCell = '';
                    if (isCompanyFormat) {
                        const costText = it._costAdjusted ? `<span style="color:#c2703e;">廠價 $0→$10</span>` : `廠價 $${it._cost}`;
                        const capText = it._capped ? ` · <span style="color:#2563eb;">套小票上限</span>` : '';
                        metaCell = `<div style="font-size:11px; color:#64748b; margin-top:2px;">${costText}${capText}</div>`;
                    }
                    const marketCell = it.marketPrice > 0
                        ? `<span style="text-decoration:line-through; color:#9ca3af;">$${it.marketPrice.toLocaleString()}</span>`
                        : '<span style="color:#9ca3af;">—</span>';
                    return `
                        <tr>
                            <td style="padding:6px 10px; border-bottom:1px solid #eee;">${i + 1}</td>
                            <td style="padding:6px 10px; border-bottom:1px solid #eee;"><b>${it.model}</b>${nameCell}</td>
                            <td style="padding:6px 10px; border-bottom:1px solid #eee;">${marketCell}</td>
                            <td style="padding:6px 10px; border-bottom:1px solid #eee; color:#dc2626; font-weight:bold;">$${it.specialPrice.toLocaleString()}${metaCell}</td>
                            <td style="padding:6px 10px; border-bottom:1px solid #eee; color:#666;">${it.note || '—'}</td>
                        </tr>
                    `;
                }).join('');

                const skippedSummary = [];
                if (skipped.wrongStatus > 0) skippedSummary.push(`${skipped.wrongStatus} 筆狀態非${LABEL}`);
                if (skipped.noPrice > 0) skippedSummary.push(`${skipped.noPrice} 筆無價格`);
                if (skipped.noModel > 0) skippedSummary.push(`${skipped.noModel} 筆無型號`);

                const adjustSummary = [];
                if (zeroCostAdjusted > 0) adjustSummary.push(`${zeroCostAdjusted} 筆廠價=0（以 $10 代入）`);
                if (cappedBySmallCheck > 0) adjustSummary.push(`${cappedBySmallCheck} 筆受小票上限封頂`);

                previewContent.innerHTML = `
                    <div style="padding:16px;">
                        <h3 style="color:#2563eb; margin:0 0 8px;">已解析 ${items.length} 筆${LABEL}</h3>
                        ${skippedSummary.length > 0 ? `<div style="background:#fff7ed; border:1px solid #fed7aa; padding:8px 12px; border-radius:6px; font-size:12px; color:#9a3412; margin-bottom:10px;">跳過 ${skippedSummary.join('、')}</div>` : ''}
                        ${adjustSummary.length > 0 ? `<div style="background:#eff6ff; border:1px solid #bfdbfe; padding:8px 12px; border-radius:6px; font-size:12px; color:#1e40af; margin-bottom:10px;">調整 ${adjustSummary.join('、')}</div>` : ''}
                        <p style="color:#666; font-size:13px; margin:0 0 12px;">
                            ⚠️ 確認後將<b>覆寫整份${LABEL}清單</b>（不是追加）。網站會讀取此清單顯示商品。
                            ${isCompanyFormat ? '<br>💡 <b>出清價 = 廠價 / 0.73 × 1.05</b>（廠價=0 改用 $10；若高於小票則以小票為上限）' : ''}
                        </p>
                        <div style="max-height:420px; overflow-y:auto; border:1px solid #e5e5e5; border-radius:8px;">
                            <table style="width:100%; border-collapse:collapse; font-size:13px;">
                                <thead style="background:#f9fafb; position:sticky; top:0;">
                                    <tr>
                                        <th style="padding:8px 10px; text-align:left;">#</th>
                                        <th style="padding:8px 10px; text-align:left;">型號 / 品名</th>
                                        <th style="padding:8px 10px; text-align:left;">原價（賣場）</th>
                                        <th style="padding:8px 10px; text-align:left;">${kind === 'deadstock' ? '出清價 (計算)' : '福利價 (計算)'}</th>
                                        <th style="padding:8px 10px; text-align:left;">備註</th>
                                    </tr>
                                </thead>
                                <tbody>${tableRows || '<tr><td colspan="5" style="padding:20px; text-align:center; color:#999;">無符合條件的資料</td></tr>'}</tbody>
                            </table>
                        </div>
                    </div>
                `;

                // 寫入前把 _name/_inv 等臨時欄位過濾掉
                state.pendingSiteListItems = items.map(it => ({
                    model: it.model,
                    specialPrice: it.specialPrice,
                    marketPrice: it.marketPrice || 0,
                    note: it.note
                }));
                previewOverlay.style.display = 'flex';

            } catch (err) {
                console.error(err);
                alert('檔案讀取失敗，請檢查 Excel 格式');
            }
        };
        reader.readAsBinaryString(file);
    };
}

const SYNC_IMAGES_URL = 'https://asia-east1-kinyo-price.cloudfunctions.net/syncProductImages';
const SYNC_TOKEN = 'Kinyo$ync2026!xR9mTq';

export async function saveSiteListToFirestore(kind, items) {
    const btnId = kind === 'deadstock' ? 'importDeadStockBtn' : 'importWelfareBtn';
    const docId = kind === 'deadstock' ? 'deadStockList' : 'welfareList';
    const LABEL = kind === 'deadstock' ? '呆滯品' : '福利品';
    const btn = document.getElementById(btnId);
    if (btn) btn.disabled = true;

    try {
        await setDoc(doc(db, 'SiteConfig', docId), {
            items,
            updatedAt: serverTimestamp(),
            updatedBy: state.currentUserEmail || 'unknown'
        }, { merge: false });

        alert(`${LABEL}清單已成功更新！共 ${items.length} 筆商品。\n\n正在自動同步商品照片（約 30-60 秒）...`);

        // 自動觸發圖片同步
        triggerImageSync(LABEL);
    } catch (e) {
        console.error('save site list failed', e);
        alert(`${LABEL}寫入失敗，請檢查 Console`);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function triggerImageSync(label) {
    try {
        const resp = await fetch(`${SYNC_IMAGES_URL}?token=${encodeURIComponent(SYNC_TOKEN)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ force: false })
        });
        const data = await resp.json();
        if (data.success) {
            alert(`📸 照片同步完成！\n${data.message}\n${data.notFoundList?.length > 0 ? '\n找不到圖的型號：' + data.notFoundList.join(', ') : ''}`);
        } else {
            console.warn('Image sync failed:', data);
            alert(`⚠️ 照片同步失敗：${data.error || '未知錯誤'}\n${label}清單已更新，照片請稍後手動同步。`);
        }
    } catch (e) {
        console.warn('Image sync error:', e);
        alert(`⚠️ 照片同步連線失敗（清單已正常更新）。\n請稍後重新整理頁面確認照片。`);
    }
}

/* 庫存更新寫入 Firestore */
export async function saveInventoryToFirestore(invMap) {
    const importInventoryBtn = document.getElementById("importInventoryBtn");
    if (!importInventoryBtn) return;
    
    importInventoryBtn.disabled = true;
    importInventoryBtn.textContent = "正在抓取原始資料...";
    
    let batch = writeBatch(db);
    let opCount = 0;
    let updatedCount = 0;
    const BATCH_LIMIT = 400;

    try {
        const snap = await getDocsWithRetry(collection(db, "Products"));
        batch = writeBatch(db);
        opCount = 0;
        
        importInventoryBtn.textContent = "正在寫入資料庫...";

        for(const docSnap of snap.docs) {
             const product = docSnap.data();
             const bc = (product.internationalBarcode || product.barcode || "").trim();
             
             if(bc && invMap.has(bc)) {
                const newQty = invMap.get(bc);
                const docRef = doc(db, "Products", docSnap.id);
                batch.update(docRef, { inventory: newQty });
                
                opCount++;
                updatedCount++;
                
                if(opCount >= BATCH_LIMIT) {
                    await batch.commit();
                    batch = writeBatch(db);
                    opCount = 0;
                }
             }
        }
        
        if(opCount > 0) await batch.commit();

        alert(`資料庫更新完成！\n以國際條碼為基準，共更新了 ${updatedCount} 筆商品的庫存。\n系統將自動重新整理以顯示最新數據。`);
        window.location.reload();

    } catch(e) {
        console.error(e);
        alert("寫入資料庫失敗");
    } finally {
        importInventoryBtn.disabled = false;
        importInventoryBtn.textContent = "📥 匯入庫存表 (條碼比對)";
    }
}
