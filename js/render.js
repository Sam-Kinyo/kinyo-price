/* =======================================================
   渲染模組 (Render)
======================================================= */
import { state } from './state.js';
import { renderStockByVariant, openSheet, wrapImageUrl, calcQuotePrice } from './helpers.js';
import { getDriveMainImage, getDriveMainFolder, getDriveNetGallery, getDriveNetImages } from './data.js';
import { logCheckboxInterest } from './quote.js';

/* 勾選狀態管理 */
export function updateMultiLineBtnState() { 
  const checked = document.querySelectorAll(".row-check:checked");
  state.hasCheckedItems = checked.length > 0;
  
  const multiLineBtn = document.getElementById("multiLineBtn");
  const exportBtn = document.getElementById("exportBtn");
  const pptToolbarBtn = document.getElementById("pptToolbarBtn");
  const batchAddQuoteBtn = document.getElementById("batchAddQuoteBtn");
  
  if(multiLineBtn) multiLineBtn.disabled = !state.hasCheckedItems;
  if(exportBtn) exportBtn.disabled = !state.hasCheckedItems; 
  if(pptToolbarBtn) pptToolbarBtn.disabled = !state.hasCheckedItems; 
  if(batchAddQuoteBtn) batchAddQuoteBtn.disabled = !state.hasCheckedItems;
  const setHotBtn = document.getElementById("setHotBtn");
  if(setHotBtn && state.userLevel >= 4) setHotBtn.disabled = !state.hasCheckedItems;
  
  updateToolbarScrollState();
}

export function updateToolbarScrollState() {
  const toolbar = document.querySelector('.toolbar');
  const spacer = document.getElementById('toolbarSpacer');
  const searchForm = document.getElementById('searchForm');

  if (!state.hasCheckedItems) {
    toolbar.classList.remove('fixed-active');
    if(spacer) spacer.style.display = 'none';
    return;
  }
  const triggerPoint = searchForm.offsetTop + searchForm.offsetHeight;
  if (window.scrollY > triggerPoint) {
    if (!toolbar.classList.contains('fixed-active')) {
      toolbar.classList.add('fixed-active');
      if(spacer) spacer.style.display = 'block';
    }
  } else {
    if (toolbar.classList.contains('fixed-active')) {
      toolbar.classList.remove('fixed-active');
      if(spacer) spacer.style.display = 'none';
    }
  }
}

export function bindCheckAll() {
  const checkAllBox = document.getElementById("checkAll");
  const rowChecks = document.querySelectorAll(".row-check");
  checkAllBox.onchange = () => { rowChecks.forEach(c => c.checked = checkAllBox.checked); updateMultiLineBtnState(); };
  rowChecks.forEach(chk => { chk.onchange = () => { const all = document.querySelectorAll(".row-check"); const checked = document.querySelectorAll(".row-check:checked"); checkAllBox.checked = (all.length === checked.length); updateMultiLineBtnState(); }; });
}

