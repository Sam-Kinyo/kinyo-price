"""
main.py
───────
KINYO B2B 查價系統 — FastAPI 應用程式入口。

啟動流程：
  1. FastAPI lifespan 啟動
  2. 自動從 Firestore 載入全量商品到 In-Memory Cache
  3. 掛載 LINE Webhook + System API 路由
  4. 開始接受請求

部署目標：GCP Cloud Run (PORT 由環境變數注入)
"""

import logging
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from fastapi import FastAPI

from core.config import PORT
from database.firestore_db import load_all_products, ProductCache
from routers import webhook_api, system_api

# ═══════════════════════════════════════════
# Logging 設定
# ═══════════════════════════════════════════
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════
# Application Lifespan (啟動 / 關閉)
# ═══════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """
    FastAPI 推薦的 lifespan context manager。
    伺服器啟動時自動載入商品快取。
    """
    # ── Startup ──
    logger.info("🚀 Server starting — loading product cache...")
    try:
        count: int = await load_all_products()
        logger.info(f"✅ Startup complete: {count} products in cache")
    except Exception as e:
        # 不讓快取載入失敗導致整個服務崩潰
        # 可稍後透過 POST /api/refresh 手動重新載入
        logger.error(f"⚠️ Startup cache load failed: {e}")

    yield  # ── Server is running ──

    # ── Shutdown ──
    logger.info("🛑 Server shutting down")


# ═══════════════════════════════════════════
# FastAPI Application
# ═══════════════════════════════════════════
app = FastAPI(
    title="KINYO B2B 查價系統 API",
    description="LINE Bot 後端 + 商品快取服務，部署於 GCP Cloud Run。",
    version="1.0.0",
    lifespan=lifespan,
)

# 掛載路由
app.include_router(webhook_api.router)
app.include_router(system_api.router)


# ═══════════════════════════════════════════
# Health Check (Cloud Run 用)
# ═══════════════════════════════════════════
@app.get("/health", tags=["System"])
async def health_check() -> dict[str, str | int]:
    """
    Cloud Run 健康檢查端點。
    回傳服務狀態與快取商品數。
    """
    return {
        "status": "healthy",
        "cache_size": ProductCache.count(),
    }


# ═══════════════════════════════════════════
# 本機開發用入口
# ═══════════════════════════════════════════
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=PORT,
        reload=True,
    )
