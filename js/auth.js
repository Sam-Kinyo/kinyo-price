/* =======================================================
   認證模組 (Auth)
======================================================= */
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged, signOut, signInWithEmailAndPassword, signInWithCustomToken, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { db, auth } from './firebase-init.js';
import { state } from './state.js';
import { setupQtySelectByLevel } from './search.js';
import { updateUserDisplay, searchProducts } from './search.js';
import { preloadDriveModelData, preloadProducts } from './data.js';

/* 權限更新 */
export function updatePermissions() {
    const importProductBtn = document.getElementById("importProductBtn");
    const toggleBtn = document.getElementById("toggleAdvancedL4Btn");
    const advancedGroup = document.getElementById("advancedL4Group");
    const stockFilter = document.getElementById("stockFilter");

    if (state.userLevel >= 4) {
        if(importProductBtn) importProductBtn.style.display = 'inline-block'; 
        if(toggleBtn) toggleBtn.style.display = 'inline-block'; 
    } else {
        if(importProductBtn) importProductBtn.style.display = 'none'; 
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
        if (qtyParam) {
            const qtySelect = document.getElementById("qtySelect");
            // 確保該 option 存在 (權限足夠)
            const optionExists = Array.from(qtySelect.options).some(opt => opt.value === String(qtyParam));
            if (optionExists) {
                qtySelect.value = qtyParam;
            }
        }
        
        // 觸發搜尋
        searchProducts();
        
        // 抹除 URL 參數，避免重整時重複觸發
        // 注意：如果你需要保留 auth_token 測試，可以把這行註解掉，但為了正式營運安全，建議清除。
        window.history.replaceState({}, document.title, window.location.pathname);
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
