"""
services/pricing_service.py
───────────────────────────
LINE Bot 查價系統核心邏輯模組。

包含三個核心函數：
  A. parse_query     — 訊息解析 (型號 + 數量)
  B. fuzzy_find_product — 模糊搜尋 (rapidfuzz)
  C. calculate_tier_price — 權限驗證 + 階梯報價計算
"""

import re
import logging
from typing import Any

from rapidfuzz import process, fuzz

from core.config import db
from database.firestore_db import ProductCache

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════
# A. 訊息解析 (parse_query)
# ═══════════════════════════════════════════════════════════
def parse_query(raw_text: str) -> tuple[str, int]:
    """
    將使用者原始文字拆分為「型號查詢」與「數量」。

    規則：
      - "CL-528 100"  → ("CL-528", 100)
      - "CL-528"      → ("CL-528", 1)
      - "充電線 50"    → ("充電線", 50)

    Args:
        raw_text: 使用者傳送的原始文字。

    Returns:
        (model_query, qty) 元組。
    """
    text: str = raw_text.strip()
    if not text:
        return ("", 1)

    # Regex：最後一組數字視為數量，前面視為型號查詢
    match = re.match(r"^(.*?)\s+(\d+)$", text)
    if match:
        model_query: str = match.group(1).strip()
        qty: int = int(match.group(2))
        # 防呆：數量最小為 1，最大為 999999
        qty = max(1, min(qty, 999999))
        return (model_query, qty)

    # 無數字後綴 → 預設數量為 1
    return (text, 1)


# ═══════════════════════════════════════════════════════════
# B. 多筆搜尋 (search_products) — 含預算過濾
# ═══════════════════════════════════════════════════════════
_MAX_RESULTS: int = 10


def search_products(
    query: str,
    user_id: str | None = None,
    qty: int = 1,
    max_price: int | None = None,
) -> list[dict[str, Any]]:
    """
    搜尋所有包含關鍵字的商品，可選預算過濾，最多回傳 10 筆。

    搜尋策略：
      1. 子字串包含比對 (model / mainModel / name) — 全庫存掃描
      2. 若第一階段無結果，改用 rapidfuzz 模糊比對 (score ≥ 60)
      3. 若有 max_price，逐筆計算使用者報價後過濾

    Args:
        query: 使用者輸入的關鍵字。
        user_id: LINE 使用者 ID (用於計算報價以做預算過濾)。
        qty: 查詢數量 (影響計價級距)。
        max_price: 預算上限 (含稅)，None 表示不限。

    Returns:
        匹配到的商品 list (最多 10 筆)，無結果回傳空 list。
    """
    products: dict[str, dict[str, Any]] = ProductCache.get_all()
    if not products:
        logger.warning("⚠️ Product cache is empty")
        return []

    query_upper: str = query.strip().upper()
    if not query_upper:
        return []

    # ─── Pass 1：子字串包含比對 (全庫存掃描，不得中斷) ───
    seen: set[str] = set()
    matched: list[dict[str, Any]] = []

    for barcode, product in products.items():
        model: str = product.get("model", "").upper()
        main_model: str = product.get("mainModel", "").upper()
        name: str = product.get("name", "").upper()

        if (
            query_upper in model
            or query_upper in main_model
            or query_upper in name
        ):
            if barcode not in seen:
                seen.add(barcode)
                matched.append(product)

    # ─── Pass 2：rapidfuzz Fallback (若 Pass 1 無結果) ───
    if not matched:
        candidates: dict[str, dict[str, Any]] = {}
        for barcode, product in products.items():
            m = product.get("model", "").strip().upper()
            mm = product.get("mainModel", "").strip().upper()
            n = product.get("name", "").strip()
            if m and m not in candidates:
                candidates[m] = product
            if mm and mm not in candidates:
                candidates[mm] = product
            if n and n not in candidates:
                candidates[n] = product

        if candidates:
            result = process.extractOne(
                query_upper,
                choices=list(candidates.keys()),
                scorer=fuzz.WRatio,
                score_cutoff=60,
            )
            if result is not None:
                matched_key: str = result[0]
                score: float = result[1]
                logger.info(
                    f"🎯 Fuzzy '{query}' → '{matched_key}' (score: {score:.1f})"
                )
                matched = [candidates[matched_key]]

    if not matched:
        logger.info(f"🔍 No match for '{query}'")
        return []

    logger.info(f"🎯 '{query}': {len(matched)} hits before budget filter")

    # ─── Pass 3：預算過濾 (若有 max_price) ───
    if max_price is not None and user_id:
        filtered: list[dict[str, Any]] = []
        for product in matched:
            try:
                price, _ = calculate_tier_price(user_id, product, qty)
                if price <= max_price:
                    filtered.append(product)
            except PermissionError:
                raise  # 權限錯誤直接往上拋
            except Exception:
                continue  # 單筆計算失敗跳過
        logger.info(
            f"💰 Budget ≤${max_price:,}: "
            f"{len(matched)} → {len(filtered)} products"
        )
        matched = filtered

    return matched[:_MAX_RESULTS]


