/* =======================================================
   Firebase 初始化
======================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import { activeCompany, activeCompanyKey } from './company-config.js';

const firebaseConfig = activeCompany.firebase;
console.info(`[Bootstrap] Active company: ${activeCompanyKey}`);

export const app  = initializeApp(firebaseConfig);
export const db   = initializeFirestore(app, { experimentalForceLongPolling: true });
export const auth = getAuth(app);
