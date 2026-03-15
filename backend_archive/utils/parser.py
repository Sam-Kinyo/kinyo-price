"""
utils/parser.py
───────────────
LINE 使用者訊息複合條件解析器 (V3)。

從自然語言中拆解出三個維度：
  1. 數量 (qty)       — e.g. 50台、100 pcs
  2. 預算 (max_price)  — e.g. 300元以內、低於500、預算不超過1000
  3. 關鍵字 (keyword)   — 扣除數量、預算、贅字後的純淨字串

萃取順序：qty → budget → stop words → keyword
"""

import re


# ═══════════════════════════════════════════════════════════
# 常數
# ═══════════════════════════════════════════════════════════

# 中文/英文量詞
_UNIT_PATTERN = r"(?:台|個|pcs|PCS|支|把|組|件|入|盒|箱|包|片|顆|瓶|罐|只|條|捲|捆|打|雙|對|份|套)"

# 無資訊贅字 (Stop Words) — 萃取完數量與預算後清除
_STOP_WORDS: list[str] = [
    "的商品", "商品", "推薦", "報價", "幫我找", "幫我查",
    "有沒有", "請問", "預算", "元", "塊", "的", "查一下",
]


# ═══════════════════════════════════════════════════════════
# 主函式
# ═══════════════════════════════════════════════════════════

def parse_user_query(user_message: str) -> tuple[int, int | None, str]:
    """
    解析使用者輸入，拆解出數量、預算上限、商品關鍵字。

    萃取順序（嚴格按序，避免互相干擾）：
      1. 數量 → "50台"、"100 pcs"
      2. 預算 → 前綴型 "低於500" / 後綴型 "500元以內"
      3. 贅字清洗 → 移除 "的商品"、"推薦"、"報價" 等
      4. 剩餘文字 → keyword

    Examples:
        >>> parse_user_query("50台 300元以內的 吹風機")
        (50, 300, "吹風機")

        >>> parse_user_query("預算低於500 充電線")
        (1, 500, "充電線")

        >>> parse_user_query("請問有沒有不超過 1000 的行動電源推薦")
        (1, 1000, "行動電源")

        >>> parse_user_query("KPB-1234")
        (1, None, "KPB-1234")

        >>> parse_user_query("KH9660 100 pcs")
        (100, None, "KH9660")

    Args:
        user_message: LINE 使用者輸入的原始字串。

    Returns:
        tuple[int, int | None, str]: (數量, 預算上限, 乾淨的關鍵字)。
    """
    text: str = user_message.strip()
    if not text:
        return (1, None, "")

    qty: int = 1
    max_price: int | None = None

    # ─── Step 1：萃取數量 (帶單位) ───
    qty_match = re.search(
        rf"(\d+)\s*{_UNIT_PATTERN}",
        text,
        re.IGNORECASE,
    )
    if qty_match:
        qty = int(qty_match.group(1))
        text = text.replace(qty_match.group(0), "")

    # ─── Step 2：萃取預算 ───
    # 模式 A (前綴型)：「預算低於500」「低於 500 元」「不超過1000」「最多500」
    budget_a = re.search(
        r"(?:預算)?(?:低於|小於|不超過|最多|不要超過)\s*(\d+)\s*(?:元|塊)?",
        text,
    )
    # 模式 B (後綴型)：「500元以內」「500 以下」「1000塊以內」
    budget_b = re.search(
        r"(\d+)\s*(?:元|塊)?\s*(?:以內|以下|內)",
        text,
    )

    if budget_a:
        max_price = int(budget_a.group(1))
        text = text.replace(budget_a.group(0), "")
    elif budget_b:
        max_price = int(budget_b.group(1))
        text = text.replace(budget_b.group(0), "")

    # ─── Step 3：尾數字數量（無量詞） ───
    # 例：CL-528 100、行動電源 300
    # 若 Step1 沒抓到 qty，且尾碼為數字，視為數量。
    if qty == 1:
        tail_qty = re.search(r"^(.*?)[\s,，]+(\d{1,6})$", text)
        if tail_qty:
            prefix = tail_qty.group(1).strip()
            candidate_qty = int(tail_qty.group(2))
            # 防止把純數字查詢誤判成 qty
            if prefix and not re.fullmatch(r"\d+", prefix):
                qty = candidate_qty
                text = prefix

    # ─── Step 4：移除贅字 (Stop Words) ───
    for word in _STOP_WORDS:
        text = text.replace(word, "")

    # ─── Step 5：清理關鍵字 ───
    keyword: str = re.sub(r"\s+", " ", text).strip()

    # 防呆：數量邊界
    qty = max(1, min(qty, 999999))

    return (qty, max_price, keyword)