# ═══════════════════════════════════════════════════════════
# C. 權限與報價計算 (calculate_tier_price)
# ═══════════════════════════════════════════════════════════
def calculate_tier_price(
    user_id: str,
    product: dict[str, Any],
    qty: int,
) -> tuple[int, str]:
    """
    根據使用者權限與查詢數量，計算最終含稅報價。

    查詢流程：
      1. LineUsers (DocID = LINE userId) → 取得 email
      2. Users (DocID = email) → 取得 level, vipColumn
      3. 依層級與數量匹配價格

    Args:
        user_id: LINE 使用者 ID。
        product: 商品資料 dict。
        qty: 查詢數量。

    Returns:
        (final_price, tier_name) 元組。

    Raises:
        PermissionError: 使用者未綁定或無權限。
    """

    # --- 輔助函數：安全轉換數字，避免空字串造成當機 ---
    def safe_float(val: Any) -> float | None:
        if val is None or str(val).strip() == "":
            return None
        try:
            return float(val)
        except ValueError:
            return None

    # ─── Step 1：從 LineUsers 取得 email ───
    line_user_ref = db.collection("LineUsers").document(user_id)
    line_user_doc = line_user_ref.get()

    if not line_user_doc.exists:
        raise PermissionError(f"LineUser not found: {user_id}")

    line_user_data: dict[str, Any] = line_user_doc.to_dict() or {}
    email: str = line_user_data.get("email", "").strip().lower()

    if not email:
        raise PermissionError(f"LineUser has no email: {user_id}")

    # ─── Step 2：從 Users 取得權限資料 ───
    user_ref = db.collection("Users").document(email)
    user_doc = user_ref.get()

    level: int = 0
    vip_column: str | None = None

    if user_doc.exists:
        user_data: dict[str, Any] = user_doc.to_dict() or {}
        level = int(user_data.get("level", 0))
        vip_column = user_data.get("vipColumn")

    # ─── Step 3：階梯價格匹配 (依序向下判斷) ───
    matched_price: float | None = None
    tier_name: str = ""

    # 3-1. VIP 且 vipColumn 有值
    if vip_column:
        vip_price = safe_float(product.get(vip_column))
        if vip_price is not None:
            matched_price = vip_price
            tier_name = f"VIP 專屬價 ({vip_column})"

    # 3-2. Level 4 (業務)：取 cost
    if matched_price is None and level >= 4:
        cost = safe_float(product.get("cost"))
        if cost is not None and cost > 0:
            matched_price = cost
            tier_name = "業務進價"

    # 3-3. Level >= 3, qty >= 1000
    if matched_price is None and level >= 3 and qty >= 1000:
        val = safe_float(product.get("quote1000"))
        if val is not None:
            matched_price = val
            tier_name = "1000 個報價"

    # 3-4. Level >= 3, qty >= 500
    if matched_price is None and level >= 3 and qty >= 500:
        val = safe_float(product.get("quote500"))
        if val is not None:
            matched_price = val
            tier_name = "500 個報價"

    # 3-5. Level >= 2, qty >= 100
    if matched_price is None and level >= 2 and qty >= 100:
        val = safe_float(product.get("quote100"))
        if val is not None:
            matched_price = val
            tier_name = "100 個報價"

    # 3-6. Level >= 1, qty >= 50
    if matched_price is None and level >= 1 and qty >= 50:
        val = safe_float(product.get("quote50"))
        if val is not None:
            matched_price = val
            tier_name = "50 個報價"

    # 3-7. 預設：建議售價 (SRP)
    if matched_price is None:
        srp = safe_float(product.get("srp"))
        matched_price = srp if srp is not None else 0.0
        tier_name = "建議售價"

    # ─── Step 4：$0 防呆阻斷 ───
    # 若階梯報價取不到 (如 qty=1 不符任何級距)，
    # 強制退回 groupBuyPrice → srp → marketPrice
    if matched_price is None or matched_price == 0:
        fallback_fields = ["groupBuyPrice", "srp", "marketPrice"]
        for fb_field in fallback_fields:
            fb_val = safe_float(product.get(fb_field))
            if fb_val is not None and fb_val > 0:
                matched_price = fb_val
                tier_name = "參考售價"
                break

    # 最終仍為 0 → 回傳 0 讓外層過濾掉
    if matched_price is None or matched_price <= 0:
        logger.warning(
            f"⚠️ $0 price for {product.get('model', '?')}, skipping tax calc"
        )
        return (0, "無報價")

    # ─── Step 5：稅金計算 ───
    final_price: int = round(matched_price * 1.05)

    logger.info(
        f"💰 Price for user={email}, level={level}, qty={qty}: "
        f"${final_price:,} ({tier_name})"
    )

    return (final_price, tier_name)
