/* =======================================================
   搜尋與排序模組 (Search & Sort)
======================================================= */
import { state } from './state.js';
import { showLoading, hideLoading, shuffleArray } from './helpers.js';
import { renderResults } from './render.js';

/* 起訂量下拉選單設定 */
export function setupQtySelectByLevel() {
  const qtySelect = document.getElementById("qtySelect");
  qtySelect.innerHTML = "";
  const emptyOpt = document.createElement("option");
  emptyOpt.value = ""; emptyOpt.textContent = "不使用起訂量";
  qtySelect.appendChild(emptyOpt);
  
  const add = (v,t)=>{
    const o = document.createElement("option"); o.value = v; o.textContent = t; qtySelect.appendChild(o);
  };
  
  if (state.userLevel >= 1) { add("50", "50 個"); add("100", "100 個"); }
  if (state.userLevel >= 2) { add("300", "300 個"); }
  if (state.userLevel >= 3) { add("500", "500 個"); add("1000", "1000 個"); }
}

/* 排序 */
export function applySorting(list) {
  const o = document.getElementById("sortSelect").value;
  if (o === "minPriceAsc")  return list.sort((a,b)=> (a.minPrice||0) - (b.minPrice||0));
  if (o === "minPriceDesc") return list.sort((a,b)=> (b.minPrice||0) - (a.minPrice||0));
  if (o === "marketAsc")    return list.sort((a,b)=> (a.marketPrice||0) - (b.marketPrice||0));
  if (o === "marketDesc")   return list.sort((a,b)=> (b.marketPrice||0) - (a.marketPrice||0));
  if (o === "alphaAsc")     return list.sort((a,b)=> (a.mainModel||"").localeCompare(b.mainModel||""));
  if (o === "alphaDesc")    return list.sort((a,b)=> (b.mainModel||"").localeCompare(a.mainModel||""));
  return list;
}

/* 使用者身分顯示更新 */
export function updateUserDisplay(status) {
  const userInfoSpan = document.getElementById("userInfo");
  if (!userInfoSpan) return;
  if (status === 'searching') {
    userInfoSpan.textContent = "🔍 搜尋運算中...";
    userInfoSpan.style.background = "#fef9c3";
    userInfoSpan.style.color = "#854d0e";
    userInfoSpan.className = "user-badge";
  } else {
    let badgeClass = "badge-lv0";
    if (state.userLevel === 1) badgeClass = "badge-lv1";
    else if (state.userLevel === 2) badgeClass = "badge-lv2";
    else if (state.userLevel >= 3) badgeClass = "badge-lv3";
    
    if (state.currentUserVipConfig) {
        badgeClass = "badge-vip";
        userInfoSpan.textContent = `${state.currentUserVipConfig.name} (VIP)`;
    } else {
        userInfoSpan.textContent = `${state.currentUserEmail.replace(/@.*/, "")}`;
    }
    
    userInfoSpan.className = `user-badge ${badgeClass}`;
    userInfoSpan.style.background = ""; 
    userInfoSpan.style.color = "";
  }
}

/* 搜尋核心邏輯 */
export function searchProducts() {
  if (!state.isProductsLoaded) { alert("商品資料載入中"); return; }
  
  const keywordInput = document.getElementById("keyword");
  const qtySelect = document.getElementById("qtySelect");
  const minPriceInput = document.getElementById("minPrice");
  const maxPriceInput = document.getElementById("maxPrice");
  const categorySelect = document.getElementById("categorySelect");
  const stockFilter = document.getElementById("stockFilter");
  const sortSelect = document.getElementById("sortSelect");

  const rawInput = keywordInput.value.trim().toLowerCase();
  const keys = rawInput.split(/[\s,，\n]+/).filter(k => k.length > 0);
  const hasKey = keys.length > 0;

  const qty = qtySelect.value;
  const minPraw = minPriceInput.value.trim();
  const maxPraw = maxPriceInput.value.trim();
  const cat = categorySelect.value; 
  const stockReq = stockFilter.value; 
  
  const controlledCheck = document.getElementById("controlledFilter");
  const isControlledOnly = controlledCheck && controlledCheck.checked;
  
  const hasQty = !!qty;
  const hasBudget = !!minPraw || !!maxPraw;
  const hasCat = !!cat; 
  const hasStockReq = !!stockReq;

  if (hasBudget && !hasQty && state.userLevel >= 1) {
    alert("搜尋預算區間時，必須選擇「起訂量」！");
    return;
  }
  
  if (!hasKey && !hasQty && !hasBudget && !hasCat && !hasStockReq && !isControlledOnly) {
    alert("請輸入搜尋條件（關鍵字、分類、起訂量、預算、庫存或勾選篩選）");
    return;
  }

  const _needsQuote = hasQty && hasBudget;
  if (_needsQuote && !state.isQuotesLoaded) { alert("報價資料載入中，請稍候"); return; }

  showLoading();
  updateUserDisplay('searching');

  setTimeout(() => {
    let r = state.productCache;

    if (isControlledOnly) {
        r = r.filter(p => p.isControlled === true);
    }

    if (hasCat) {
        r = r.filter(p => p.category === cat);
    }

    if (hasKey) {
      r = r.filter(p => {
        const pKey = (p.searchKey || "");
        return keys.some(k => pKey.includes(k));
      });
    }

    if (hasStockReq) {
        if (stockReq === 'ZERO') {
            r = r.filter(p => {
                const inv = parseInt(p.inventory || 0, 10);
                return inv <= 0;
            });
        } else {
            const minStock = parseInt(stockReq, 10);
            r = r.filter(p => {
                const inv = parseInt(p.inventory || 0, 10);
                return inv >= minStock;
            });
        }
    }

    if (hasBudget) {
      const min = minPraw ? Number(minPraw) : 0;
      const max = maxPraw ? Number(maxPraw) : Number.MAX_SAFE_INTEGER;
      r = r.filter(p => {
        let price = 0;
        if (qty) {
            const k = `quote${qty}`;
            price = Number(p[k]) || 0;
        } else {
            price = Number(p.marketPrice) || 0;
        }
        return price >= min && price <= max;
      });
    }

    // 排序：有貨在上、缺貨置底
    const activeItems = r.filter(p => (parseInt(p.inventory || 0, 10) > 0));
    const zeroItems   = r.filter(p => (parseInt(p.inventory || 0, 10) <= 0));

    let sortedActive = [];
    let sortedZero = [];

    if (!sortSelect.value) {
        sortedActive = shuffleArray(activeItems);
        sortedZero = shuffleArray(zeroItems);
    } else {
        sortedActive = applySorting(activeItems);
        sortedZero = applySorting(zeroItems);
    }

    state.currentResultList = [...sortedActive, ...sortedZero];
    
    renderResults(state.currentResultList);
    hideLoading();
    updateUserDisplay('normal');
  }, 0);
}
