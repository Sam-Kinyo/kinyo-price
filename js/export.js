/* =======================================================
   匯出模組 (Export: PPT / Excel / LINE / 大數據)
======================================================= */
import { collection, getDocs } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from './firebase-init.js';
import { state } from './state.js';
import { fetchAsDataURL, getInventoryRangeLabel } from './helpers.js';
import { getDriveMainImage, getDriveNetImages } from './data.js';
import { logQuoteAction } from './quote.js';

/* PPT 單頁建構 */
async function buildProductSlide(pptx, item, tier, customQuoteInfo) {
    const slide = pptx.addSlide();
    slide.background = { color: "FFFFFF" };

    let rawName = item.name || "未命名商品";
    let cleanName = rawName.replace(/\*.*$/, '').trim();

    const netImages = getDriveNetImages(item.model, item.mainModel) || [];
    let imagesToDisplay = [...netImages];
    const driveMain = getDriveMainImage(item.model, item.mainModel);
    const rawImg = item.imageUrl;
    
    const addUnique = (url) => {
        if(url && !imagesToDisplay.includes(url) && imagesToDisplay.length < 6) {
            imagesToDisplay.push(url);
        }
    };
    addUnique(driveMain);
    if(rawImg && rawImg.startsWith('http')) addUnique(rawImg);

    let quoteLabel = "", quotePriceStr = "";
    if (customQuoteInfo) {
        quoteLabel = `專案報價 (${customQuoteInfo.qtyLabel})`;
        quotePriceStr = `$${customQuoteInfo.price}`;
    } else {
        const quoteKey = `quote${tier}`;
        const p = item[quoteKey] || item.quote50 || "-";
        quoteLabel = `批量報價 (${tier}pcs)`;
        quotePriceStr = `$${p}`;
    }
    const marketPriceStr = `市價 $${item.marketPrice}`;

    try {
        const logoUrl = "https://drive.google.com/uc?id=1JxoU3A5qAYsE39pc2z7IMVwVS8-uTOIn"; 
        const logoB64 = await fetchAsDataURL(logoUrl);
        if(logoB64) {
            slide.addImage({ data: logoB64, x: 0.3, y: 0.2, w: 2.2, h: 0.8 }); 
        }
    } catch(e) {}

    let nameFontSize = 24; 
    if (cleanName.length > 15) nameFontSize = 20;
    if (cleanName.length > 25) nameFontSize = 16;
    if (cleanName.length > 40) nameFontSize = 14;

    slide.addText(cleanName, {
        x: 0.3, y: 1.1, w: 6.0, h: 0.7,
        fontSize: nameFontSize, bold: true, color: "1f2937", fontFace: "微軟正黑體", valign: "top"
    });

    slide.addShape(pptx.ShapeType.rect, { 
        x: 6.5, y: 0.2, w: 3.2, h: 1.5, 
        fill: { color: "f8fafc" }, 
        line: { color: "e2e8f0", width: 0.5 },
        rectRadius: 0.1 
    });

    slide.addText(quoteLabel, {
        x: 6.7, y: 0.3, w: 2.8, h: 0.3,
        fontSize: 12, color: "64748b", align: "right", fontFace: "微軟正黑體"
    });

    let priceFontSize = 36;
    if (quotePriceStr.length > 7) priceFontSize = 28;

    slide.addText(quotePriceStr, {
        x: 6.7, y: 0.55, w: 2.8, h: 0.7,
        fontSize: priceFontSize, color: "dc2626", bold: true, align: "right", fontFace: "Arial"
    });

    slide.addText(marketPriceStr, {
        x: 6.7, y: 1.25, w: 2.8, h: 0.3,
        fontSize: 11, color: "94a3b8", align: "right", fontFace: "微軟正黑體"
    });

    const startY = 1.9; 
    const pageW = 10.0; 
    const marginX = 0.25; 
    const gap = 0.1; 
    
    const cellW = (pageW - (marginX * 2) - (gap * 2)) / 3; 
    const cellH = 2.55; 

    for (let i = 0; i < 6; i++) {
        const r = Math.floor(i / 3);
        const c = i % 3;
        
        const x = marginX + c * (cellW + gap);
        const y = startY + r * (cellH + gap);

        slide.addShape(pptx.ShapeType.rect, { 
            x: x, y: y, w: cellW, h: cellH, 
            fill: { color: "ffffff" }, 
            line: { color: "e5e7eb", width: 0.5 } 
        });

        if (i < imagesToDisplay.length) {
            const url = imagesToDisplay[i];
            try {
                const b64 = await fetchAsDataURL(url);
                if(b64) {
                    slide.addImage({ 
                        data: b64, 
                        x: x + 0.05, y: y + 0.05, 
                        w: cellW - 0.1, h: cellH - 0.1, 
                        sizing: { type: "contain", w: cellW - 0.1, h: cellH - 0.1 } 
                    });
                }
            } catch(e) {
                slide.addText("Image Error", { x:x, y:y+1, w:cellW, fontSize:10, align:"center", color:"ccc" });
            }
        } else {
             slide.addText("KINYO", {
                x: x, y: y + (cellH/2) - 0.2, w: cellW, h: 0.4,
                fontSize: 14, color: "f3f4f6", align: "center", fontFace: "Arial", bold: true
            });
        }
    }

    const dateStr = new Date().toISOString().split('T')[0];
    slide.addText(`KINYO | 型號：${item.mainModel} | 報價日期：${dateStr}`, {
        x: 0.3, y: 7.1, w: 9.0, h: 0.3,
        fontSize: 9, color: "cbd5e1", fontFace: "微軟正黑體"
    });
}

