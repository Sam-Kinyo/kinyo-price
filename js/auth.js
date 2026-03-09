/* =======================================================
   認證模組 (Auth)
======================================================= */
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged, signOut, signInWithEmailAndPassword, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { db, auth } from './firebase-init.js';
import { state } from './state.js';
import { setupQtySelectByLevel } from './search.js';
import { updateUserDisplay } from './search.js';
import { preloadDriveModelData, preloadProducts } from './data.js';

/* 權限更新 */
export function updatePermissions() {
    const importProductBtn = document.getElementById("importProductBtn");
    const exportHistoryBtn = document.getElementById("exportHistoryBtn");
    const stockFilter = document.getElementById("stockFilter");

    if (state.userLevel >= 4) {
        if(importProductBtn) importProductBtn.style.display = 'inline-block'; 
        if(exportHistoryBtn) exportHistoryBtn.style.display = 'inline-block';
        const btn = document.getElementById("setHotBtn");
        if(btn) btn.style.display = 'inline-block'; 
    } else {
        if(importProductBtn) importProductBtn.style.display = 'none'; 
        if(exportHistoryBtn) exportHistoryBtn.style.display = 'none';
        const btn = document.getElementById("setHotBtn");
        if(btn) btn.style.display = 'none';
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
      if(loginOverlay) loginOverlay.style.display = "flex";
      return;
    }
    
    if(loginOverlay) loginOverlay.style.display = "none";

    state.currentUserEmail = user.email || "";
    state.userLevel = 0; 
    state.currentUserVipConfig = null;
    state.isGroupBuyUser = false;

    try {
        const userDoc = await getDoc(doc(db, "Users", state.currentUserEmail.toLowerCase()));
        if (userDoc.exists()) {
            const userData = userDoc.data();
            state.userLevel = userData.level ?? 0;
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
            state.userLevel = 0;
        }
    } catch (e) {
        console.error("Auth Error:", e);
        state.userLevel = 0;
    }

    if (state.currentUserEmail.toLowerCase() === 'show@kinyo.com') state.userLevel = 0;

    updateUserDisplay('normal');
    logoutBtn.style.display = "inline-block";

    setupQtySelectByLevel();
    updatePermissions();

    await preloadDriveModelData();
    await preloadProducts();
  });
}