/* 表格渲染 */
export function renderResults(list) {
  const resultBody = document.getElementById("resultBody");
  const resultTable = document.getElementById("resultTable");
  const detailCard = document.getElementById("detailCard");
  const checkAllBox = document.getElementById("checkAll");
  const exportBtn = document.getElementById("exportBtn");
  const pptToolbarBtn = document.getElementById("pptToolbarBtn");

  resultBody.innerHTML = ""; detailCard.style.display = "none"; checkAllBox.checked = false; updateMultiLineBtnState();
  if (list.length === 0) {
    resultTable.style.display = "none"; exportBtn.disabled = true; pptToolbarBtn.disabled = true; return;
  }
  resultTable.style.display = "table"; exportBtn.disabled = false; pptToolbarBtn.disabled = false;

  list.forEach(item => {
    const netImages = getDriveNetImages(item.model, item.mainModel) || [];
    const driveMainImg = getDriveMainImage(item.model, item.mainModel);
    
    let rawBackup = null;
    if (driveMainImg) rawBackup = driveMainImg;
    else if (netImages.length > 0) rawBackup = netImages[0];

    let backupImg = wrapImageUrl(rawBackup, 150);

    let img = item.imageUrl; 
    if (!img || !img.startsWith("http")) {
        img = backupImg;
    }
    
    let controlledHtml = "";
    if (item.isControlled) {
        controlledHtml = `<span style="background:#eff6ff; color:#1e40af; border:1px solid #bfdbfe; padding:2px 6px; border-radius:50px;; font-size:12px; font-weight:bold; margin-right:4px;">🛡️ 控價品</span>`;
    }
      
    const tr = document.createElement("tr");
    let priceHtml = ""; 
    const getQuoteByTier = (tier) => {
      const v = calcQuotePrice(item.cost, tier, state.userLevel);
      return v !== null ? v : "-";
    };

    // 價格邏輯
    if (state.isGroupBuyUser) {
        let htmlStack = [];
        const gbPrice = item.groupBuyPrice; 
        if (gbPrice) {
            htmlStack.push(`<div style="margin-bottom:4px;"><span style="display:inline-block; background:#fee2e2; color:#b91c1c; border:1px solid #f87171; padding:3px 8px; border-radius:6px; font-weight:bold; font-size:15px;">🔴 直播團購價：$${gbPrice}</span></div>`);
        } else {
            htmlStack.push(`<div style="margin-bottom:4px;"><span style="color:#9ca3af; font-size:13px;">(本檔未開放團購)</span></div>`);
        }
        const costCol = (state.currentUserVipConfig && state.currentUserVipConfig.column) ? state.currentUserVipConfig.column : 'VIP_C';
        const myCost = item[costCol]; 
        if (myCost) {
            htmlStack.push(`<div><span style="display:inline-block; background:#ecfdf5; color:#047857; border:1px solid #6ee7b7; padding:2px 6px; border-radius:4px; font-weight:bold; font-size:13px;">💰 您的進價：$${myCost}</span></div>`);
        } else {
             htmlStack.push(`<div><span style="color:#999; font-size:12px;">(無專屬進價)</span></div>`);
        }
        priceHtml = htmlStack.join("");
    } else if (state.currentUserVipConfig) {
        const vipPriceVal = item[state.currentUserVipConfig.column];
        if (vipPriceVal) {
            priceHtml = `<span style="font-weight:bold; color:#b91c1c; font-size:14px; background:#fce7f3; padding:4px 8px; border-radius:6px;">${state.currentUserVipConfig.name} 專屬價：$${vipPriceVal}</span>`;
        } else {
            priceHtml = `<span style="font-weight:bold; color:#2563eb; font-size:14px;">請洽郭庭豪</span>`;
        }
    } else {
        if (state.userLevel >= 1) priceHtml += `<span class="price-tag tag50">50個：${getQuoteByTier(50)}</span>`;
        if (state.userLevel >= 1) {
            priceHtml += `<span class="price-tag tag100">100個：${getQuoteByTier(100)}</span>`;
        }
        if (state.userLevel >= 2) {
            priceHtml += `<span class="price-tag tag300">300個：${getQuoteByTier(300)}</span>`;
        }
        if (state.userLevel >= 3) {
            priceHtml += `<span class="price-tag tag500">500個：${getQuoteByTier(500)}</span>`;
            priceHtml += `<span class="price-tag tag1000">1000個：${getQuoteByTier(1000)}</span>`;
        }
        if (state.userLevel >= 4) {
            priceHtml += `<span class="price-tag" style="background:#f3e8ff;color:#6b21a8;">3000個：${getQuoteByTier(3000)}</span>`;
        }
    }

    const showMinPrice = state.userLevel >= 1;
    let minPriceDisplay = "";
    let marketPriceDisplay = item.marketPrice ?? "-";

    if (state.currentUserVipConfig) {
        const vipPriceVal = item[state.currentUserVipConfig.column];
        if (vipPriceVal) {
            minPriceDisplay = "";
            marketPriceDisplay = "";
        } else {
            minPriceDisplay = item.minPrice ?? "-";
            marketPriceDisplay = item.marketPrice ?? "-";
        }
    } else if (state.isGroupBuyUser) {
        minPriceDisplay = "-"; 
        marketPriceDisplay = item.marketPrice ?? "-";
    } else {
        minPriceDisplay = showMinPrice ? (item.minPrice ?? "-") : "---";
        marketPriceDisplay = item.marketPrice ?? "-";
    }
    const catBadge = item.category ? `<span class="category-badge">${item.category}</span>` : "";
    const variantStockHtml = renderStockByVariant(item);

    tr.innerHTML = `
       <td>
        <input type="checkbox" class="row-check" data-model="${item.model}">
      </td>
      
      <td style="text-align:center; vertical-align: top;">
        <div class="model-cell" style="font-weight:700; font-size:14px; margin-bottom:6px; color:#334155; cursor:pointer;" onclick="event.stopPropagation();">${item.mainModel || "-"}</div>
        <img src="${img}" class="product-img" 
             loading="lazy"
             onerror="this.onerror=null; this.src='${backupImg}';">
      </td>

      <td>
        ${controlledHtml} ${catBadge} 
        <div style="font-weight:700; margin-bottom:4px; font-size:15px; line-height:1.4;">${item.name || "-"}</div>
        <div style="font-size:13px; color:#64748b; margin-bottom:6px;">
           ${item.colorList ? `顏色：${item.colorList}` : ''}
        </div>
        ${variantStockHtml}
        
        <div class="price-tag-container" style="font-size:13px; margin-bottom:8px; margin-top:8px;">${priceHtml}</div>
        
        ${state.currentUserVipConfig ? '' : `
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="line-share-btn btn-secondary" data-model="${item.model}" style="padding:4px 12px; font-size:12px; border-radius:6px;">LINE</button>
          <button class="btn-outline-add add-quote-btn" data-model="${item.model}">➕ 報價</button>
        </div>
        `}
      </td>

      <td style="text-align:right; vertical-align: top;">
        <div style="font-weight:700; color:#ef4444; font-size:16px; margin-bottom:4px;">${minPriceDisplay}</div>
        <div style="color:#94a3b8; font-size:12px; text-decoration:line-through;">${marketPriceDisplay}</div>
      </td>
    `;

    // 勾選事件：記錄關注行為
    const checkbox = tr.querySelector('.row-check');
    if (checkbox) {
      checkbox.addEventListener('change', function() {
        if (this.checked) {
          logCheckboxInterest({ model: item.model, name: item.name });
        }
      });
    }

    // Events
    const imgEl = tr.querySelector('.product-img');
    const modelEl = tr.querySelector('.model-cell');
    const openDetail = () => {
      if (window.innerWidth > 900) {
        if (window.hideDetailTimer) clearTimeout(window.hideDetailTimer);
        showDetailDesktop(item);
      } else {
        showDetailMobile(item);
      }
    };
    if (imgEl) {
      imgEl.addEventListener('click', openDetail);
      if (window.innerWidth > 900) {
          imgEl.addEventListener('mouseenter', openDetail);
          imgEl.addEventListener('mouseleave', () => {
              window.hideDetailTimer = setTimeout(() => { detailCard.style.display = "none"; }, 1000); 
          });
      }
    }
    if (modelEl) {
      modelEl.addEventListener('click', openDetail);
       if (window.innerWidth > 900) {
          modelEl.addEventListener('mouseenter', openDetail);
          modelEl.addEventListener('mouseleave', () => {
              window.hideDetailTimer = setTimeout(() => { detailCard.style.display = "none"; }, 1000); 
          });
      }
    }
    resultBody.appendChild(tr);
  });
  bindCheckAll();
}

