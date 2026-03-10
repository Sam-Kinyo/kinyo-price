"""
core/config.py
──────────────
環境變數讀取與 Firebase Admin SDK 初始化。
所有模組共用的設定值統一在此管理。
"""

import os
import logging

from dotenv import load_dotenv
import firebase_admin
from firebase_admin import credentials, firestore

# ─── 載入 .env ───
load_dotenv()

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════
# 1. LINE Bot Configuration
# ═══════════════════════════════════════════
LINE_CHANNEL_SECRET: str = os.getenv("LINE_CHANNEL_SECRET", "")
LINE_CHANNEL_ACCESS_TOKEN: str = os.getenv("LINE_CHANNEL_ACCESS_TOKEN", "")

# ═══════════════════════════════════════════
# 2. System API
# ═══════════════════════════════════════════
REFRESH_TOKEN: str = os.getenv("REFRESH_TOKEN", "")

# ═══════════════════════════════════════════
# 3. Server
# ═══════════════════════════════════════════
PORT: int = int(os.getenv("PORT", "8080"))

# ═══════════════════════════════════════════
# 4. Firebase Admin SDK 初始化
# ═══════════════════════════════════════════

def _init_firebase() -> firestore.Client:
    """
    初始化 Firebase Admin SDK 並回傳 Firestore Client。

    - 本機開發：讀取 GOOGLE_APPLICATION_CREDENTIALS 指向的 JSON。
    - Cloud Run：自動使用 Default Credentials (不需設定環境變數)。
    """
    if not firebase_admin._apps:
        cred_path: str | None = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")

        if cred_path and os.path.isfile(cred_path):
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred)
            logger.info("🔑 Firebase initialized with Service Account JSON")
        else:
            # Cloud Run / GCE 環境：使用 Application Default Credentials
            firebase_admin.initialize_app()
            logger.info("🔑 Firebase initialized with Default Credentials")

    return firestore.client()


# 模組層級 Firestore Client — 全域共用
db: firestore.Client = _init_firebase()
