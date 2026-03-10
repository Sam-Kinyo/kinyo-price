/* =======================================================
   匯入模組 (Import: 產品總表 + 庫存)
======================================================= */
import { collection, doc, writeBatch } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
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
