"""
utils/flex_builder.py
─────────────────────
LINE Flex Message 產生器。

生成 Bubble 類型的報價卡片，支援單張與 Carousel 多張組裝。
  - build_pricing_card: 單張商品卡片 (Bubble)
  - build_carousel: 多張卡片容器 (Carousel, 最多 10 張)
"""

from typing import Any

# 預設 KINYO Logo (當商品無圖片時使用)
_DEFAULT_IMAGE_URL: str = (
    "https://images.weserv.nl/?url="
    "https%3A%2F%2Fdrive.google.com%2Fuc%3Fid%3D1JxoU3A5qAYsE39pc2z7IMVwVS8-uTOIn"
    "&output=jpg&w=400&q=70"
)

# 預設官網 URL
_DEFAULT_WEBSITE_URL: str = "https://www.kinyo-gift.com"


def build_pricing_card(
    product: dict[str, Any],
    qty: int,
    final_price: int,
    tier_name: str,
    market_price: int | None = None,
) -> dict[str, Any]:
    """
    建構 LINE Flex Message Bubble JSON。

    Args:
        product: 商品資料 dict。
        qty: 查詢數量。
        final_price: 最終含稅價格。
        tier_name: 計價級距名稱 (e.g. "100 個報價")。

    Returns:
        Flex Message Bubble dict (可直接傳入 FlexContainer.from_dict)。
    """
    # ─── 資料準備 ───
    product_name: str = product.get("name", "未命名商品")
    model: str = product.get("model", "N/A")
    main_model: str = product.get("mainModel", model)

    # 圖片：優先用 imageUrl，無則用 Drive 主圖
    image_url: str = product.get("imageUrl", "") or ""
    if not image_url or not image_url.startswith("http"):
        image_url = _DEFAULT_IMAGE_URL

    # 官網連結
    product_url: str = product.get("productUrl", "") or _DEFAULT_WEBSITE_URL

    # 價格千分位格式
    level_price_display: str = f"${final_price:,}"
    market_price_display: str = (
        f"${int(market_price):,}" if market_price is not None and market_price > 0 else "-"
    )

    # ─── Bubble JSON 結構 ───
    bubble: dict[str, Any] = {
        "type": "bubble",
        "size": "kilo",

        # ── Hero: 商品圖片 ──
        "hero": {
            "type": "image",
            "url": image_url,
            "size": "full",
            "aspectRatio": "1:1",
            "aspectMode": "cover",
            "backgroundColor": "#F5F5F5",
        },

        # ── Body: 商品資訊 ──
        "body": {
            "type": "box",
            "layout": "vertical",
            "spacing": "md",
            "contents": [
                # 商品名稱
                {
                    "type": "text",
                    "text": product_name,
                    "weight": "bold",
                    "size": "lg",
                    "wrap": True,
                    "maxLines": 2,
                    "color": "#1a1a1a",
                },
                # 型號
                {
                    "type": "text",
                    "text": f"型號：{main_model}",
                    "size": "sm",
                    "color": "#888888",
                },
                # 分隔線
                {
                    "type": "separator",
                    "margin": "lg",
                },
                # 查詢數量 + 計價級距
                {
                    "type": "box",
                    "layout": "vertical",
                    "margin": "lg",
                    "spacing": "sm",
                    "contents": [
                        {
                            "type": "box",
                            "layout": "horizontal",
                            "contents": [
                                {
                                    "type": "text",
                                    "text": "查詢數量",
                                    "size": "sm",
                                    "color": "#888888",
                                    "flex": 0,
                                },
                                {
                                    "type": "text",
                                    "text": f"{qty:,} pcs",
                                    "size": "sm",
                                    "color": "#333333",
                                    "align": "end",
                                    "weight": "bold",
                                },
                            ],
                        },
                        {
                            "type": "box",
                            "layout": "horizontal",
                            "contents": [
                                {
                                    "type": "text",
                                    "text": "計價級距",
                                    "size": "sm",
                                    "color": "#888888",
                                    "flex": 0,
                                },
                                {
                                    "type": "text",
                                    "text": tier_name,
                                    "size": "sm",
                                    "color": "#888888",
                                    "align": "end",
                                },
                            ],
                        },
                    ],
                },
                # 最終報價 (大字紅色)
                {
                    "type": "box",
                    "layout": "vertical",
                    "margin": "xl",
                    "contents": [
                        {
                            "type": "text",
                            "text": "您的等級價",
                            "size": "xs",
                            "color": "#aaaaaa",
                        },
                        {
                            "type": "text",
                            "text": level_price_display,
                            "size": "xxl",
                            "weight": "bold",
                            "color": "#dc2626",
                        },
                        {
                            "type": "text",
                            "text": f"賣場價：{market_price_display}",
                            "size": "sm",
                            "color": "#6b7280",
                            "margin": "sm",
                        },
                    ],
                },
            ],
        },

        # ── Footer: 官網連結 ──
        "footer": {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "contents": [
                {
                    "type": "button",
                    "action": {
                        "type": "uri",
                        "label": "🔗 開啟官網",
                        "uri": product_url,
                    },
                    "style": "primary",
                    "color": "#2563eb",
                    "height": "sm",
                },
            ],
        },

        # ── Bubble 樣式 ──
        "styles": {
            "body": {"backgroundColor": "#ffffff"},
            "footer": {"backgroundColor": "#f8fafc"},
        },
    }

    return bubble


def build_carousel(bubbles: list[dict[str, Any]]) -> dict[str, Any]:
    """
    將多張 Bubble 包裝成 Carousel 容器。

    LINE Flex Message 規格：Carousel 最多 10 張 Bubble。

    Args:
        bubbles: Bubble dict 陣列。

    Returns:
        Carousel dict (可直接傳入 FlexContainer.from_dict)。
    """
    return {
        "type": "carousel",
        "contents": bubbles[:10],
    }
