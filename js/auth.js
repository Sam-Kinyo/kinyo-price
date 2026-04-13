/* =======================================================
   認證模組 (Auth)
======================================================= */
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged, signOut, signInWithEmailAndPassword, signInWithCustomToken, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { db, auth } from './firebase-init.js?v=b';
import { state } from './state.js?v=b';
import { setupQtySelectByLevel } from './search.js?v=b';
import { updateUserDisplay, searchProducts } from './search.js?v=b';
import { preloadDriveModelData, preloadProducts } from './data.js?v=b';

/* 權限更新 */
export function updatePermissions() {
    const importProductBtn = document.getElementById("importProductBtn");
    const importDeadStockBtn = document.getElementById("importDeadStockBtn");
    const importWelfareBtn = document.getElementById("importWelfareBtn");
    const toggleBtn = document.getElementById("toggleAdvancedL4Btn");
    const advancedGroup = document.getElementById("advancedL4Group");
    const stockFilter = document.getElementById("stockFilter");

    if (state.userLevel >= 4) {
        if(importProductBtn) importProductBtn.style.display = 'inline-block';
        if(importDeadStockBtn) importDeadStockBtn.style.display = 'inline-block';
        if(importWelfareBtn) importWelfareBtn.style.display = 'inline-block';
        if(toggleBtn) toggleBtn.style.display = 'inline-block';
    } else {
        if(importProductBtn) importProductBtn.style.display = 'none';
        if(importDeadStockBtn) importDeadStockBtn.style.display = 'none';
        if(importWelfareBtn) importWelfareBtn.style.display = 'none';
        if(toggleBtn) toggleBtn.style.display = 'none';
        if(advancedGroup) advancedGroup.style.display = 'none';
    }

    if (state.userLevel >= 2 || state.currentUserVipConfig) {
        if(stockFilter) stockFilter.style.display = 'block'; 
    } else {
        if(stockFilter) stockFilter.style.display = 'none';
    }
}

/* 登入按鈕 */
export function setupLoginButton() {
  const doLoginBtn = document.getElementById("doLoginBtn");
  const loginEmail = document.getElementById("loginEmail");
  const loginPassword = document.getElementById("loginPassword");
  const loginError = document.getElementById("loginError");

  if (!doLoginBtn) return;

  doLoginBtn.onclick = async () => {
    let email = loginEmail.value.trim();
    const password = loginPassword.value.trim();
    
    if (email && !email.includes('@')) {
        email += '@kinyo.com';
    }

    if(!email || !password) {
      loginError.textContent = "請輸入帳號和密碼";
      loginError.style.display = "block";
      return;
    }

    loginError.style.display = "none";
    doLoginBtn.disabled = true;
    doLoginBtn.textContent = "登入中...";

    try {
      await setPersistence(auth, browserLocalPersistence);
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      if (error.message && error.message.includes("message channel closed")) {
          console.warn("Ignored non-fatal auth error:", error);
          doLoginBtn.disabled = false;
          doLoginBtn.textContent = "登入 (請重試)";
          return;
      }
      
      console.error(error);
      loginError.textContent = "登入失敗：請檢查帳號密碼";
      loginError.style.display = "block";
      doLoginBtn.disabled = false;
      doLoginBtn.textContent = "登入";
    }
  };

  // 支援 Enter 鍵直接登入
  const handleEnter = (e) => { if (e.key === 'Enter') doLoginBtn.click(); };
  if (loginEmail) loginEmail.addEventListener('keydown', handleEnter);
  if (loginPassword) loginPassword.addEventListener('keydown', handleEnter);
}

/* 登出按鈕 */
export function setupLogoutButton() {
  const logoutBtn = document.getElementById("logoutBtn");
  if (!logoutBtn) return;

  logoutBtn.onclick = () => {
    if(confirm("確定要登出嗎？")) {
        signOut(auth).then(() => {
            window.location.href = "index.html";
        }).catch((error) => {
            console.error("登出錯誤:", error);
            alert("登出發生錯誤，請重新整理網頁");
        });
    }
  };
}

