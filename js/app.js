/* =======================================================
   App 主入口 (Main Entry Point)
   所有模組在此整合
======================================================= */
import { doc, setDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from './firebase-init.js';
import { state } from './state.js';
import { closeSheet, closeQuoteSheet, openQuoteSheet, shuffleArray, calcQuotePrice, canViewTier } from './helpers.js';
import { searchProducts, applySorting, setupQtySelectByLevel, updateUserDisplay } from './search.js';
import { renderResults, updateMultiLineBtnState, updateToolbarScrollState } from './render.js';
import { renderQuoteList, updateQuoteToolbarBtn, downloadQuoteExcel } from './quote.js';
import { exportSelectedPPT, exportSelectedExcel, exportQuoteHistory } from './export.js';
import { setupProductUpload, saveProductDataToFirestore, saveInventoryToFirestore } from './import.js';
import { setupLoginButton, setupLogoutButton, setupAuthListener, updatePermissions } from './auth.js';

/* =======================================================
   DOM References
======================================================= */
const searchForm      = document.getElementById("searchForm");
const sortSelect      = document.getElementById("sortSelect");
const exportBtn       = document.getElementById("exportBtn");
const pptToolbarBtn   = document.getElementById("pptToolbarBtn");
const multiLineBtn    = document.getElementById("multiLineBtn");
const batchAddQuoteBtn = document.getElementById("batchAddQuoteBtn");
const clearBtn        = document.getElementById("clearBtn");
const importProductBtn = document.getElementById("importProductBtn");
const productUpload   = document.getElementById("productUpload");

const sheetCloseBtn   = document.getElementById("sheetCloseBtn");
const quoteCloseBtn   = document.getElementById("quoteCloseBtn");
const sheetBackdrop   = document.getElementById("sheetBackdrop");
const quoteToolbarBtn = document.getElementById("quoteToolbarBtn");
const pptFromQuoteBtn = document.getElementById("pptFromQuoteBtn");
const copyQuoteBtn    = document.getElementById("copyQuoteBtn");
const clearQuoteBtn   = document.getElementById("clearQuoteBtn");
const downloadQuoteExcelBtn = document.getElementById("downloadQuoteExcelBtn");

const previewOverlay  = document.getElementById("previewOverlay");
const cancelImportBtn = document.getElementById("cancelImportBtn");
const confirmImportBtn = document.getElementById("confirmImportBtn");
const levelSwitchWrap = document.getElementById("levelSwitchWrap");
const levelSwitchSelect = document.getElementById("levelSwitchSelect");

function syncLevelSwitchVisibility() {
  if (!levelSwitchWrap || !levelSwitchSelect) return;
  const canSwitch = state.originalUserLevel >= 4;
  levelSwitchWrap.style.display = canSwitch ? "flex" : "none";
  if (!canSwitch) {
    levelSwitchSelect.value = "original";
  }
}

function applyTemporaryLevelSwitch() {
  if (!levelSwitchSelect) return;
  if (state.originalUserLevel < 4) return;

  const selected = levelSwitchSelect.value;
  if (selected === "original") {
    state.userLevel = state.originalUserLevel;
  } else {
    state.userLevel = Number(selected) || state.originalUserLevel;
  }

  const qtySelect = document.getElementById("qtySelect");
  const prevQty = qtySelect ? qtySelect.value : "";
  setupQtySelectByLevel();
  if (qtySelect) {
    if (prevQty && canViewTier(state.userLevel, Number(prevQty))) {
      qtySelect.value = prevQty;
    } else {
      qtySelect.value = "";
    }
  }

  updatePermissions();
  updateUserDisplay("normal");
  if (state.currentResultList.length > 0) {
    renderResults(state.currentResultList);
  }
}

/* =======================================================
   Event Bindings
======================================================= */

// 搜尋表單
searchForm.onsubmit = (e) => { e.preventDefault(); searchProducts(); };

// 匯出 Excel
exportBtn.onclick = exportSelectedExcel;

// 匯入產品
if(importProductBtn) {
    importProductBtn.onclick = () => {
        productUpload.value = '';
        productUpload.click();
    };
}
setupProductUpload();

// 大數據匯出
const exportHistoryBtn = document.getElementById("exportHistoryBtn");
if(exportHistoryBtn) {
    exportHistoryBtn.onclick = exportQuoteHistory;
}

if (levelSwitchSelect) {
  levelSwitchSelect.onchange = applyTemporaryLevelSwitch;
}

window.addEventListener("level-state-changed", () => {
  syncLevelSwitchVisibility();
  if (levelSwitchSelect) levelSwitchSelect.value = "original";
  // 確保等級變更後起訂量選單一定和最新權限同步
  setupQtySelectByLevel();
});

// 預覽取消 / 確認
if(cancelImportBtn) {
    cancelImportBtn.onclick = () => {
        previewOverlay.style.display = "none";
        state.pendingInventoryMap.clear();
        state.pendingProductData = [];
        productUpload.value = '';
    };
}

if(confirmImportBtn) {
    confirmImportBtn.onclick = () => {
        if(state.currentImportMode === 'inventory') {
            if(state.pendingInventoryMap.size === 0) return;
            previewOverlay.style.display = "none";
            saveInventoryToFirestore(state.pendingInventoryMap);
        } else if(state.currentImportMode === 'product') {
            if(state.pendingProductData.length === 0) return;
            previewOverlay.style.display = "none";
            saveProductDataToFirestore(state.pendingProductData);
        }
    };
}

// PPT 生成
if(pptToolbarBtn) {
  pptToolbarBtn.onclick = () => exportSelectedPPT('checked');
}
if(pptFromQuoteBtn) {
  pptFromQuoteBtn.onclick = () => exportSelectedPPT('quote');
}

// 報價單 Excel 下載
if(downloadQuoteExcelBtn) {
  downloadQuoteExcelBtn.onclick = downloadQuoteExcel;
}

// 報價單複製
if(copyQuoteBtn) {
  copyQuoteBtn.onclick = () => {
    if (state.quoteList.length === 0) return alert("報價單是空的");
    let text = "KINYO 報價單\n--------------------\n";
    state.quoteList.forEach((q,i)=>{
      const priceDisplay = `$${q.price}`;
      const link = q.productUrl ? `   🔗 連結：${q.productUrl}\n` : "";
      text += `${i+1}. 【${q.model}】${q.name}\n   ${q.qtyLabel}：${priceDisplay} x ${q.count}\n${link}`;
    });
    text += "--------------------\n";
    navigator.clipboard.writeText(text)
      .then(() => alert("報價單已複製"))
      .catch(() => alert("複製失敗"));
  };
}

// 清除搜尋
if(clearBtn) {
  clearBtn.onclick = () => {
    document.getElementById("keyword").value = "";
    document.getElementById("qtySelect").value = "";
    document.getElementById("minPrice").value = "";
    document.getElementById("maxPrice").value = "";
    document.getElementById("stockFilter").value = "";
    document.getElementById("categorySelect").value = "";

    document.getElementById("resultBody").innerHTML = "";
    document.getElementById("resultTable").style.display = "none";
    exportBtn.disabled = true;
    if(pptToolbarBtn) pptToolbarBtn.disabled = true;
    if(multiLineBtn) multiLineBtn.disabled = true;
    if(batchAddQuoteBtn) batchAddQuoteBtn.disabled = true; 
    document.getElementById("checkAll").checked = false;
    document.getElementById("detailCard").style.display = "none";
  };
}

// 清空報價單
if(clearQuoteBtn) {
  clearQuoteBtn.onclick = () => {
    if(state.quoteList.length === 0) {
        alert("報價單已經是空的");
        return;
    }
    if(confirm("確定要清空報價單嗎？這將無法復原。")) {
        state.quoteList = [];
        renderQuoteList();
        updateQuoteToolbarBtn();
    }
  };
}

// 排序變更
if(sortSelect) {
  sortSelect.onchange = () => {
    if (state.currentResultList.length > 0) {
      const activeItems = state.currentResultList.filter(p => (parseInt(p.inventory || 0, 10) > 0));
      const zeroItems   = state.currentResultList.filter(p => (parseInt(p.inventory || 0, 10) <= 0));

      let sortedActive = [];
      let sortedZero = [];

      if (!sortSelect.value) {
          sortedActive = shuffleArray(activeItems);
          sortedZero = shuffleArray(zeroItems);
      } else {
          sortedActive = applySorting([...activeItems]);
          sortedZero = applySorting([...zeroItems]);
      }

      const finalSortedList = [...sortedActive, ...sortedZero];
      renderResults(finalSortedList);
      state.currentResultList = finalSortedList;
    }
  };
}

// Sheet 關閉
if(sheetCloseBtn) sheetCloseBtn.onclick = closeSheet;
if(quoteCloseBtn) quoteCloseBtn.onclick = closeQuoteSheet;

if(sheetBackdrop) {
  sheetBackdrop.onclick = () => {
    const mobileSheet = document.getElementById("mobileDetailSheet");
    const quoteSheet = document.getElementById("quoteSheet");
    if (!mobileSheet.classList.contains("hidden")) closeSheet();
    if (!quoteSheet.classList.contains("hidden")) closeQuoteSheet();
  };
}

// 報價單工具按鈕
if(quoteToolbarBtn) quoteToolbarBtn.onclick = openQuoteSheet;

// Scroll 事件
window.addEventListener('scroll', updateToolbarScrollState);

/* =======================================================
   全域 Click 代理 (Quote / LINE / Detail Card)
======================================================= */
document.addEventListener("click", (e) => {
  // 加入報價單
  if (e.target.classList.contains("add-quote-btn")) {
    const model = e.target.getAttribute("data-model");
    const item  = state.currentResultList.find(p => p.model === model);
    if (!item) return;

    const qtySelect = document.getElementById("qtySelect");
    const qty = qtySelect.value || "50";
    const livePrice = calcQuotePrice(item.cost, Number(qty), state.userLevel);
    const cost = livePrice ?? 0;

    const existingIndex = state.quoteList.findIndex(q => q.model === item.model && q.qtyLabel === `${qty}個`);
    
    if (existingIndex > -1) {
        state.quoteList[existingIndex].count += 1;
        alert(`已更新報價單：${item.name} (數量: ${state.quoteList[existingIndex].count})`);
    } else {
        state.quoteList.push({
          model: item.model,
          name: item.name,
          price: cost,
          qtyLabel: `${qty}個`,
          count: 1,
          productUrl: item.productUrl || ""
        });
        alert(`已加入報價單（${qty}個：$${cost}）`);
    }

    updateQuoteToolbarBtn();
    return;
  }

  // LINE 分享
  if (e.target.classList.contains("line-share-btn")) {
    const model = e.target.getAttribute("data-model");
    const item  = state.currentResultList.find(p => p.model === model);
    if (!item) return;

    const showMinPrice = state.userLevel >= 1;
    const getPrice = (p) => (item[p] ?? "-");
    const qtySelect = document.getElementById("qtySelect");

    let costText = "";
    const currentQty = qtySelect.value; 

    if (currentQty) {
        const canSee = canViewTier(state.userLevel, Number(currentQty));
        if(canSee) {
              const live = calcQuotePrice(item.cost, Number(currentQty), state.userLevel);
              costText += `${currentQty}個：${live ?? "-"}\n`;
        } else {
              costText += `${currentQty}個：(無權限)\n`;
        }
    } else {
        if (state.userLevel >= 1) costText += `50個：${calcQuotePrice(item.cost, 50, state.userLevel) ?? "-"}\n`;
        if (state.userLevel >= 1) costText += `100個：${calcQuotePrice(item.cost, 100, state.userLevel) ?? "-"}\n`;
        if (state.userLevel >= 2) costText += `300個：${calcQuotePrice(item.cost, 300, state.userLevel) ?? "-"}\n`;
        if (state.userLevel >= 3) {
          costText += `500個：${calcQuotePrice(item.cost, 500, state.userLevel) ?? "-"}\n`;
          costText += `1000個：${calcQuotePrice(item.cost, 1000, state.userLevel) ?? "-"}\n`;
        }
        if (state.userLevel >= 4) {
          costText += `3000個：${calcQuotePrice(item.cost, 3000, state.userLevel) ?? "-"}\n`;
        }
    }

    const text = `【${item.model}】${item.name}
賣場售價：${getPrice('marketPrice')}
末售價格：${showMinPrice ? getPrice('minPrice') : '---'}
--------------------
採購價格：
${costText}
商品連結：${item.productUrl || "無"}`;

    navigator.clipboard.writeText(text)
      .then(() => alert("已複製到剪貼簿"))
      .catch(() => alert("複製失敗"));
  }

  // Detail Card 關閉邏輯
  const card = document.getElementById("detailCard");
  if (card && card.style.display !== "none") {
    if (!card.contains(e.target) && !e.target.closest("tr")) {
      card.style.display = "none";
    }
  }

  if(card && !card.hasAttribute("data-listeners-added")){
      card.setAttribute("data-listeners-added", "true");
      card.addEventListener("mouseenter", () => {
        if (window.hideDetailTimer) clearTimeout(window.hideDetailTimer);
      });
      card.addEventListener("mouseleave", () => {
        window.hideDetailTimer = setTimeout(() => {
          card.style.display = "none";
        }, 1000);
      });
  }
});

// 批次加入候選清單
if (batchAddQuoteBtn) {
    batchAddQuoteBtn.onclick = () => {
        const checked = document.querySelectorAll(".row-check:checked");
        if (checked.length === 0) {
            alert("請先勾選要加入候選清單的商品");
            return;
        }

        const qtySelect = document.getElementById("qtySelect");
        const qty = qtySelect.value || "50";
        let addedCount = 0;

        Array.from(checked).forEach(c => {
            const model = c.getAttribute("data-model");
            const item = state.currentResultList.find(p => p.model === model);
            if (!item) return;

            const livePrice = calcQuotePrice(item.cost, Number(qty), state.userLevel);
            const cost = livePrice ?? 0;
            const qtyLabel = `${qty}個`;

            const existingIndex = state.quoteList.findIndex(q => q.model === item.model && q.qtyLabel === qtyLabel);

            if (existingIndex > -1) {
                state.quoteList[existingIndex].count += 1;
            } else {
                state.quoteList.push({
                    model: item.model,
                    name: item.name,
                    price: cost,
                    qtyLabel: qtyLabel,
                    count: 1,
                    productUrl: item.productUrl || ""
                });
            }
            addedCount++;
        });

        updateQuoteToolbarBtn();
        alert(`已成功將 ${addedCount} 項商品加入候選清單！`);
    };
}

// 多選 LINE 分享
if (multiLineBtn) {
    multiLineBtn.onclick = () => {
        const checked = document.querySelectorAll(".row-check:checked");
        if (checked.length === 0) {
            alert("請先勾選要分享的商品");
            return;
        }

        const qtySelect = document.getElementById("qtySelect");
        const qty = qtySelect.value || "50";
        let text = `KINYO 多品項報價（起訂量：${qty}個）\n--------------------\n`;

        Array.from(checked).forEach((c, i) => {
            const model = c.getAttribute("data-model");
            const item = state.currentResultList.find(p => p.model === model);
            if (!item) return;

            const canSeeQuote = canViewTier(state.userLevel, Number(qty));
            const livePrice = calcQuotePrice(item.cost, Number(qty), state.userLevel);
            const cost = canSeeQuote ? (livePrice ?? "-") : "---";
            const market = item.marketPrice ?? "-";
            const link = item.productUrl || "無連結";

            text += `${i + 1}. 【${item.model}】${item.name}\n`;
            text += `   💰 ${qty}個報價：$${cost}\n`;
            text += `   🛒 賣場售價：$${market}\n`;
            text += `   🔗 商品連結：${link}\n\n`;
        });

        text += "--------------------\n";
        text += "以上報價僅供參考，實際以最終確認為主。";

        navigator.clipboard.writeText(text)
            .then(() => alert(`已複製 ${checked.length} 項商品的報價資訊！請直接在 LINE 貼上。`))
            .catch(() => alert("複製失敗，請手動複製。"));
    };
}

// 設定首頁熱門 (Level 4)
const setHotBtn = document.getElementById("setHotBtn");
if(setHotBtn) {
    setHotBtn.onclick = async () => {
        if (state.userLevel < 4) { alert("權限不足"); return; }

        const checked = document.querySelectorAll(".row-check:checked");
        const checkAllBox = document.getElementById("checkAll");
        
        if (checked.length === 0) { alert("請先勾選商品！"); return; }
        if (checked.length > 6) { alert(`首頁版面限制 6 個商品，您目前勾選了 ${checked.length} 個。`); return; }

        if(!confirm(`確定要將這 ${checked.length} 個商品設為首頁「本週熱門」嗎？\n(這將覆蓋舊的名單，並立即生效)`)) return;

        setHotBtn.disabled = true;
        setHotBtn.textContent = "設定中...";

        try {
            let newHotList = [];
            let rank = 1;

            for(const checkbox of checked) {
                const model = checkbox.getAttribute("data-model");
                const item = state.currentResultList.find(p => p.model === model) || state.productCache.find(p => p.model === model);
                
                if(item) {
                    newHotList.push({
                        model: item.model,
                        count: Math.floor(180 - ((rank-1) * 25) + Math.random() * 15) 
                    });
                    rank++;
                }
            }

            await setDoc(doc(db, "SiteConfig", "homeHotList"), {
                updatedAt: new Date(),
                items: newHotList,
                editor: state.currentUserEmail
            });

            alert(`✅ 設定成功！首頁熱門榜已更新。\n共 ${newHotList.length} 筆商品。`);
            
            checkAllBox.checked = false;
            checked.forEach(c => c.checked = false);
            updateMultiLineBtnState();

        } catch(e) {
            console.error("設定失敗:", e);
            alert("設定失敗：請檢查 Firebase Rules 是否允許 SiteConfig 寫入。");
        } finally {
            setHotBtn.disabled = false;
            setHotBtn.textContent = "🔥 設為首頁熱門 (L4)";
        }
    };
}

/* =======================================================
   初始化
======================================================= */
setupLoginButton();
setupLogoutButton();
setupAuthListener();
