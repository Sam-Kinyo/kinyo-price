"""
utils/gemini_agent.py
─────────────────────
LINE 使用者訊息的 AI 語意解析器 (基於 Gemini API)。

取代原本的 Regex Parser，負責：
1. 將自然語言對話轉換為結構化的 JSON 查價條件 (qty, max_price, keyword)
2. 判斷是否為「非查價的純客服聊天 (is_chat)」
3. 若為純聊天，直接請 Gemini 生成合適的人性化回覆 (chat_reply)
"""

import json
import logging
from typing import Any
import google.generativeai as genai

from core.config import GEMINI_API_KEY

logger = logging.getLogger(__name__)

# ─── 初始化 Gemini ───
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
else:
    logger.warning("⚠️ GEMINI_API_KEY is missing! The AI Agent will not work properly.")

# 系統提示詞：賦予 AI 人設與格式要求
_SYSTEM_INSTRUCTION = """
你是一個名為「KINYO 查價小幫手」的 AI 客服代理人。你的任務是判斷使用者的輸入是「要查詢商品價格」還是「一般聊天/客服問題」。

【輸出格式】
你必須且只能回傳一個合法的 JSON 物件，不要有 Markdown 語法 (```json)，不要有其他廢話。

欄位定義如下：
{
  "is_chat": boolean, // 若使用者的輸入只是打招呼、道謝、或者問系統如何使用等「非查價」問題，則為 true。若明顯要找某個商品，則為 false。
  "keyword": string, // 商品關鍵字 (若 is_chat 為 true，此欄位可為空字串)。必須去除數量、預算與贅詞。
  "qty": integer, // 客人想查詢的數量 (預設為 1，若無特別提及數量，請回傳 1)
  "max_price": integer | null, // 預算上限 (若無提及預算，請回傳 null)
  "chat_reply": string // 若 is_chat 為 true，請在這裡寫下你要回覆給客人的親切話語。若為 false，此處留空字串。
}

【判斷準則】
- 使用者輸入：「我想買吹風機50個，預算300」
  {"is_chat": false, "keyword": "吹風機", "qty": 50, "max_price": 300, "chat_reply": ""}
  
- 使用者輸入：「有推薦的行動電源嗎？兩個」
  {"is_chat": false, "keyword": "行動電源", "qty": 2, "max_price": null, "chat_reply": ""}
  
- 使用者輸入：「你好 / 謝謝 / 掰掰」
  {"is_chat": true, "keyword": "", "qty": 1, "max_price": null, "chat_reply": "你好！我是 KINYO 查價小幫手，請告訴我你想找什麼商品，或者您可以直接輸入商品名稱與數量喔！"}
  
- 使用者輸入：「怎麼用？」
  {"is_chat": true, "keyword": "", "qty": 1, "max_price": null, "chat_reply": "您只要輸入商品關鍵字、想買的數量或是預算，例如『吹風機 50個 預算300』，我就會幫您找出適合的報價喔！"}
"""

# 使用 Gemini 1.5 Flash (速度快、支援 JSON mode)
_MODEL_NAME = "gemini-1.5-flash"

def parse_with_gemini(user_message: str) -> dict[str, Any]:
    """
    呼叫 Gemini 解析使用者訊息並回傳統一的 Dict:
    {
        "is_chat": bool,
        "keyword": str,
        "qty": int,
        "max_price": int | None,
        "chat_reply": str
    }
    """
    fallback_result = {
        "is_chat": False,
        "keyword": user_message.strip(),
        "qty": 1,
        "max_price": None,
        "chat_reply": ""
    }

    if not GEMINI_API_KEY:
        logger.warning("Gemini API key not set, falling back to raw text as keyword.")
        return fallback_result

    try:
        model = genai.GenerativeModel(
            model_name=_MODEL_NAME,
            system_instruction=_SYSTEM_INSTRUCTION,
            generation_config={"response_mime_type": "application/json"}
        )

        response = model.generate_content(user_message)
        response_text = response.text.strip()
        
        # Parse JSON
        parsed_data = json.loads(response_text)
        
        # 安全取得欄位
        is_chat = bool(parsed_data.get("is_chat", False))
        keyword = str(parsed_data.get("keyword", "")).strip()
        
        # 數量防呆
        try:
            qty = int(parsed_data.get("qty", 1))
            qty = max(1, min(qty, 999999))
        except (ValueError, TypeError):
            qty = 1
            
        # 預算防呆
        max_price_raw = parsed_data.get("max_price")
        if max_price_raw is not None:
            try:
                max_price = int(max_price_raw)
            except (ValueError, TypeError):
                max_price = None
        else:
            max_price = None
            
        chat_reply = str(parsed_data.get("chat_reply", "")).strip()

        logger.info(f"🧠 Gemini parsed intent: is_chat={is_chat}, keyword='{keyword}', qty={qty}, max_price={max_price}")
        return {
            "is_chat": is_chat,
            "keyword": keyword,
            "qty": qty,
            "max_price": max_price,
            "chat_reply": chat_reply
        }
        
    except json.JSONDecodeError as e:
        logger.error(f"❌ Gemini output invalid JSON: {response.text} | Error: {e}")
        return fallback_result
    except Exception as e:
        logger.error(f"❌ Gemini API error: {e}", exc_info=True)
        return fallback_result
