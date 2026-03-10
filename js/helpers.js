/* =======================================================
   工具函式 (Helpers)
======================================================= */
import { state } from './state.js';

/* 即時報價計算（全站唯一模式） */
const QUOTE_DIVISORS = {
  4: { 50: 0.75, 100: 0.78, 300: 0.81, 500: 0.835, 1000: 0.858, 3000: 0.89 },
  3: { 50: 0.75, 100: 0.78, 300: 0.81, 500: 0.835, 1000: 0.858 },
  2: { 50: 0.74, 100: 0.77, 300: 0.80 },
  1: { 50: 0.73, 100: 0.76 },
};

export function getEffectiveLevel(level) {
  const lv = Math.max(Number(level) || 0, 0);
  if (lv >= 4) return 4;
  if (lv >= 3) return 3;
  return lv;
}

export function getVisibleTiers(level) {
  const effectiveLevel = getEffectiveLevel(level);
  if (effectiveLevel >= 4) return [50, 100, 300, 500, 1000, 3000];
  if (effectiveLevel >= 3) return [50, 100, 300, 500, 1000];
  if (effectiveLevel === 2) return [50, 100, 300];
  if (effectiveLevel === 1) return [50, 100];
  return [];
}

export function canViewTier(level, qty) {
  return getVisibleTiers(level).includes(Number(qty));
}

export function calcQuotePrice(cost, qty, level) {
  const c = Number(cost);
  if (!Number.isFinite(c) || c <= 0) return null;
  const q = Number(qty);
  const tierMap = QUOTE_DIVISORS[getEffectiveLevel(level)];
  if (!tierMap) return null;
  const divisor = tierMap[q];
  if (!divisor) return null;
  return Math.ceil((c / divisor) * 1.05);
}

/* 庫存判斷邏輯 */
export function getInventoryStatus(qty) {
  if (qty === null || qty === undefined || qty === "") return null;
  const val = parseInt(qty, 10);
  if (isNaN(val)) return null;

  if (val <= 0)    return { label: "❌ 缺貨中",    cls: "st-zero" };
  if (val < 30)    return { label: "庫存 < 30",    cls: "st-crit" };
  if (val < 100)   return { label: "庫存 < 100",   cls: "st-low" };
  if (val < 200)   return { label: "庫存 < 200",   cls: "st-warn" };
  if (val < 300)   return { label: "庫存 < 300",   cls: "st-warn" };
  if (val < 400)   return { label: "庫存 < 400",   cls: "st-warn" };
  if (val < 700)   return { label: "庫存 < 700",   cls: "st-mid" };
  if (val < 900)   return { label: "庫存 < 900",   cls: "st-good" };
  if (val <= 1200) return { label: "庫存 < 1200",  cls: "st-good" };
  return { label: "庫存 > 1200", cls: "st-high" };
}

export function getInventoryRangeLabel(qty) {
    if (qty === null || qty === undefined || qty === "") return null;
    const val = parseInt(qty, 10);
    if (isNaN(val)) return null;
    if (val > 1000) return "1000個以上";
    if (val <= 100) return "100個以內";
    if (val <= 300) return "300個以內";
    if (val <= 500) return "500個以內";
    if (val <= 1000) return "1000個以內";
    return "1000個以上";
}

/* 庫存能量條 HTML */
export function renderStockByVariant(item) {
    if (state.userLevel < 2 && !state.currentUserVipConfig) return "";
    if (!item.variants || item.variants.length === 0) return "";
    const activeVariants = item.variants.filter(v => v.inventory !== undefined && v.inventory !== null && v.inventory !== "");
    if (activeVariants.length === 0) return "";

    let html = `<div style="display:flex; flex-direction:column; gap:6px; margin-top:6px; border-top:1px dashed #eee; padding-top:6px;">`;

    activeVariants.forEach(v => {
        const status = getInventoryStatus(v.inventory);
        if (status) {
            const qty = parseInt(v.inventory || 0);
            
            let percent = Math.min((qty / 1200) * 100, 100);
            if (qty > 0 && percent < 5) percent = 5;

            let fillClass = "fill-good";
            if (qty <= 0)      fillClass = "st-zero";
            else if (qty < 30) fillClass = "fill-crit";
            else if (qty < 100) fillClass = "fill-low";
            else if (qty < 400) fillClass = "fill-mid";
            else if (qty < 700) fillClass = "fill-good";
            else if (qty <= 1200) fillClass = "fill-high";
            else fillClass = "fill-high";

            let colorLabel = "";
            if (activeVariants.length > 1 || (v.color && v.color !== "單一款式")) {
               colorLabel = `<span style="color:#666; margin-right:4px; font-size:12px;">${v.color}</span>`;
            }

            let displayLabel = status.label;
            let labelStyle = ""; 

            if (state.currentUserVipConfig) {
                if (qty >= 100) displayLabel = "庫存充足";
                else displayLabel = "庫存緊張";
            }

            if (v.eta) {
                if(qty <= 0) {
                    displayLabel = `❌ 缺貨 (${v.eta} 到)`;
                    labelStyle = "color:#991b1b; background:#fee2e2; border-color:#fca5a5; font-weight:bold;";
                } else {
                    displayLabel = `${displayLabel} (${v.eta} 到)`;
                    labelStyle = "color:#9a3412; background:#ffedd5; border-color:#fdba74; font-weight:bold;";
                }
            }

            html += `
            <div style="width:100%;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:1px;">
                    ${colorLabel}
                  <span class="stock-tag ${status.cls}" style="margin-left: auto; font-size:11px; padding:1px 6px; transform:scale(0.9); transform-origin:right center; ${labelStyle}">${displayLabel}</span>
                </div>
                <div class="stock-bar-container">
                    <div class="stock-bar-fill ${fillClass}" style="width: ${percent}%;"></div>
                </div>
            </div>`;
        }
    });

    html += `</div>`;
    return html;
}

