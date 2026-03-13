/* =======================================================
   資料載入模組 (Data Loading)
======================================================= */
import { collection, getDocs, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from './firebase-init.js';
import { state, CACHE_TTL } from './state.js';
import { normalizeKey, getMainModel, showLoading, hideLoading } from './helpers.js';

/* Firestore 重試邏輯 */
export async function getDocsWithRetry(queryRef, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await getDocs(queryRef);
        } catch (err) {
            console.warn(`Attempt ${i + 1} failed. Retrying in ${delay}ms...`, err);
            if (i === retries - 1) throw err;
            await new Promise(res => setTimeout(res, delay));
        }
    }
}

/* Cache 管理 */
export function getCacheKey() {
  const mail = (state.currentUserEmail || "guest").toLowerCase();
  return `KINYO_SAFE_CACHE_V580_${mail}`;
}

export function loadCache() {
  try {
    const raw = localStorage.getItem(getCacheKey());
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.time || !Array.isArray(obj.data)) return null;
    if (Date.now() - obj.time > CACHE_TTL) return null;
    return obj.data;
  } catch { return null; }
}

export function saveCache(data) {
  try {
    localStorage.setItem(getCacheKey(), JSON.stringify({ time: Date.now(), data }));
  } catch {}
}

/* Drive 預載 */
export async function preloadDriveModelData() {
  try {
    const res = await fetch(`./modelData.json?v=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error("modelData.json 讀取失敗");
    const data = await res.json();

    state.driveMap.clear(); state.netMap.clear(); state.netImagesMap.clear(); state.mainFolderMap.clear();

    (data.models || []).forEach(m => {
      const rawKey = String(m.mainModel || m.model || "").trim();
      if (!rawKey) return;
      const key = normalizeKey(rawKey);

      if (m.mainImage) state.driveMap.set(key, m.mainImage);
      if (m.folderUrl) state.mainFolderMap.set(key, m.folderUrl);
      
      const folderUrl = m.netGalleryUrl || m.netFolderUrl || m.folderUrl || m.folderLink || "";
      if (folderUrl) state.netMap.set(key, folderUrl);

      let finalImages = [];
      if (Array.isArray(m.netImages) && m.netImages.length > 0) {
          finalImages = m.netImages.filter(Boolean);
      }
      else if (Array.isArray(m.images) && m.images.length > 0) {
          finalImages = m.images.map(x => x.url).filter(Boolean);
      }
      if (finalImages.length > 0) state.netImagesMap.set(key, finalImages);
    });
    state.isDriveLoaded = true;
  } catch (e) {
    console.warn("Drive 載入失敗", e);
    state.isDriveLoaded = false;
  }
}

/* Drive 資料查詢 */
export function getDriveMainImage(model, mainModel) {
  const k1 = normalizeKey(model);
  const k2 = normalizeKey(mainModel);
  return state.driveMap.get(k1) || state.driveMap.get(k2) || "";
}

export function getDriveMainFolder(model, mainModel){
  const k1 = normalizeKey(model);
  const k2 = normalizeKey(mainModel);
  return state.mainFolderMap.get(k1) || state.mainFolderMap.get(k2) || "";
}

export function getDriveNetGallery(model, mainModel) {
  const k1 = normalizeKey(model);
  const k2 = normalizeKey(mainModel);
  return state.netMap.get(k1) || state.netMap.get(k2) || "";
}

export function getDriveNetImages(model, mainModel){
  const k1 = normalizeKey(model);
  const k2 = normalizeKey(mainModel);
  return state.netImagesMap.get(k1) || state.netImagesMap.get(k2) || [];
}

/* 分類下拉選單更新 */
export function updateCategoryOptions() {
  const categorySelect = document.getElementById("categorySelect");
  const cats = new Set();
  state.productCache.forEach(p => {
    if(p.status !== 'inactive' && p.category) cats.add(p.category.trim());
  });
  
  const sortedCats = Array.from(cats).sort();
  const currentVal = categorySelect.value;
  
  categorySelect.innerHTML = `<option value="">全部分類</option>`;
  sortedCats.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    categorySelect.appendChild(opt);
  });
  
  if(currentVal && sortedCats.includes(currentVal)) {
    categorySelect.value = currentVal;
  }
}

/* 商品預載 */
export async function preloadProducts() {
  showLoading();
  state.isProductsLoaded = false;
  state.isQuotesLoaded = false;

  try {
    const snap = await getDocsWithRetry(collection(db, "Products"));
    const rawList = [];

    snap.forEach(docSnap => {
      const d = docSnap.data() || {};
      const id = docSnap.id;
      
      const model = (d.model || "").trim();
      const mainModel = getMainModel(model);
      
      let colorList = (d.colorList || "").trim();
      if (!colorList) {
        const suffix = model.toUpperCase().replace(mainModel, "").replace("-", "");
        if (suffix && /^[A-Z]{1,3}$/.test(suffix)) colorList = suffix;
      }

      const category = d.category ? String(d.category).trim() : "";
      const netSalesPermission = d.netSalesPermission ? String(d.netSalesPermission).trim() : "";
      
      rawList.push({ id, ...d, model, mainModel, colorList, category, netSalesPermission });
    });

    // Pre-calculation Merge
    const mergedMap = {};
    rawList.forEach(item => {
        if(item.status === 'inactive') return;

        const main = item.mainModel;
        
        const variantObj = {
          model: item.model,
          color: item.colorList || "單一款式",
          inventory: item.inventory,
          eta: item.eta
        };

        if (!mergedMap[main]) {
            mergedMap[main] = { 
                ...item, 
                models: [item.model], 
                variants: [variantObj],
                colorList: item.colorList || "" 
            };
        } else {
            mergedMap[main].models.push(item.model);
            mergedMap[main].variants.push(variantObj);

            const existColors = mergedMap[main].colorList.split(" / ").filter(Boolean);
            const newColors = (item.colorList || "").split(" / ").filter(Boolean);
            mergedMap[main].colorList = [...new Set([...existColors, ...newColors])].join(" / ");
            
            if(item.inventory && parseInt(item.inventory) > parseInt(mergedMap[main].inventory||0)) {
                mergedMap[main].inventory = item.inventory;
            }
        }
    });

    // Convert map back to array & Add Search Key
    state.productCache = Object.values(mergedMap).map(p => {
        return {
            ...p,
            searchKey: `${p.mainModel} ${p.models.join(' ')} ${p.name || ""} ${p.category || ""}`.toLowerCase()
        };
    });

    state.isProductsLoaded = true;
    state.isQuotesLoaded = true;
    updateCategoryOptions(); 

  } catch (e) {
    console.error(e);
    alert("商品資料載入失敗");
  }
  
  hideLoading();
}
