/**
 * dashboardAuth.js
 * 給 admin 端點（orderDashboard 等）驗證 Firebase Auth ID token + email 白名單
 *
 * 用法：
 *   const { requireAuthorizedEmail } = require('../middlewares/dashboardAuth');
 *   exports.foo = functions.https.onRequest(async (req, res) => {
 *       const user = await requireAuthorizedEmail(req, res);
 *       if (!user) return; // middleware 已 redirect/error
 *       // ...your code...
 *   });
 *
 * 白名單由環境變數 DASHBOARD_ALLOWED_EMAILS 設定（逗號分隔）。
 * 預設 fallback：sam.kuo@kinyo.tw, din@kinyo.tw
 */

const admin = require('firebase-admin');

const LOGIN_URL = 'https://asia-east1-kinyo-price.cloudfunctions.net/dashboardLogin';

function getAllowedEmails() {
    const raw = process.env.DASHBOARD_ALLOWED_EMAILS || 'sam.kuo@kinyo.tw,din@kinyo.tw';
    return new Set(raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
}

function parseCookies(cookieHeader) {
    if (!cookieHeader) return {};
    const out = {};
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
    }
    return out;
}

function getSessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie || '');
    if (cookies.__session) return { type: 'session', value: cookies.__session };
    // Backward-compat: 接受 Authorization Header（給 AJAX 用）跟 idToken cookie
    const authHeader = req.headers.authorization || req.headers.Authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        return { type: 'idToken', value: authHeader.substring(7) };
    }
    if (cookies.idToken) return { type: 'idToken', value: cookies.idToken };
    if (req.query && req.query.idToken) return { type: 'idToken', value: req.query.idToken };
    return null;
}

function buildReturnTo(req) {
    // Cloud Functions Gen 1 會把 function name 從 req.url 切掉（剩 '/' 或 '/?...'），
    // 所以要從 FUNCTION_NAME / K_SERVICE 環境變數補回來。
    const funcName = process.env.FUNCTION_NAME || process.env.K_SERVICE || '';
    const host = req.hostname || 'asia-east1-kinyo-price.cloudfunctions.net';
    const rawUrl = req.originalUrl || req.url || '';
    // 只保留 query 部分（rawUrl 可能是 '/?orderId=X' 或 '/'）
    const qIdx = rawUrl.indexOf('?');
    const queryPart = qIdx >= 0 ? rawUrl.substring(qIdx) : '';
    return `https://${host}/${funcName}${queryPart}`;
}

async function requireAuthorizedEmail(req, res) {
    const session = getSessionFromRequest(req);
    const wantsHtml = (req.headers.accept || '').includes('text/html');

    console.log('[dashboardAuth]', {
        func: process.env.FUNCTION_NAME || process.env.K_SERVICE,
        url: req.originalUrl || req.url,
        cookieKeys: Object.keys(parseCookies(req.headers.cookie || '')),
        hasSession: !!session,
        sessionType: session?.type,
    });

    if (!session) {
        if (wantsHtml) {
            const returnTo = encodeURIComponent(buildReturnTo(req));
            res.redirect(302, `${LOGIN_URL}?returnTo=${returnTo}`);
        } else {
            res.status(401).json({ ok: false, error: 'Unauthorized: 請先登入' });
        }
        return null;
    }

    let decoded;
    try {
        if (session.type === 'session') {
            decoded = await admin.auth().verifySessionCookie(session.value, true);
        } else {
            decoded = await admin.auth().verifyIdToken(session.value);
        }
    } catch (err) {
        console.warn('[dashboardAuth] verify 失敗:', err.message, '(type:', session.type + ')');
        if (wantsHtml) {
            const returnTo = encodeURIComponent(buildReturnTo(req));
            res.redirect(302, `${LOGIN_URL}?returnTo=${returnTo}&reason=expired`);
        } else {
            res.status(401).json({ ok: false, error: 'Token 失效，請重新登入' });
        }
        return null;
    }

    const allowed = getAllowedEmails();
    const email = (decoded.email || '').toLowerCase();
    if (!allowed.has(email)) {
        console.warn(`[dashboardAuth] 拒絕未授權 email: ${email}`);
        const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>無權限</title>
<style>body{font-family:'Noto Sans TC',sans-serif;background:#f5f7fa;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0}
.box{background:#fff;padding:40px;border-radius:12px;box-shadow:0 6px 20px rgba(0,0,0,.06);text-align:center;max-width:420px}
h2{color:#E11D48;margin:0 0 12px}p{color:#666;font-size:14px}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head>
<body><div class="box"><h2>⛔ 無權限存取</h2>
<p>您的帳號 <code>${email}</code> 不在 dashboard 白名單中</p>
<p style="color:#888;font-size:12px">如需存取請聯繫系統管理員加入授權名單</p>
<p><a href="${LOGIN_URL}?logout=1">切換帳號</a></p></div></body></html>`;
        if (wantsHtml) {
            res.status(403).send(html);
        } else {
            res.status(403).json({ ok: false, error: `Email ${email} 未授權` });
        }
        return null;
    }

    return decoded;
}

module.exports = { requireAuthorizedEmail, getAllowedEmails };
