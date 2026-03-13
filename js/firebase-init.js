/* =======================================================
   Firebase 初始化
======================================================= */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import { initializeFirestore } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
const firebaseConfig = {
  apiKey: "AIzaSyDtp6rwV7KmIOedLQ9793BnXbBquopP9kM",
  authDomain: "kinyo-price.firebaseapp.com",
  projectId: "kinyo-price",
  storageBucket: "kinyo-price.firebasestorage.app",
  messagingSenderId: "122464645678",
  appId: "1:122464645678:web:c0febbc6297a8ada5ea5bf",
  measurementId: "G-R0PWMZNSJH"
};

export const app  = initializeApp(firebaseConfig);
export const db   = initializeFirestore(app, { experimentalForceLongPolling: true });
export const auth = getAuth(app);