/* 手機版 Detail */
export function showDetailMobile(item) {
  const driveMainFolder = getDriveMainFolder(item.model, item.mainModel);
  const netImages = getDriveNetImages(item.model, item.mainModel) || [];
  const netFolderUrl = getDriveNetGallery(item.model, item.mainModel);
  const actMainLink = driveMainFolder || getDriveMainImage(item.model, item.mainModel);
  const actNetLink = netFolderUrl || (netImages && netImages.length > 0 ? netImages[0] : "");

  const driveMainImg = getDriveMainImage(item.model, item.mainModel);

  let rawBackup = null;
  if (driveMainImg) rawBackup = driveMainImg;
  else if (netImages.length > 0) rawBackup = netImages[0];
  let backupImg = wrapImageUrl(rawBackup, 400);

  let img = item.imageUrl;
  if (!img || !img.startsWith("http")) {
      img = backupImg;
  }

  const getPrice = (p) => (item[p] ?? "-");
  const getQuoteByTier = (tier) => {
      const v = calcQuotePrice(item.cost, tier, state.userLevel);
      return v !== null ? v : "-";
  };
  const showMinPrice = state.userLevel >= 1;

  let quoteHtml = "";
  if (!state.currentUserVipConfig) {
      const tiers = [50, 100, 300, 500, 1000, 3000];
      tiers.forEach(t => {
          let isVisible = false;
          if (state.userLevel >= 1 && (t === 50 || t === 100)) isVisible = true;
          if (state.userLevel >= 2 && t === 300) isVisible = true;
          if (state.userLevel >= 3 && (t === 500 || t === 1000)) isVisible = true;
          if (state.userLevel >= 4 && t === 3000) isVisible = true;
          if (isVisible) {
              quoteHtml += `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dashed #eee;">
                  <span style="color:#666;">${t}個</span>
                  <span style="font-weight:bold; color:#2563eb;">${getQuoteByTier(t)}</span>
              </div>`;
          }
      });
  }

  let netThumbHtml = "";
  if (netImages && netImages.length > 0) {
      const imgsHtml = netImages.slice(0, 6).map(url => { 
          const displayUrl = "https://images.weserv.nl/?url=" + encodeURIComponent(url) + "&w=100&h=100&fit=cover";
          return `<img src="${displayUrl}" loading="lazy" style="width:100%; aspect-ratio:1; object-fit:cover; border-radius:4px; border:1px solid #eee;" onclick="window.open('${url}', '_blank')">`;
      }).join("");
      netThumbHtml = `<div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; margin-top:12px;">${imgsHtml}</div>`;
  }
   
  let stockHtml = "";
  const variantStock = renderStockByVariant(item);
  if(variantStock) {
        stockHtml = `<div style="margin-bottom:16px; background:#f9fafb; padding:10px; border-radius:8px; border:1px solid #e5e7eb;">
          <div style="font-weight:bold; font-size:14px; margin-bottom:6px; color:#374151;">庫存現況</div>
          ${variantStock}
        </div>`;
  }

  let priceBlockHtml = "";
  if (state.currentUserVipConfig) {
      const vipPriceVal = item[state.currentUserVipConfig.column];
      let displayPrice = "";
      let label = "";
      if (vipPriceVal) {
          label = `${state.currentUserVipConfig.name} 專屬價`;
          displayPrice = `<span style="font-weight:bold; color:#b91c1c; font-size:18px;">$${vipPriceVal}</span>`;
      } else {
          label = "專屬報價";
          displayPrice = `<span style="font-weight:bold; color:#2563eb;">請洽郭庭豪</span>`;
      }
      
      priceBlockHtml = `
        <div style="background:#f9fafb; padding:12px; border-radius:8px; margin-bottom:16px;">
            <div style="font-weight:700; margin-bottom:8px;">價格資訊</div>
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
              <span>${label}</span>
              ${displayPrice}
            </div>
            ${!vipPriceVal ? `
            <div style="border-top:1px solid #eee; padding-top:8px; margin-top:8px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:4px; color:#666; font-size:13px;">
                  <span>賣場參考</span>
                  <span>${getPrice('marketPrice')}</span>
                </div>
                <div style="display:flex; justify-content:space-between; color:#666; font-size:13px;">
                  <span>末售參考</span>
                  <span>${getPrice('minPrice')}</span>
                </div>
            </div>
            ` : ''}
        </div>`;
  } else {
      priceBlockHtml = `
        <div style="background:#f9fafb; padding:12px; border-radius:8px; margin-bottom:16px;">
            <div style="font-weight:700; margin-bottom:8px;">價格資訊</div>
            <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
              <span>賣場售價</span>
              <span style="font-weight:bold;">${getPrice('marketPrice')}</span>
            </div>
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
              <span>末售價格</span>
              <span style="font-weight:bold; color:#dc2626;">${showMinPrice ? getPrice('minPrice') : '---'}</span>
            </div>
            ${quoteHtml ? `<div style="background:#fff; padding:8px; border-radius:6px; margin-top:8px; border:1px solid #eee;">${quoteHtml}</div>` : ''}
        </div>`;
  }

  const sheetContent = document.getElementById("sheetContent");
  sheetContent.innerHTML = `
    <div style="text-align:center; margin-bottom:16px; background:#fafafa; padding:10px; border-radius:8px;">
      <img src="${img}" style="max-height:250px; max-width:100%; object-fit:contain; border-radius:4px;" 
           onerror="this.onerror=null;this.src='${backupImg}';">
    </div>
    
    <div style="font-weight:700; font-size:18px; margin-bottom:8px;">${item.name || "-"}</div>
    
    <div style="display:flex; gap:8px; margin-bottom:12px; flex-wrap:wrap;">
        ${item.category ? `<span style="background:#f3f4f6; color:#4b5563; padding:4px 8px; border-radius:4px; font-size:12px;">分類：${item.category}</span>` : ""}
        ${item.netSalesPermission ? `<span style="background:#e0e7ff; color:#3730a3; padding:4px 8px; border-radius:4px; font-size:12px;">權限：${item.netSalesPermission}</span>` : ""}
    </div>

    ${stockHtml}

    <div style="color:#666; font-size:14px; margin-bottom:16px;">
       <div>型號：${item.model}</div>
       <div>主型號：${item.mainModel}</div>
       <div>顏色：${item.colorList || "-"}</div>
       <div>箱入數：${item.cartonQty || "-"}</div>
       <div>國際條碼：${item.barcode || item.internationalBarcode || "-"}</div>
    </div>

    ${priceBlockHtml}

    <div style="display:flex; gap:10px; flex-wrap:wrap; margin-bottom:16px;">
        ${actMainLink ? `<a href="${actMainLink}" target="_blank" class="btn-secondary" style="flex:1; text-align:center;">下載大圖</a>` : ''}
        ${actNetLink ? `<a href="${actNetLink}" target="_blank" class="btn-secondary" style="flex:1; text-align:center;">下載網路圖</a>` : ''}
    </div>

    ${netThumbHtml}

    <div style="height:20px;"></div>
    ${state.currentUserVipConfig ? '' : `
    <div style="display:flex; gap:10px;">
       <button class="btn-primary line-share-btn" data-model="${item.model}" style="flex:1;">LINE 分享</button>
       <button class="btn-outline-add add-quote-btn" data-model="${item.model}" style="flex:1;">加入報價單</button>
    </div>
    `}
    <div style="height:30px;"></div>
  `;

  openSheet();
}