/* Google Drive ID 提取 */
export function getGoogleDriveId(url) {
  if (!url) return null;
  const patterns = [
    /\/d\/([a-zA-Z0-9_-]+)/,        
    /id=([a-zA-Z0-9_-]+)/,          
    /open\?id=([a-zA-Z0-9_-]+)/      
  ];
  for (let p of patterns) {
    const m = url.match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

/* 圖片抓取並轉為 DataURL (PPT 用) */
export async function fetchAsDataURL(url) {
  if (!url) return null;
  let targetUrl = url;
  if (url.includes("drive.google.com") || url.includes("googleusercontent.com")) {
    const id = getGoogleDriveId(url);
    if (id) {
       const directLink = `https://drive.google.com/uc?id=${id}`;
       targetUrl = "https://images.weserv.nl/?url=" + encodeURIComponent(directLink) + "&output=jpg&w=400&q=70";
    } else {
       targetUrl = "https://images.weserv.nl/?url=" + encodeURIComponent(url) + "&output=jpg&w=400&q=70";
    }
  } else {
      if(targetUrl.includes("weserv.nl")) {
          if(!targetUrl.includes("&w=")) targetUrl += "&w=400&q=70";
      } else {
          targetUrl = "https://images.weserv.nl/?url=" + encodeURIComponent(url) + "&output=jpg&w=400&q=70";
      }
  }

  try {
    const res = await fetch(targetUrl, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    console.warn("圖片讀取失敗:", url);
    return null;
  }
}

export function pickRandom(arr, count) {
  if (!Array.isArray(arr)) return [];
  const _arr = [...arr];
  for (let i = _arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [_arr[i], _arr[j]] = [_arr[j], _arr[i]];
  }
  return _arr.slice(0, count);
}

/* Loading 控制 */
export function showLoading() {
  const box = document.getElementById("centerLoadingBox");
  const bar = document.getElementById("centerLoadingBar");
  box.style.display = "flex";
  bar.querySelector(".fill").style.width = "0%";
  setTimeout(() => { bar.querySelector(".fill").style.width = "55%"; }, 120);
}

export function hideLoading() {
  const box = document.getElementById("centerLoadingBox");
  const bar = document.getElementById("centerLoadingBar");
  bar.querySelector(".fill").style.width = "100%";
  setTimeout(() => { box.style.display = "none"; }, 0);
}

/* Sheet 控制 */
export function openSheet() {
  const backdrop = document.getElementById("sheetBackdrop");
  const sheet = document.getElementById("mobileDetailSheet");
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
  requestAnimationFrame(() => sheet.classList.add("open"));
}

export function closeSheet() {
  const sheet = document.getElementById("mobileDetailSheet");
  const backdrop = document.getElementById("sheetBackdrop");
  const quoteSheet = document.getElementById("quoteSheet");
  sheet.classList.remove("open");
  setTimeout(() => {
    sheet.classList.add("hidden");
    if (quoteSheet.classList.contains("hidden")) backdrop.classList.add("hidden");
  }, 220);
}

export function openQuoteSheet() {
  const backdrop = document.getElementById("sheetBackdrop");
  const quoteSheet = document.getElementById("quoteSheet");
  backdrop.classList.remove("hidden");
  quoteSheet.classList.remove("hidden");
  requestAnimationFrame(() => quoteSheet.classList.add("open"));
}

export function closeQuoteSheet() {
  const quoteSheet = document.getElementById("quoteSheet");
  const backdrop = document.getElementById("sheetBackdrop");
  const mobileSheet = document.getElementById("mobileDetailSheet");
  quoteSheet.classList.remove("open");
  setTimeout(() => quoteSheet.classList.add("hidden"), 220);
  if (mobileSheet.classList.contains("hidden")) backdrop.classList.add("hidden");
}

/* 智慧主型號判斷 */
export function getMainModel(model) {
  if (!model) return "";
  const raw = String(model).trim().toUpperCase();
  if (!raw) return "";

  if (raw.includes("-")) {
    const parts = raw.split("-");
    const last = parts[parts.length - 1];
    if (/^[A-Z]{1,3}$/.test(last)) {
        return raw.substring(0, raw.lastIndexOf("-"));
    }
  }

  const match = raw.match(/(.*[0-9]+)([A-Z]{1,3})$/);
  if (match) {
      return match[1];
  }

  return raw;
}

export function normalizeKey(key) {
    if (!key) return "";
    let base = key.split('.')[0].split('_')[0].toUpperCase();
    base = base.replace(/-/g, '');
    let m = base.match(/^([a-zA-Z]+)(\d+)([a-zA-Z]*)$/);
    if (m) { return (m[1] + m[2]); }
    return base;
}

export function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* 圖片 URL 包裝工具 */
export function wrapImageUrl(u, size = 150) {
    if(!u) return "https://placehold.co/110x110?text=No+Image";
    if(u.includes("placehold.co")) return u;
    return "https://images.weserv.nl/?url=" + encodeURIComponent(u) + "&output=jpg&w=" + size;
}