/* Auth State 監聽 */
export function setupAuthListener() {
  onAuthStateChanged(auth, async (user) => {
    const loginOverlay = document.getElementById("loginOverlay");
    const logoutBtn = document.getElementById("logoutBtn");

    if (!user) {
      state.originalUserLevel = 0;
      state.userLevel = 0;
      if(loginOverlay) loginOverlay.style.display = "flex";
      window.dispatchEvent(new CustomEvent("level-state-changed"));
      return;
    }
    
    if(loginOverlay) loginOverlay.style.display = "none";

    state.currentUserEmail = user.email || "";
    state.userLevel = 0; 
    state.originalUserLevel = 0;
    state.currentUserVipConfig = null;
    state.isGroupBuyUser = false;

    try {
        const userDoc = await getDoc(doc(db, "Users", state.currentUserEmail.toLowerCase()));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            state.originalUserLevel = userData.level ?? 0;
            state.userLevel = state.originalUserLevel;
            if (userData.groupBuy === true) {
                state.isGroupBuyUser = true;
            }
            
            if (userData.vipColumn) {
                state.currentUserVipConfig = {
                    column: userData.vipColumn,
                    name: userData.vipName || 'VIP客戶'
                };
            }
        } else {
            state.originalUserLevel = 0;
            state.userLevel = 0;
        }
    } catch (e) {
        console.error("Auth Error:", e);
        state.originalUserLevel = 0;
        state.userLevel = 0;
    }

    if (state.currentUserEmail.toLowerCase() === 'show@kinyo.com') {
      state.originalUserLevel = 0;
      state.userLevel = 0;
    }

    updateUserDisplay('normal');
    logoutBtn.style.display = "inline-block";

    // Bind Advanced Button Toggle Logic
    const toggleBtn = document.getElementById("toggleAdvancedL4Btn");
    if (toggleBtn) {
        toggleBtn.onclick = () => {
             const group = document.getElementById("advancedL4Group");
             const setHotBtn = document.getElementById("setHotBtn");
             const exportHistoryBtn = document.getElementById("exportHistoryBtn");
             if (group.style.display === "none") {
                 group.style.display = "flex";
                 if (setHotBtn) setHotBtn.style.display = "inline-block";
                 if (exportHistoryBtn) exportHistoryBtn.style.display = "inline-block";
             } else {
                 group.style.display = "none";
             }
        };
    }

    setupQtySelectByLevel();
    updatePermissions();
    window.dispatchEvent(new CustomEvent("level-state-changed"));

    await preloadDriveModelData();
    await preloadProducts();

    // --- 擴充：解析 URL 參數，進行自動填入與搜尋觸發 ---
    // (由於這段寫在 onAuthStateChanged 內，會確保在 auth_token 驗證完畢並重新觸發 Listener 後才執行，保障了權限已經載入完成)
    const urlParams = new URLSearchParams(window.location.search);
    const minParam = urlParams.get('min');
    const maxParam = urlParams.get('max');
    const qtyParam = urlParams.get('qty');
    const hasAutoSearch = minParam !== null || maxParam !== null || qtyParam !== null;

    if (hasAutoSearch) {
        if (minParam) document.getElementById("minPrice").value = minParam;
        if (maxParam) document.getElementById("maxPrice").value = maxParam;
        
        // 為了確保 setupQtySelectByLevel() 生成的 options 已經確實存在並被瀏覽器繪製，改用 setInterval 輪詢
        const checkReadyInterval = setInterval(() => {
            const qtySelect = document.getElementById("qtySelect");
            // 由於動態生成的選項至少包含一個「不使用起訂量」，所以長度大於 1 代表權限資料已載入完成
            if (qtySelect && qtySelect.options.length > 1) {
                clearInterval(checkReadyInterval); // 條件達成，停止輪詢
                
                if (qtyParam) {
                    const targetQty = parseInt(qtyParam, 10);
                    let bestMatchValue = "";
                    
                    // 遍歷下拉選單的所有選項，找出「小於等於」目標數量的最大級距 (例如 700 應該配對到 500)
                    Array.from(qtySelect.options).forEach(option => {
                        const optionValue = parseInt(option.value, 10);
                        // 假設選項值是數字 (50, 100, 300, 500...)
                        if (!isNaN(optionValue) && optionValue <= targetQty) {
                            bestMatchValue = option.value;
                        }
                    });

                    if (bestMatchValue) {
                        qtySelect.value = bestMatchValue;
                        // 強制觸發 change 事件，確保網頁框架捕捉到狀態改變
                        qtySelect.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }
                
                // 觸發搜尋
                searchProducts();
                
                // 抹除 URL 參數，避免重整時重複觸發
                // 注意：如果你需要保留 auth_token 測試，可以把這行註解掉，但為了正式營運安全，建議清除。
                window.history.replaceState({}, document.title, window.location.pathname);
            }
        }, 100); // 每 100 毫秒檢查一次
    }
  });
}

/* =======================================================
   SSO 外部登入攔截 (在腳本載入時優先執行)
======================================================= */
export function interceptSSOLogin() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('auth_token');
    
    if (token && token !== 'TOKEN_GENERATION_FAILED') {
        console.log("偵測到 SSO Token，準備執行登入...");
        // 預防性顯示 Loading
        const loginOverlay = document.getElementById("loginOverlay");
        if(loginOverlay) {
            loginOverlay.style.display = "flex";
            const errSpan = document.getElementById("loginError");
            if(errSpan) {
                 errSpan.style.display = "block";
                 errSpan.style.color = "#3b82f6";
                 errSpan.textContent = "⚙️ 正在驗證外部登入憑證...";
            }
        }
        
        signInWithCustomToken(auth, token)
            .then(() => {
                console.log("SSO 登入成功");
            })
            .catch(err => {
                console.error("SSO 登入失敗", err);
                if(loginOverlay) {
                    const errSpan = document.getElementById("loginError");
                    if(errSpan) {
                         errSpan.style.display = "block";
                         errSpan.style.color = "#ef4444";
                         errSpan.textContent = "登入憑證無效或已過期，請重新索取連結";
                    }
                }
            });
    }
}
