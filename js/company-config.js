/* =======================================================
   多公司設定中心 (Company Config)
======================================================= */

const COMPANY_CONFIGS = {
  kinyo: {
    key: "kinyo",
    companyNameZh: "KINYO",
    companyNameEn: "kinyo",
    systemTitle: "KINYO 查價系統",
    systemSubtitleHtml: `
      V7.6 新增到貨時間 --- 運籌帷幄 專屬報價顧問
      <br>
      Designed &amp; Engineered by 郭庭豪 (0976-966-333)
    `,
    ppt: {
      logoUrl: "https://drive.google.com/uc?id=1JxoU3A5qAYsE39pc2z7IMVwVS8-uTOIn",
      salesName: "郭庭豪",
      salesPhone: "0976-966333",
      filePrefix: "KINYO-商品推薦報價"
    },
    firebase: {
      apiKey: "AIzaSyDtp6rwV7KmIOedLQ9793BnXbBquopP9kM",
      authDomain: "kinyo-price.firebaseapp.com",
      projectId: "kinyo-price",
      storageBucket: "kinyo-price.firebasestorage.app",
      messagingSenderId: "122464645678",
      appId: "1:122464645678:web:c0febbc6297a8ada5ea5bf",
      measurementId: "G-R0PWMZNSJH"
    }
  },
  lingdong: {
    key: "lingdong",
    companyNameZh: "靈動數碼",
    companyNameEn: "lingdong",
    systemTitle: "靈動數碼 查價系統",
    systemSubtitleHtml: `
      B2B 採購報價平台
      <br>
      Powered by lingdong
    `,
    ppt: {
      // TODO: 可替換成靈動數碼專屬 logo
      logoUrl: "https://drive.google.com/uc?id=1JxoU3A5qAYsE39pc2z7IMVwVS8-uTOIn",
      salesName: "靈動數碼",
      salesPhone: "",
      filePrefix: "Lingdong-商品推薦報價"
    },
    // TODO: 請替換成靈動數碼自己的 Firebase 專案設定
    // 目前先沿用 kinyo，方便你先本機測流程
    firebase: {}
  }
};

function normalizeCompanyKey(rawKey) {
  return String(rawKey || "").trim().toLowerCase();
}

function detectCompanyKey() {
  const fromWindow = normalizeCompanyKey(window.__APP_COMPANY__);
  if (fromWindow && COMPANY_CONFIGS[fromWindow]) return fromWindow;

  const fromQuery = normalizeCompanyKey(new URLSearchParams(window.location.search).get("company"));
  if (fromQuery && COMPANY_CONFIGS[fromQuery]) return fromQuery;

  return "kinyo";
}

const currentCompanyKey = detectCompanyKey();
const currentCompanyConfig = COMPANY_CONFIGS[currentCompanyKey] || COMPANY_CONFIGS.kinyo;
const baseCompanyConfig = COMPANY_CONFIGS.kinyo;

export const activeCompanyKey = currentCompanyKey;
export const activeCompany = {
  ...baseCompanyConfig,
  ...currentCompanyConfig,
  firebase: {
    ...baseCompanyConfig.firebase,
    ...(currentCompanyConfig.firebase || {})
  },
  ppt: {
    ...baseCompanyConfig.ppt,
    ...(currentCompanyConfig.ppt || {})
  }
};

export function applySystemBranding() {
  document.title = activeCompany.systemTitle;

  const loginTitle = document.getElementById("loginSystemTitle");
  if (loginTitle) loginTitle.textContent = activeCompany.systemTitle;

  const pageTitle = document.getElementById("pageSystemTitle");
  if (pageTitle) pageTitle.textContent = activeCompany.systemTitle;

  const subtitle = document.getElementById("pageSubtitle");
  if (subtitle) subtitle.innerHTML = activeCompany.systemSubtitleHtml;
}
