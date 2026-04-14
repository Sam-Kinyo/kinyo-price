/**
 * imageSync.js — 從 kinyo.tw 官網抓商品首圖寫入 ProductImages
 *
 * 策略：Sitemap 比對型號 → 抓商品頁 JSON-LD 圖片
 * 會跳過已有真實圖片的商品（除非 force=true）
 */
const https = require('https');
const cheerio = require('cheerio');
const { admin, db } = require('../utils/firebase');

const KINYO_LOGO_IDS = ['6982eb9c32df84b704bd4a12'];
const SITEMAP_URL = 'https://www.kinyo.tw/sitemap.xml';
const UA = 'Mozilla/5.0 (compatible; KINYO-ImageSync/1.0)';

// ── HTTP helper ──
function fetchText(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': UA }, timeout }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data));
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// ── Sitemap ──
let _sitemapCache = null;
let _sitemapTime = 0;

async function loadSitemap() {
    if (_sitemapCache && Date.now() - _sitemapTime < 3600000) return _sitemapCache;
    const xml = await fetchText(SITEMAP_URL, 20000);
    if (!xml) return _sitemapCache || [];
    const urls = [];
    const re = /<loc>(https:\/\/www\.kinyo\.tw\/products\/[^<]+)<\/loc>/g;
    let m;
    while ((m = re.exec(xml)) !== null) urls.push(m[1]);
    _sitemapCache = urls;
    _sitemapTime = Date.now();
    return urls;
}

// ── Normalize (同前端 normalizeKey) ──
function normalizeKey(model) {
    if (!model) return '';
    let base = model.split('.')[0].split('_')[0].split(' ')[0].toUpperCase();
    if (base.startsWith('WV-')) {
        const m = base.match(/^(WV-[A-Z0-9]+)/);
        return m ? m[1] : base;
    }
    base = base.replace(/-/g, '');
    const m = base.match(/^([A-Z]+)(\d+)([A-Z]*)$/);
    if (m) return m[1] + m[2];
    return base;
}

function isLogo(url) {
    if (!url) return true;
    return KINYO_LOGO_IDS.some(id => url.includes(id));
}

// ── Sitemap 配對 ──
function findProductUrl(model, productUrls) {
    const mc = model.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const mbMatch = mc.match(/^([A-Z]+\d+)/);
    const mb = mbMatch ? mbMatch[1] : mc;

    for (const url of productUrls) {
        const slug = url.split('/products/')[1]?.split('?')[0] || '';
        const sc = slug.replace(/[^a-z0-9]/g, '');
        if (mc.toLowerCase() === sc) return url;
        if (sc.includes(mc.toLowerCase())) return url;
    }
    if (mb !== mc) {
        for (const url of productUrls) {
            const slug = url.split('/products/')[1]?.split('?')[0] || '';
            const sc = slug.replace(/[^a-z0-9]/g, '');
            if (sc.includes(mb.toLowerCase())) return url;
        }
    }
    return null;
}

// ── 從商品頁抓圖（JSON-LD 優先） ──
async function fetchBestImage(url) {
    const html = await fetchText(url);
    if (!html) return null;
    const $ = cheerio.load(html);

    // JSON-LD
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const data = JSON.parse($(el).html() || '{}');
            if (data.image) {
                const imgs = Array.isArray(data.image) ? data.image : [data.image];
                for (const img of imgs) {
                    if (typeof img === 'string' && img.startsWith('http') && !isLogo(img)) {
                        return false; // break each
                    }
                }
            }
        } catch (e) {}
    });

    // 從 JSON-LD 找到的第一張非 logo 圖
    let bestImg = null;
    $('script[type="application/ld+json"]').each((_, el) => {
        if (bestImg) return;
        try {
            const data = JSON.parse($(el).html() || '{}');
            if (data.image) {
                const imgs = Array.isArray(data.image) ? data.image : [data.image];
                for (const img of imgs) {
                    if (typeof img === 'string' && img.startsWith('http') && !isLogo(img)) {
                        bestImg = img;
                        return false;
                    }
                }
            }
        } catch (e) {}
    });
    if (bestImg) return bestImg;

    // og:image fallback
    const og = $('meta[property="og:image"]').attr('content');
    if (og && og.startsWith('http') && !isLogo(og)) return og;

    return null;
}

// ── 讀取 SiteConfig 型號清單 ──
async function getModelsFromSiteConfig() {
    const models = new Set();
    for (const configId of ['deadStockList', 'welfareList']) {
        try {
            const doc = await db.collection('SiteConfig').doc(configId).get();
            if (!doc.exists) continue;
            const items = doc.data().items || [];
            items.forEach(item => {
                const m = typeof item === 'string' ? item : (item.model || item.mainModel || '');
                if (m) models.add(m.trim());
            });
        } catch (e) {}
    }
    return [...models].sort();
}

// ── 主流程 ──
async function syncImages(options = {}) {
    const force = options.force || false;
    const sitemap = await loadSitemap();
    const models = await getModelsFromSiteConfig();

    const results = { updated: 0, created: 0, skipped: 0, notFound: 0, logoSkipped: 0, total: models.length };
    const notFoundList = [];

    for (const model of models) {
        const key = normalizeKey(model);
        if (!key) { results.notFound++; continue; }

        // 檢查是否已有真實圖
        if (!force) {
            try {
                const existing = await db.collection('ProductImages').doc(key).get();
                if (existing.exists) {
                    const d = existing.data();
                    if (d.mainImage && !isLogo(d.mainImage)) {
                        results.skipped++;
                        continue;
                    }
                }
            } catch (e) {}
        }

        // 從 sitemap 找商品 URL
        const productUrl = findProductUrl(model, sitemap);
        if (!productUrl) {
            results.notFound++;
            notFoundList.push(model);
            continue;
        }

        // 抓圖
        const img = await fetchBestImage(productUrl);
        if (!img || isLogo(img)) {
            if (img) results.logoSkipped++;
            else results.notFound++;
            notFoundList.push(model);
            continue;
        }

        // 寫入 ProductImages
        try {
            const docRef = db.collection('ProductImages').doc(key);
            const exists = (await docRef.get()).exists;
            await docRef.set({
                mainModel: key,
                mainImage: img,
                netImages: [img],
                source: 'kinyo.tw',
                sourceUrl: productUrl,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            exists ? results.updated++ : results.created++;
        } catch (e) {
            results.notFound++;
            notFoundList.push(model);
        }
    }

    results.notFoundList = notFoundList;
    return results;
}

module.exports = { syncImages };
