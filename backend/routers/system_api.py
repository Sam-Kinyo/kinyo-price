"""
routers/system_api.py
─────────────────────
系統管理路由：快取重新載入。
透過 URL Query 參數驗證 Token。
"""

import logging

from fastapi import APIRouter, Query, HTTPException

from core.config import REFRESH_TOKEN
from database.firestore_db import load_all_products, ProductCache

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["System"])


# ═══════════════════════════════════════════
# POST /api/refresh?token=xxx
# ═══════════════════════════════════════════
@router.post("/refresh")
async def refresh_cache(
    token: str = Query(..., description="驗證用 Token"),
) -> dict[str, str | int]:
    """
    手動觸發快取重新載入。

    使用方式：
      POST /api/refresh?token=YOUR_REFRESH_TOKEN

    驗證通過後會重新從 Firestore 全量拉取商品資料。
    可由前端 system.html 匯入完成後自動呼叫，
    或由管理員手動觸發以同步最新資料。
    """
    # 1. Token 驗證
    if not REFRESH_TOKEN:
        logger.error("❌ REFRESH_TOKEN not configured in environment")
        raise HTTPException(
            status_code=500,
            detail="REFRESH_TOKEN not configured on server",
        )

    if token != REFRESH_TOKEN:
        logger.warning("⚠️ Unauthorized refresh attempt")
        raise HTTPException(status_code=403, detail="Invalid token")

    # 2. 重新載入快取
    try:
        count: int = await load_all_products()
        logger.info(f"🔄 Cache refreshed by API call: {count} products")
        return {
            "status": "ok",
            "message": f"Cache refreshed: {count} products loaded",
            "count": count,
        }
    except Exception as e:
        logger.error(f"❌ Cache refresh failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Refresh failed: {str(e)}",
        )


# ═══════════════════════════════════════════
# GET /api/cache-stats (輔助用)
# ═══════════════════════════════════════════
@router.get("/cache-stats")
async def cache_stats() -> dict[str, int]:
    """回傳目前快取中的商品數量 (不需要驗證)。"""
    return {"count": ProductCache.count()}
