/* =======================================================
   OEM 客戶專屬庫存查詢頁面
======================================================= */
import { collection, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { onAuthStateChanged, signOut, signInWithEmailAndPassword, setPersistence, browserLocalPersistence } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { db, auth } from './firebase-init.js';

const state = {
    products: [],
    filterText: '',
};

function $(id) { return document.getElementById(id); }

function showLogin() {
    $('loginOverlay').style.display = 'flex';
    $('oemMain').style.display = 'none';
}

function hideLogin() {
    $('loginOverlay').style.display = 'none';
    $('oemMain').style.display = 'block';
}

function showError(msg) {
    const el = $('oemError');
    el.textContent = msg;
    el.style.display = 'block';
}

function formatDate(ts) {
    if (!ts || !ts.toDate) return '—';
    const d = ts.toDate();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd}`;
}

function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
}

function renderTable() {
    const tbody = $('oemTableBody');
    const text = state.filterText.trim().toLowerCase();
    const filtered = text
        ? state.products.filter(p =>
            (p.displayModel || p.model || '').toLowerCase().includes(text) ||
            (p.model || '').toLowerCase().includes(text) ||
            (p.name || '').toLowerCase().includes(text))
        : state.products;

    $('oemStats').textContent = text
        ? `${filtered.length} / ${state.products.length} 筆`
        : `共 ${state.products.length} 筆`;

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" class="oem-empty">${text ? '查無符合的產品' : '目前沒有產品資料'}</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(p => {
        const stock = Number(p.stock || 0);
        const stockClass = stock === 0 ? 'zero' : (stock < 50 ? 'low' : '');
        const e = p.extra || {};
        const tooltip = [
            e.mainStock != null ? `成品倉: ${e.mainStock}` : null,
            e.retailStock != null ? `專賣倉: ${e.retailStock}` : null,
            e.reserved != null ? `總預留: ${e.reserved}` : null,
            e.incomingConfirmed ? `確定到貨: ${e.incomingConfirmed}` : null,
            e.incomingPlanned ? `預計到貨: ${e.incomingPlanned}` : null,
        ].filter(Boolean).join(' / ');
        const display = p.displayModel || p.model;
        return `
        <tr>
          <td>${escapeHtml(display)}</td>
          <td>${escapeHtml(p.name || '')}</td>
          <td class="stock ${stockClass}" title="${escapeHtml(tooltip)}">${stock.toLocaleString()}</td>
          <td class="updated">${formatDate(p.updatedAt)}</td>
        </tr>`;
    }).join('');
}

async function loadProducts(email) {
    const q = query(
        collection(db, 'OEMProducts'),
        where('ownerEmail', '==', email),
        where('deleted', '==', false)
    );
    const snap = await getDocs(q);
    const items = [];
    snap.forEach(d => items.push(d.data()));
    items.sort((a, b) => (a.model || '').localeCompare(b.model || ''));
    return items;
}

function setupLoginButton() {
    const btn = $('doLoginBtn');
    const emailInput = $('loginEmail');
    const passwordInput = $('loginPassword');
    const errorEl = $('loginError');
    if (!btn) return;

    btn.onclick = async () => {
        let email = emailInput.value.trim();
        const password = passwordInput.value.trim();
        if (email && !email.includes('@')) email += '@kinyo.com';
        if (!email || !password) {
            errorEl.textContent = '請輸入帳號和密碼';
            errorEl.style.display = 'block';
            return;
        }
        errorEl.style.display = 'none';
        btn.disabled = true;
        btn.textContent = '登入中...';
        try {
            await setPersistence(auth, browserLocalPersistence);
            await signInWithEmailAndPassword(auth, email, password);
        } catch (err) {
            console.error(err);
            errorEl.textContent = '登入失敗：請檢查帳號密碼';
            errorEl.style.display = 'block';
            btn.disabled = false;
            btn.textContent = '登入';
        }
    };

    const handleEnter = e => { if (e.key === 'Enter') btn.click(); };
    emailInput.addEventListener('keydown', handleEnter);
    passwordInput.addEventListener('keydown', handleEnter);
}

function setupLogoutButton() {
    const btn = $('logoutBtn');
    if (!btn) return;
    btn.onclick = () => {
        if (!confirm('確定要登出嗎？')) return;
        signOut(auth).then(() => {
            window.location.reload();
        });
    };
}

function setupSearch() {
    const input = $('oemSearch');
    if (!input) return;
    input.addEventListener('input', () => {
        state.filterText = input.value;
        renderTable();
    });
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        showLogin();
        return;
    }
    const email = (user.email || '').toLowerCase();
    try {
        const userDoc = await getDoc(doc(db, 'Users', email));
        if (!userDoc.exists() || userDoc.data().oemMode !== true) {
            await signOut(auth);
            alert('此帳號非 OEM 客戶，請至查價系統登入。');
            window.location.replace('system.html');
            return;
        }
        const userData = userDoc.data();
        $('oemCustomerName').textContent = userData.oemDisplayName || email;
        hideLogin();
        const products = await loadProducts(email);
        state.products = products;
        renderTable();
    } catch (err) {
        console.error('OEM 載入失敗:', err);
        hideLogin();
        showError('資料載入失敗，請重新整理或聯繫客服。');
    }
});

setupLoginButton();
setupLogoutButton();
setupSearch();
