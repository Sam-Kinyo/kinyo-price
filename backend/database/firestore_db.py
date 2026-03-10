"""
database/firestore_db.py
────────────────────────
ProductCache 快取類別與 Firestore 全量讀取邏輯。

設計原則：
  - 伺服器啟動時透過 lifespan 呼叫 load_all_products() 一次。
  - 後續可透過 POST /api/refresh 手動觸發重新載入。
  - 快取以 dict[str, dict] 儲存，key = 國際條碼 (internationalBarcode)。
  - 價格以查詢當下依 cost 即時計算，此處僅負責快取資料讀取。
"""

import logging
from typing import Any

from core.config import db

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════
# Global In-Memory Cache
# ═══════════════════════════════════════════
_products_cache: dict[str, dict[str, Any]] = {}


class ProductCache:
    """
    商品快取操作介面。
    所有讀取操作都從記憶體取資料，不打 Firestore。
    """

    @staticmethod
    def get_all() -> dict[str, dict[str, Any]]:
        """取得完整快取 (key = 國際條碼)。"""
        return _products_cache

    @staticmethod
    def get_by_barcode(barcode: str) -> dict[str, Any] | None:
        """以國際條碼查詢單一商品。"""
        return _products_cache.get(barcode.strip())

    @staticmethod
    def get_by_model(model: str) -> dict[str, Any] | None:
        """以型號查詢單一商品 (線性掃描)。"""
        model_upper: str = model.strip().upper()
        for product in _products_cache.values():
            if product.get("model", "").upper() == model_upper:
                return product
        return None

    @staticmethod
    def search(keyword: str) -> list[dict[str, Any]]:
        """
        以關鍵字模糊搜尋商品。
        搜尋範圍：型號、品名、分類。
        """
        kw_lower: str = keyword.strip().lower()
        if not kw_lower:
            return []

        results: list[dict[str, Any]] = []
        for product in _products_cache.values():
            search_key: str = (
                f"{product.get('model', '')} "
                f"{product.get('name', '')} "
                f"{product.get('category', '')}"
            ).lower()
            if kw_lower in search_key:
                results.append(product)
        return results

    @staticmethod
    def count() -> int:
        """回傳快取中的商品數量。"""
        return len(_products_cache)


async def load_all_products() -> int:
    """
    從 Firestore `Products` 集合全量載入商品到記憶體快取。

    Returns:
        int: 成功載入的商品數量。

    Raises:
        Exception: Firestore 讀取失敗時會向上拋出。
    """
    global _products_cache

    logger.info("🔄 Starting full product cache reload from Firestore...")

    try:
        products_ref = db.collection("Products")
        docs = products_ref.stream()

        new_cache: dict[str, dict[str, Any]] = {}
        count: int = 0

        for doc in docs:
            data: dict[str, Any] | None = doc.to_dict()
            if not data:
                continue

            # 跳過已下架商品
            if data.get("status") == "inactive":
                continue

            # 保留 Document ID 供後續反查
            data["_doc_id"] = doc.id

            # 以國際條碼為快取 Key (與前端 system.html 匯入邏輯一致)
            barcode: str = str(
                data.get("internationalBarcode", data.get("barcode", doc.id))
            ).strip()

            new_cache[barcode] = data
            count += 1

        # ✅ Atomic swap — 確保讀取端不會看到半成品
        _products_cache = new_cache

        logger.info(f"✅ Product cache loaded: {count} active products")
        return count

    except Exception as e:
        logger.error(f"❌ Failed to load product cache: {e}")
        raise
