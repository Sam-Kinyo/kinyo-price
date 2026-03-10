/* =======================================================
   報價單模組 (Quote)
======================================================= */
import { collection, addDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from './firebase-init.js';
import { state } from './state.js';
import { getInventoryRangeLabel, calcQuotePrice } from './helpers.js';
import { getDriveMainImage, getDriveNetImages } from './data.js';

/* 報價單渲染 */
export function renderQuoteList() {
  const quoteListBody = document.getElementById("quoteListBody");
  quoteListBody.innerHTML = "";
  if (state.quoteList.length === 0) {
    quoteListBody.innerHTML = `<div style="text-align:center;padding:40px;color:#999;">報價單是空的</div>`;
    return;
  }
  state.quoteList.forEach((q, idx) => {
    const div = document.createElement("div"); div.className = "quote-item";
    const priceDisplay = `$${q.price}`;
    div.innerHTML = `<div style="flex:1;"><div style="font-weight:700;">${q.name}</div><div class="quote-info">${q.model} | ${q.qtyLabel}</div></div><div style="text-align:right;margin-right:8px;"><div class="quote-price">${priceDisplay}</div><div style="font-size:12px;color:#888;">x ${q.count}</div></div><div class="quote-del" data-idx="${idx}">🗑️</div>`;
    quoteListBody.appendChild(div);
  });
  document.querySelectorAll(".quote-del").forEach(btn => {
    btn.onclick = (e) => {
      const i = Number(e.target.getAttribute("data-idx"));
      state.quoteList.splice(i, 1);
      renderQuoteList();
      updateQuoteToolbarBtn();
    };
  });
}

/* 報價單工具按鈕更新 */
export function updateQuoteToolbarBtn() { 
  const quoteToolbarBtn = document.getElementById("quoteToolbarBtn");
  if (state.quoteList.length > 0) { 
    quoteToolbarBtn.style.display = "inline-block"; 
    quoteToolbarBtn.textContent = `報價單（${state.quoteList.length}）`; 
  } else { 
    quoteToolbarBtn.style.display = "none"; 
  } 
}

/* 報價單 Excel 匯出 */
export function downloadQuoteExcel() {
  if (state.quoteList.length === 0) { alert("報價單是空的"); return; }

  let rows = [];

  if (state.isGroupBuyUser) {
      const costCol = (state.currentUserVipConfig && state.currentUserVipConfig.column) ? state.currentUserVipConfig.column : 'VIP_C';
      const displayName = (state.currentUserVipConfig && state.currentUserVipConfig.name) ? state.currentUserVipConfig.name : costCol;

      const header = [
          "商品型號", "分類", "商品名稱", "箱入數", "團購價", 
          `${displayName} 進價`, "賣場價", "庫存量", "商品連結",
          "採購規格", "報價單價", "訂購數量", "小計"
      ];
      rows.push(header);

      state.quoteList.forEach(q => {
          let item = state.productCache.find(p => p.model === q.model);
          if (!item) item = q;

          const gbPrice = item.groupBuyPrice ? `$${item.groupBuyPrice}` : "未開放";
          const myCost = item[costCol] ? `$${item[costCol]}` : "-";
          const market = item.marketPrice ? `$${item.marketPrice}` : "-";
          const stock = getInventoryRangeLabel(item.inventory) || "-";
          const subtotal = (Number(q.price) || 0) * (Number(q.count) || 1);

          rows.push([
              q.model, item.category || "", q.name, item.cartonQty || "", 
              gbPrice, myCost, market, stock, item.productUrl || "", 
              q.qtyLabel, q.price, q.count, subtotal
          ]);
      });
  } else {
      const baseHeader = ["商品型號","主型號","分類","商品名稱","顏色列表","網路權限","箱入數","商品連結","商品大圖","網路圖"];
      const quoteHeader = ["採購規格", "報價單價", "訂購數量", "小計", "末售參考", "賣場售價", "庫存狀態"];
      rows.push([...baseHeader, ...quoteHeader]);

      state.quoteList.forEach(q => {
          let item = state.productCache.find(p => p.model === q.model);
          if (!item) item = q;

          const driveMain = getDriveMainImage(item.model, item.mainModel);
          const driveNetList = getDriveNetImages(item.model, item.mainModel);
          const stock = getInventoryRangeLabel(item.inventory) || "-";
          const showMinPrice = state.userLevel >= 1;
          const subtotal = (Number(q.price) || 0) * (Number(q.count) || 1);

          const baseRow = [
              q.model, item.mainModel || "", item.category || "", q.name, item.colorList || "", 
              item.netSalesPermission || "", item.cartonQty || "", item.productUrl || "", 
              driveMain || "", (driveNetList || []).join(" | ")
          ];

          let displayMin = showMinPrice ? (item.minPrice ?? "-") : "---";
          if (state.currentUserVipConfig && item[state.currentUserVipConfig.column]) {
               displayMin = "-"; 
          }

          const priceRow = [
              q.qtyLabel, q.price, q.count, subtotal,
              displayMin, item.marketPrice ?? "-", stock
          ];
          
          rows.push([...baseRow, ...priceRow]);
      });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "報價單");
  XLSX.writeFile(wb, `KINYO_報價單匯出_${new Date().toISOString().slice(0,10)}.xlsx`);
}

/* 報價行為記錄 */
export async function logQuoteAction(items, sourceMode) {
    try {
        const timestamp = new Date();
        const userEmail = state.currentUserEmail || "guest";
        const userName = (state.currentUserVipConfig && state.currentUserVipConfig.name) ? state.currentUserVipConfig.name : userEmail; 
        
        let totalAmount = 0;
        let productDetails = [];
        
        if (sourceMode === 'quote') {
            items.forEach(i => {
                const p = parseFloat(i.customQuoteInfo?.price || i.price || 0);
                const q = parseInt(i.count || 1);
                const subtotal = p * q;
                totalAmount += subtotal;
                
                productDetails.push({
                    model: i.model,
                    name: i.name,
                    price: p,
                    qty: q,
                    qtyLabel: i.customQuoteInfo?.qtyLabel || i.qtyLabel || "自訂",
                    subtotal: subtotal
                });
            });
        } else {
            const currentTier = document.getElementById("qtySelect").value || "50"; 
            items.forEach(i => {
                let finalPrice = calcQuotePrice(i.cost, Number(currentTier), state.userLevel) || 0;
                if(state.currentUserVipConfig) {
                     finalPrice = i[state.currentUserVipConfig.column] || 0;
                }
                const p = parseFloat(finalPrice);
                const q = 1;
                const subtotal = p * q;
                totalAmount += subtotal;

                productDetails.push({
                    model: i.model,
                    name: i.name,
                    price: p,
                    qty: q,
                    qtyLabel: `${currentTier}個(預設)`,
                    subtotal: subtotal
                });
            });
        }

        const logData = {
            action: "generate_ppt",
            source: sourceMode,
            user: userName,
            email: userEmail,
            createdAt: timestamp,
            totalAmount: totalAmount,
            itemCount: productDetails.length,
            items: productDetails
        };

        const historyRef = collection(db, "QuoteHistory");
        addDoc(historyRef, logData).then(() => {
            console.log("✅ 報價紀錄已儲存 (總額: $" + totalAmount + ")");
        });

    } catch (e) {
        console.warn("⚠️ 報價紀錄寫入失敗:", e);
    }
}

/* 打勾關注行為記錄 */
export async function logCheckboxInterest(item) {
    try {
        const timestamp = new Date();
        const logData = {
            model: item.model,
            name: item.name,
            price: item.marketPrice || 0,
            createdAt: timestamp,
            source: "backend_check"
        };

        const historyRef = collection(db, "ProductClicks");
        addDoc(historyRef, logData).then(() => {});

    } catch (e) {
        console.warn("關注紀錄寫入失敗:", e);
    }
}