/* PPT 批次生成 */
export async function exportSelectedPPT(source = 'checked') {
  if (typeof PptxGenJS === "undefined") { alert("PPT 模組未載入"); return; }
  
  let selectedItems = [];
  const qtySelect = document.getElementById("qtySelect");
  let tier = qtySelect.value || "50";
  let isFromQuoteList = false;

  if (source === 'quote') {
      if (state.quoteList.length === 0) { alert("報價單是空的"); return; }
      selectedItems = state.quoteList.map(q => {
          let fullItem = state.currentResultList.find(p => p.model === q.model) || state.productCache.find(p => p.model === q.model);
          if (!fullItem) {
               fullItem = { ...q, imageUrl: '', netImages: [] }; 
          }
          return { ...fullItem, customQuoteInfo: { price: q.price, qtyLabel: q.qtyLabel } };
      });
      isFromQuoteList = true;
  } else {
      const checks = Array.from(document.querySelectorAll(".row-check:checked"));
      if (checks.length < 1) { alert("請至少勾選 1 個商品才能生成 PPT。"); return; }
      
      selectedItems = checks.map(cb => {
          const model = cb.dataset.model;
          let item = state.currentResultList.find(p => p.model === model);
          if(!item) item = state.currentResultList.find(p => p.mainModel === model);
          if(!item) item = state.currentResultList.find(p => Array.isArray(p.models) && p.models.includes(model));
          return item;
      }).filter(Boolean);
  }

  if (selectedItems.length === 0) { alert("找不到商品資料，無法生成 PPT。"); return; }

  logQuoteAction(selectedItems, source);

  const pptFromQuoteBtn = document.getElementById("pptFromQuoteBtn");
  const pptToolbarBtn = document.getElementById("pptToolbarBtn");
  const btn = source === 'quote' ? pptFromQuoteBtn : pptToolbarBtn;
  const originalText = btn.textContent;
  btn.disabled = true; 

  try {
    const CHUNK_SIZE = 20; 
    const batches = [];
    for (let i = 0; i < selectedItems.length; i += CHUNK_SIZE) {
        batches.push(selectedItems.slice(i, i + CHUNK_SIZE));
    }

    const salesName = "郭庭豪";
    const salesPhone = "0976-966333";

    for (let i = 0; i < batches.length; i++) {
        btn.textContent = `生成中 (${i + 1}/${batches.length})...`;

        const pptx = new PptxGenJS();
        pptx.layout = "LAYOUT_4x3"; 
        pptx.author = "KINYO Price System";
        pptx.company = "KINYO";
        pptx.title = `KINYO Quote`;

        const currentBatch = batches[i];
        
        await Promise.all(currentBatch.map(async (item) => {
            await buildProductSlide(pptx, item, tier, item.customQuoteInfo);
        }));
        
        let filename = `KINYO-商品推薦報價-@${salesName}-@${salesPhone}`;
        if (batches.length > 1) {
            filename += `_Part${i + 1}`;
        }
        filename += ".pptx";

        await pptx.writeFile({ fileName: filename });
    }

  } catch (e) {
    console.error(e);
    alert("PPT 生成失敗，請查看 Console。");
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

/* Excel 匯出 */
export function exportSelectedExcel() {
  const checked = document.querySelectorAll(".row-check:checked");
  if (checked.length === 0) { alert("請先勾選要匯出的商品"); return; }
  const selectedModels = Array.from(checked).map(c => c.getAttribute("data-model"));
  const qtySelect = document.getElementById("qtySelect");
  
  let rows = [];

  if (state.isGroupBuyUser) {
      const costCol = (state.currentUserVipConfig && state.currentUserVipConfig.column) ? state.currentUserVipConfig.column : 'VIP_C';
      const displayName = (state.currentUserVipConfig && state.currentUserVipConfig.name) ? state.currentUserVipConfig.name : costCol;

      const header = [
          "商品型號", "分類", "商品名稱", "箱入數", "團購價", 
          `${displayName} 進價`, "賣場價", "庫存量", "商品連結"
      ];
      rows.push(header);

      selectedModels.forEach(m => {
          const item = state.currentResultList.find(p => p.model === m);
          if (!item) return;

          const gbPrice = item.groupBuyPrice ? `$${item.groupBuyPrice}` : "未開放";
          const myCost = item[costCol] ? `$${item[costCol]}` : "-";
          const market = item.marketPrice ? `$${item.marketPrice}` : "-";
          const stock = getInventoryRangeLabel(item.inventory) || "-";

          rows.push([
              item.model, item.category || "", item.name, item.cartonQty || "", 
              gbPrice, myCost, market, stock, item.productUrl || ""
          ]);
      });
  } else {
      const baseHeader = ["商品型號","主型號","分類","商品名稱","顏色列表","網路權限","箱入數","商品連結","商品大圖","網路圖"];
      
      const qty = qtySelect.value;
      const priceHeader = qty ? [`${qty}個報價`, "末售參考", "賣場售價", "庫存狀態"] : ["末售參考", "賣場售價", "庫存狀態"];
      
      rows.push([...baseHeader, ...priceHeader]);

      selectedModels.forEach(m => {
          const item = state.currentResultList.find(p => p.model === m);
          if (!item) return;
          
          const driveMain = getDriveMainImage(item.model, item.mainModel);
          const driveNetList = getDriveNetImages(item.model, item.mainModel);
          const stock = getInventoryRangeLabel(item.inventory) || "-";
          const showMinPrice = state.userLevel >= 1;

          const baseRow = [
              item.model, item.mainModel, item.category || "", item.name, item.colorList || "", 
              item.netSalesPermission || "", item.cartonQty || "", item.productUrl || "", 
              driveMain || "", driveNetList.join(" | ")
          ];

          let priceRow = [];
          
          let displayMin = showMinPrice ? (item.minPrice ?? "-") : "---";
          if (state.currentUserVipConfig && item[state.currentUserVipConfig.column]) {
               displayMin = "-"; 
          }

          if (qty) {
              const ck = `quote${qty}`;
              let canSeeQuote = false;
              if (state.userLevel >= 1 && qty == 50) canSeeQuote = true;
              if (state.userLevel >= 2 && (qty == 100 || qty == 300)) canSeeQuote = true;
              if (state.userLevel >= 3 && (qty == 500 || qty == 1000)) canSeeQuote = true;
              if (state.userLevel >= 4 && qty == 3000) canSeeQuote = true;

              const cost = canSeeQuote ? (item[ck] ?? item.quote50 ?? "-") : "---";
              priceRow = [cost, displayMin, item.marketPrice ?? "-", stock];
          } else {
              priceRow = [displayMin, item.marketPrice ?? "-", stock];
          }
          rows.push([...baseRow, ...priceRow]);
      });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "報價單");
  
  const fileTag = state.isGroupBuyUser ? "團購專用" : (qtySelect.value ? qtySelect.value+'個' : '搜尋結果');
  XLSX.writeFile(wb, `KINYO_商品報價_${fileTag}_${new Date().toISOString().slice(0,10)}.xlsx`);
}

/* 大數據匯出 */
export async function exportQuoteHistory() {
    if (!confirm("確定要匯出所有報價紀錄嗎？這可能需要一點時間。")) return;
    
    const btn = document.getElementById("exportHistoryBtn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "正在下載雲端數據...";

    try {
        const q = collection(db, "QuoteHistory"); 
        const querySnapshot = await getDocs(q);
        
        let rows = [];
        rows.push(["日期", "時間", "業務/客戶", "操作來源", "整單總金額", "商品型號", "商品名稱", "數量", "報價單價", "小計"]);

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const dateObj = data.createdAt ? data.createdAt.toDate() : new Date();
            const dateStr = dateObj.toLocaleDateString('zh-TW');
            const timeStr = dateObj.toLocaleTimeString('zh-TW');

            if (data.items && Array.isArray(data.items)) {
                data.items.forEach(item => {
                    rows.push([
                        dateStr, timeStr, data.user || "Guest",
                        data.source === 'quote' ? '報價單生成' : '列表直接生成',
                        data.totalAmount || 0, item.model, item.name,
                        item.qty, item.price, item.subtotal
                    ]);
                });
            }
        });

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.aoa_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, "報價大數據");
        XLSX.writeFile(wb, `KINYO_報價大數據_${new Date().toISOString().slice(0,10)}.xlsx`);

        alert(`匯出成功！共下載 ${querySnapshot.size} 筆操作紀錄。`);

    } catch (e) {
        console.error("匯出失敗:", e);
        alert("匯出失敗，請檢查 Console 錯誤訊息 (可能需要建立 Firebase 索引)");
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
    }
}
