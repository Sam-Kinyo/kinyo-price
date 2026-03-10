"""
routers/webhook_api.py
──────────────────────
LINE Messaging API Webhook 進入點。

使用 line-bot-sdk v3 語法。
整合 NLP Parser (數量 + 預算 + 關鍵字) → 多筆搜尋 → Carousel 報價。
"""

import logging

from fastapi import APIRouter, Request, HTTPException

from linebot.v3.webhook import WebhookHandler
from linebot.v3.messaging import (
    Configuration,
    ApiClient,
    MessagingApi,
    ReplyMessageRequest,
    TextMessage,
    FlexMessage,
    FlexContainer,
)
from linebot.v3.webhooks import MessageEvent, TextMessageContent
from linebot.v3.exceptions import InvalidSignatureError

from core.config import LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN
from services.pricing_service import (
    search_products,
    calculate_tier_price,
)
from utils.parser import parse_user_query
from utils.flex_builder import build_pricing_card, build_carousel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["LINE Webhook"])

# ═══════════════════════════════════════════
# LINE Bot SDK v3 初始化
# ═══════════════════════════════════════════
handler = WebhookHandler(LINE_CHANNEL_SECRET)
configuration = Configuration(access_token=LINE_CHANNEL_ACCESS_TOKEN)


# ═══════════════════════════════════════════
# POST /api/webhook
# ═══════════════════════════════════════════
@router.post("/webhook")
async def line_webhook(request: Request) -> str:
    """
    LINE Platform 會將所有事件 POST 到此端點。
    必須驗證 X-Line-Signature 以確認請求來源。
    """
    signature: str | None = request.headers.get("X-Line-Signature")
    if not signature:
        raise HTTPException(
            status_code=400,
            detail="Missing X-Line-Signature header",
        )

    body: bytes = await request.body()
    body_str: str = body.decode("utf-8")

    try:
        handler.handle(body_str, signature)
    except InvalidSignatureError:
        logger.warning("⚠️ Invalid LINE signature detected")
        raise HTTPException(status_code=403, detail="Invalid signature")
    except Exception as e:
        logger.error(f"❌ Webhook handler error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")

    return "OK"


# ═══════════════════════════════════════════
# Event Handler: Text Message → 查價流程
# ═══════════════════════════════════════════
@handler.add(MessageEvent, message=TextMessageContent)
def handle_text_message(event: MessageEvent) -> None:
    """
    攔截 TextMessage，執行：
      1. NLP Parser → (qty, max_price, keyword)
      2. search_products → list[product] (含預算過濾, max 10)
      3. calculate_tier_price → 每筆計算報價
      4. build_pricing_card → 每筆組 Bubble
      5. build_carousel → Carousel / 單張 Bubble
    """
    user_text: str = event.message.text
    user_id: str = event.source.user_id
    reply_token: str = event.reply_token

    logger.info(f"📩 [{user_id[:8]}...] '{user_text}'")

    try:
        # ─── Step 1：NLP 複合條件解析 ───
        qty, max_price, keyword = parse_user_query(user_text)

        logger.info(f"🔎 Parsed → qty={qty}, max_price={max_price}, keyword='{keyword}'")

        if not keyword:
            _reply_text(reply_token, "🔍 請輸入商品型號或關鍵字進行查詢。\n範例：CL-528 100\n範例：50台 300元以內 吹風機")
            return

        # ─── Step 2：多筆搜尋 (含預算過濾) ───
        matched_products = search_products(
            query=keyword,
            user_id=user_id,
            qty=qty,
            max_price=max_price,
        )

        if not matched_products:
            if max_price is not None:
                _reply_text(
                    reply_token,
                    f"🔍 找不到 ${max_price:,} 以內的「{keyword}」商品。\n請調高預算或更換關鍵字。",
                )
            else:
                _reply_text(
                    reply_token,
                    "🔍 找不到相關商品型號，請確認後重新輸入。",
                )
            return

        # ─── Step 3：逐筆計算報價 + 組裝卡片 ───
        bubbles: list[dict] = []

        for product in matched_products:
            try:
                final_price, tier_name = calculate_tier_price(user_id, product, qty)
                bubble = build_pricing_card(product, qty, final_price, tier_name)
                bubbles.append(bubble)
            except PermissionError:
                raise  # 權限不足直接中斷
            except Exception as e:
                logger.warning(f"⚠️ Skipped {product.get('model')}: {e}")
                continue

        if not bubbles:
            _reply_text(reply_token, "⚠️ 商品資料異常，請稍後再試。")
            return

        # ─── Step 4：組裝 Flex Message ───
        result_count: int = len(bubbles)
        if result_count == 1:
            flex_content = bubbles[0]
            alt_text = f"{matched_products[0].get('name', '商品')} 報價結果"
        else:
            flex_content = build_carousel(bubbles)
            alt_text = f"為您找到 {result_count} 筆結果"

        with ApiClient(configuration) as api_client:
            messaging_api = MessagingApi(api_client)
            messaging_api.reply_message(
                ReplyMessageRequest(
                    reply_token=reply_token,
                    messages=[
                        FlexMessage(
                            alt_text=alt_text,
                            contents=FlexContainer.from_dict(flex_content),
                        )
                    ],
                )
            )

    except PermissionError:
        logger.warning(f"🚫 Unauthorized user: {user_id}")
        _reply_text(
            reply_token,
            "⚠️ 您尚未開通查詢權限，請聯繫業務窗口進行綁定。",
        )

    except Exception as e:
        logger.error(f"❌ Unexpected error: {e}", exc_info=True)
        _reply_text(
            reply_token,
            "⚠️ 系統發生錯誤，請稍後再試。",
        )


# ═══════════════════════════════════════════
# Helper: 回覆純文字
# ═══════════════════════════════════════════
def _reply_text(reply_token: str, text: str) -> None:
    """便捷方法：回覆純文字訊息。"""
    with ApiClient(configuration) as api_client:
        messaging_api = MessagingApi(api_client)
        messaging_api.reply_message(
            ReplyMessageRequest(
                reply_token=reply_token,
                messages=[TextMessage(text=text)],
            )
        )