/* 電腦版 Detail Card */
export function showDetailDesktop(item) {
  const detailCard = document.getElementById("detailCard");
  if (window.hideDetailTimer) clearTimeout(window.hideDetailTimer);

  const driveMainFolder = getDriveMainFolder(item.model, item.mainModel);
  const netImages = getDriveNetImages(item.model, item.mainModel) || []; 
  const netFolderUrl = getDriveNetGallery(item.model, item.mainModel);
  const actMainLink = driveMainFolder || getDriveMainImage(item.model, item.mainModel);
  const actNetLink = netFolderUrl || (netImages && netImages.length > 0 ? netImages[0] : "");

  const driveMainImg = getDriveMainImage(item.model, item.mainModel);
  
  let rawBackup = null;
  if (driveMainImg) rawBackup = driveMainImg;
  else if (netImages.length > 0) rawBackup = netImages[0];
  let backupImg = wrapImageUrl(rawBackup, 400);

  let img = item.imageUrl;
  if (!img || !img.startsWith("http")) {
      img = backupImg;
  }

  let netThumbHtml = "";
  if (netImages && netImages.length > 0) {
      const imgsHtml = netImages.slice(0, 6).map(url => { 
          const displayUrl = "https://images.weserv.nl/?url=" + encodeURIComponent(url) + "&w=100&h=100&fit=cover";
          return `<img src="${displayUrl}" loading="lazy" style="cursor:pointer; width:100%; height:60px; object-fit:cover; border-radius:4px; border:1px solid #eee;" onclick="window.open('${url}', '_blank')">`;
      }).join("");
      netThumbHtml = `<div class="net-gallery" style="grid-template-columns:repeat(6, 1fr); gap:4px; margin-top:8px;">${imgsHtml}</div>`;
  }

  const getPrice = (p) => (item[p] ?? "-");
  const getQuoteByTier = (tier) => {
      const v = calcQuotePrice(item.cost, tier, state.userLevel);
      return v !== null ? v : "-";
  };
  const showMinPrice = state.userLevel >= 1;

  let quoteHtml = "";
  if (!state.currentUserVipConfig) {
      const tiers = [50, 100, 300, 500, 1000, 3000];
      tiers.forEach(t => {
          let isVisible = false;
          if (state.userLevel >= 1 && (t === 50 || t === 100)) isVisible = true;
          if (state.userLevel >= 2 && t === 300) isVisible = true;
          if (state.userLevel >= 3 && (t === 500 || t === 1000)) isVisible = true;
          if (state.userLevel >= 4 && t === 3000) isVisible = true;
          if (isVisible) {
              quoteHtml += `<div style="display:flex; justify-content:space-between; padding:2px 0; border-bottom:1px dashed #eee;">
                  <span style="color:#666;">${t}個</span>
                  <span style="font-weight:bold; color:#2563eb;">${getQuoteByTier(t)}</span>
              </div>`;
          }
      });
  }
   
  let stockHtml = "";
  const variantStock = renderStockByVariant(item);
  if(variantStock) {
        stockHtml = `<div style="margin-bottom:12px; background:#f9fafb; padding:8px; border-radius:6px; border:1px solid #e5e7eb;">
          <div style="font-size:12px; color:#888; margin-bottom:4px; font-weight:600;">庫存現況</div>
          ${variantStock}
        </div>`;
  }

  let priceBlockHtml = "";
  if (state.currentUserVipConfig) {
      const vipPriceVal = item[state.currentUserVipConfig.column];
      let displayPrice = "";
      let label = "";
      if (vipPriceVal) {
          label = `${state.currentUserVipConfig.name} 專屬價`;
          displayPrice = `<span style="font-weight:bold; color:#b91c1c;">$${vipPriceVal}</span>`;
      } else {
          label = "專屬報價";
          displayPrice = `<span style="font-weight:bold; color:#2563eb;">請洽郭庭豪</span>`;
      }
      
      priceBlockHtml = `
        <div style="background:#fff; border:1px solid #eee; border-radius:8px; padding:12px;">
            <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
              <span>${label}</span>
              ${displayPrice}
            </div>
            ${!vipPriceVal ? `
            <div style="border-top:1px solid #eee; padding-top:8px; margin-top:8px;">
                <div style="display:flex; justify-content:space-between; margin-bottom:4px; color:#666; font-size:12px;">
                  <span>賣場參考</span>
                  <span>${getPrice('marketPrice')}</span>
                </div>
                <div style="display:flex; justify-content:space-between; color:#666; font-size:12px;">
                  <span>末售參考</span>
                  <span>${getPrice('minPrice')}</span>
                </div>
            </div>
            ` : ''}
        </div>`;
  } else {
      priceBlockHtml = `
        <div style="background:#fff; border:1px solid #eee; border-radius:8px; padding:12px;">
         <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
            <span>賣場售價</span>
            <span style="font-weight:bold;">${getPrice('marketPrice')}</span>
         </div>
         <div style="display:flex; justify-content:space-between; margin-bottom:12px;">
            <span>末售價格</span>
            <span style="font-weight:bold; color:#dc2626;">${showMinPrice ? getPrice('minPrice') : '---'}</span>
         </div>
         <div style="background:#f0f9ff; padding:8px 12px; border-radius:6px;">
            <div style="font-size:12px; color:#666; margin-bottom:4px; font-weight:600;">採購報價</div>
            ${quoteHtml || '<div style="color:#999; font-size:12px;">無權限查看報價</div>'}
         </div>
       </div>`;
  }
  
  detailCard.style.display = "block";
  detailCard.innerHTML = `
    <button class="card-close-btn" onclick="document.getElementById('detailCard').style.display='none'">×</button>
    
    <img src="${img}" style="width:100%; border-radius:10px; border:1px solid #eee; margin-bottom:12px; object-fit:contain; max-height:300px; background:#fafafa;" 
         onerror="this.onerror=null;this.src='${backupImg}';">

    <div style="margin-bottom:16px;">
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        ${actMainLink ? `<a href="${actMainLink}" target="_blank" class="btn-secondary" style="flex:1; text-align:center; font-size:13px; padding:8px;">下載大圖</a>` : `<button disabled class="btn-secondary" style="flex:1; color:#ccc;">無大圖</button>`}
        ${actNetLink ? `<a href="${actNetLink}" target="_blank" class="btn-secondary" style="flex:1; text-align:center; font-size:13px; padding:8px;">下載網路圖</a>` : `<button disabled class="btn-secondary" style="flex:1; color:#ccc;">無網路圖</button>`}
      </div>
      ${netThumbHtml}
    </div>

    <div style="margin-bottom:16px; background:#f9fafb; padding:12px; border-radius:8px;">
      <div style="font-weight:700; font-size:16px; margin-bottom:8px; color:#111;">${item.name || "-"}</div>
      
      <div style="margin-bottom:8px; font-size:13px; color:#555;">
        ${item.category ? `<span style="background:#e5e7eb; padding:2px 6px; border-radius:4px; margin-right:6px;">分類: ${item.category}</span>` : ""}
        ${item.netSalesPermission ? `<span style="background:#dbeafe; padding:2px 6px; border-radius:4px; color:#1e40af;">網路權限: ${item.netSalesPermission}</span>` : ""}
      </div>
      
      ${stockHtml}

      <div style="font-size:14px; line-height:1.8; color:#444;">
        <div><span style="color:#888;">顏色：</span> ${item.colorList || "-"}</div>
        <div><span style="color:#888;">箱入數：</span> ${item.cartonQty || "-"}</div>
        <div><span style="color:#888;">國際條碼：</span> ${item.barcode || item.internationalBarcode || "-"}</div>
        <div><span style="color:#888;">連結：</span> ${item.productUrl ? `<a href="${item.productUrl}" target="_blank" style="color:#2563eb;text-decoration:underline;">開啟網頁</a>` : "-"}</div>
      </div>
    </div>

    <div style="margin-bottom:12px;">
      <div style="font-weight:700; margin-bottom:8px; border-left:4px solid #2563eb; padding-left:8px;">價格資訊</div>
      ${priceBlockHtml}
    </div>

    ${state.currentUserVipConfig ? '' : `
    <div style="display:flex; gap:8px; margin-top:16px;">
      <button class="btn-primary line-share-btn" data-model="${item.model}" style="flex:1;">LINE 分享</button>
      <button class="btn-outline-add add-quote-btn" data-model="${item.model}" style="flex:1;">加入報價單</button>
    </div>
    `}
  `;
}
