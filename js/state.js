/* =======================================================
   共用狀態管理 (Central State)
   所有模組透過 import 此檔讀寫共用變數
======================================================= */

export const state = {
  productCache: [],
  currentResultList: [],
  // 當前生效等級（可被 Level4 臨時切換覆蓋）
  userLevel: 0,
  // 登入後從 Firestore 讀到的真實等級（刷新後恢復）
  originalUserLevel: 0,
  currentUserEmail: "",
  currentUserVipConfig: null,  // { column: 'VIP_A', name: '好市多' }
  isGroupBuyUser: false,
  quoteList: [],
  isProductsLoaded: false,
  isQuotesLoaded: false,
  hasCheckedItems: false,

  // Import state
  currentImportMode: "",       // 'inventory' or 'product'
  pendingInventoryMap: new Map(),
  pendingProductData: [],      // Array of { action, data, id? }

  // Drive maps
  driveMap: new Map(),
  mainFolderMap: new Map(),
  netMap: new Map(),
  netImagesMap: new Map(),
  isDriveLoaded: false,
};

// Cache TTL: 6 hours
export const CACHE_TTL = 1000 * 60 * 60 * 6;

// LOGO URL
export const COMPANY_LOGO_URL = "https://drive.google.com/file/d/1JxoU3A5qAYsE39pc2z7IMVwVS8-uTOIn/view?usp=drive_link";
