const { GoogleGenAI, Type } = require('@google/genai');

// 定義 Gemini JSON Schema 結構
const intentSchema = {
    type: Type.OBJECT,
    properties: {
        intent: {
            type: Type.STRING,
            description: "使用者的意圖分類。若是詢問商品、預算、庫存，輸出 'query'。若是明確提供收件人、電話、地址與多項商品數量進行下單結帳，輸出 'order'。"
        },
        action: {
            type: Type.STRING,
            description: "特殊動作分類 (例如：borrow_sample, batch_order, repair_info)",
            nullable: true
        },
        keyword: {
            type: Type.STRING,
            description: "使用者想要搜尋的商品型號或名稱 (例如：KPB-2990, 吹風機)。若是下單意圖則為 null",
            nullable: true
        },
        target_qty: {
            type: Type.INTEGER,
            description: "使用者預計購買的數量。純數字，無則為 null",
            nullable: true
        },
        min_budget: {
            type: Type.INTEGER,
            description: "使用者指定的預算下限或最低預算，純數字，無則為 null",
            nullable: true
        },
        max_budget: {
            type: Type.INTEGER,
            description: "使用者指定的預算上限或最高預算，純數字，無則為 null",
            nullable: true
        },
        min_stock: {
            type: Type.INTEGER,
            description: "使用者要求的最低安全庫存量限制，純數字，無則為 null",
            nullable: true
        },
        request_image_links: {
            type: Type.BOOLEAN,
            description: "若使用者輸入中包含「大圖」、「網路圖」、「照片」、「圖片」、「素材」等強烈索取圖庫連結的語氣，請設為 true，否則為 false。"
        },
        customer: {
            type: Type.OBJECT,
            description: "下單客戶或申請件(借樣品/新品不良)的聯繫與配送資料",
            nullable: true,
            properties: {
                company: { type: Type.STRING, description: "採購公司名稱", nullable: true },
                name: { type: Type.STRING, description: "收件人姓名", nullable: true },
                phone: { type: Type.STRING, description: "聯絡電話", nullable: true },
                address: { type: Type.STRING, description: "配送地址、送貨地址、取件地址、取件與換貨地址或任何地址相關欄位", nullable: true },
                deliveryTime: { type: Type.STRING, description: "預期到貨時間", nullable: true },
                remark: { type: Type.STRING, description: "訂單備註事項", nullable: true },
                projectName: { type: Type.STRING, description: "借樣品案名", nullable: true },
                returnDate: { type: Type.STRING, description: "預計歸還日期", nullable: true },
                reserveDeadline: { type: Type.STRING, description: "預留訂單的預留期限，必須輸出為 ISO 格式 YYYY-MM-DD (例：2026-05-31)", nullable: true }
            },
            required: ["company", "name", "phone", "address", "deliveryTime", "remark", "projectName", "returnDate", "reserveDeadline"]
        },
        orderItems: {
            type: Type.ARRAY,
            description: "下單商品清單陣列 (僅在 intent 為 'order' 時輸出)",
            nullable: true,
            items: {
                type: Type.OBJECT,
                properties: {
                    model: { type: Type.STRING, description: "商品名稱或型號" },
                    qty: { type: Type.INTEGER, description: "訂購數量。若未註明數量，預設為 1" },
                    unitPrice: { type: Type.INTEGER, description: "如有標示單價，提取出純數字。若未標示，輸出 null", nullable: true },
                    unit: { type: Type.STRING, description: "訂購單位 (例如: 箱、件、個、台、組)，若未標示單位，請輸出 null", nullable: true }
                }
            }
        },
        items: {
            type: Type.ARRAY,
            description: "商品陣列 (借樣品與新品不良用)",
            nullable: true,
            items: {
                type: Type.OBJECT,
                properties: {
                    model: { type: Type.STRING, description: "商品名稱或型號" },
                    quantity: { type: Type.INTEGER, description: "數量。純數字" },
                    reason: { type: Type.STRING, description: "故障原因 (僅新品不良適用)", nullable: true },
                    unit: { type: Type.STRING, description: "訂購單位 (例如: 箱、件、個、台、組)，若未標示單位，請輸出 null", nullable: true }
                }
            }
        },
        orders: {
            type: Type.ARRAY,
            description: "多筆訂單陣列 (僅在 action 為 'batch_order' 時輸出)",
            nullable: true,
            items: {
                type: Type.OBJECT,
                properties: {
                    customer: {
                        type: Type.OBJECT,
                        description: "訂單客戶的聯繫與配送資料",
                        properties: {
                            company: { type: Type.STRING, description: "採購公司名稱", nullable: true },
                            name: { type: Type.STRING, description: "收件人姓名", nullable: true },
                            phone: { type: Type.STRING, description: "聯絡電話", nullable: true },
                            address: { type: Type.STRING, description: "配送地址", nullable: true },
                            remark: { type: Type.STRING, description: "訂單備註事項", nullable: true }
                        },
                        required: ["company", "name", "phone", "address", "remark"]
                    },
                    items: {
                        type: Type.ARRAY,
                        description: "下單商品清單陣列",
                        items: {
                            type: Type.OBJECT,
                            properties: {
                                model: { type: Type.STRING, description: "商品名稱或型號" },
                                quantity: { type: Type.INTEGER, description: "訂購數量。若未註明數量，預設為 1" },
                                price: { type: Type.INTEGER, description: "如有標示單價，提取出純數字。若未標示，輸出 0" },
                                unit: { type: Type.STRING, description: "訂購單位 (例如: 箱、件、個、台、組)，若未標示單位，請輸出 null", nullable: true }
                            }
                        }
                    }
                }
            }
        }
    },
    required: []
};


async function parseUserIntent(cleanUserText, apiKey) {
    let intentParams = {
        intent: 'query',
        keyword: null,
        target_qty: null,
        min_budget: null,
        max_budget: null,
        min_stock: null,
        request_image_links: false,
        customer: null,
        orderItems: null
    };

    const ai = new GoogleGenAI({ apiKey });

    const prompt = `你是一個嚴格的 JSON 輸出引擎。請判斷使用者意圖。

【最高權限規則：訂單與報價的絕對邊界】
1. 建立訂單的絕對條件：使用者的輸入字串中，必須明確包含「下單」或「訂單」這兩個關鍵字之一。
2. 若對話文字中「沒有」出現「下單」或「訂單」，即使包含大量商品型號與數量，也【絕對禁止】將 action 判定為建立訂單。
3. 承上，缺乏上述關鍵字的多品項查詢，請強制將 action 判定為「報價」或「匯出 Excel」(依系統現有報價邏輯的 action 名稱)。

若是查詢報價，輸出: { "intent": "query", "keywords": ["型號"], "min_budget": null, "max_budget": null }
若是下單，必須嚴格輸出以下 JSON 格式，絕對不可遺漏任何鍵值(Key)：
{
  "intent": "order",
  "customer": { "company": "採購公司", "name": "收件人", "phone": "電話", "address": "送貨地址", "deliveryTime": "預期到貨", "remark": "備註內容" },
  "orderItems": [ 
    { "model": "型號", "qty": 數量, "unitPrice": 單價數字, "unit": "單位(如箱/件/台，若無則為null)" } 
  ]
}
【極重要規則 - 違規將導致系統崩潰】：
1. orderItems 陣列內的每一個物件，都必須強制包含 "unitPrice" 欄位！
2. 若客戶明文提供單價，請擷取該單價；若客戶未提供單價，絕對禁止自動帶入系統價格，請強制將 unitPrice 設為 null。
3. 若訂單內有任何品項單價為 0 或 null，請將整筆訂單的 totalAmount 設為 0，不要自行瞎猜計算總額。
4. 確保輸出的 orderItems 陣列中，數量欄位統一命名為 qty，單價命名為 unitPrice。
5. "remark" 必須提取備註，若無則輸出 null。
6. "address" 必須對應使用者填寫的任何包含「地址」的欄位（如送貨地址、取件地址、取件與換貨地址等），"deliveryTime" 必須對應「預期到貨」，若無則輸出 null。
7. 必須提取使用者輸入的「採購公司」，若無則輸出 null。
8. 模糊預算處理規則：若使用者輸入的預算帶有『左右』、『上下』、『附近』等模糊字眼（例如：1000左右），請自動計算正負 10% 作為區間。例如 1000 左右，請輸出 "min_budget": 900 與 "max_budget": 1100。絕對不可將下限設為 0。
9. 單一數字預算規則：若使用者僅提供單一數字且無模糊字眼（例如：預算1000），請將其視為上限，輸出 "min_budget": 0 與 "max_budget": 1000。

【專屬客製化情境：行動屋批次出貨】
當使用者輸入字串開頭包含「行動屋出貨」時，請啟動批次解析模式：
1. 忽略一般訂單格式，請以「----」或多個連續橫線作為分界，將文字拆分為多筆訂單。
2. 從每筆訂單中精準擷取資料。商品型號通常在方括號內 (如 [KVC-6243])，數量在星號後 (如 *9)。
3. 強制回傳以下 JSON 格式：
{
  "action": "batch_order",
  "orders": [
    {
      "customer": {
        "company": "行動屋",
        "name": "店名 (如：遠傳健行店)",
        "phone": "電話",
        "address": "地址",
        "remark": "無"
      },
      "items": [
        { "model": "型號", "quantity": 數量, "price": 0, "unit": "單位(若無為null)" }
      ]
    }
  ]
}

【新增情境 1：借樣品申請】
若使用者對話內容包含「借樣品」，請強制回傳以下 JSON 格式（絕對禁止呼叫報價或計算總金額）：
{
  "action": "borrow_sample",
  "customer": {
    "company": "採購公司名稱",
    "name": "收件人名稱",
    "phone": "聯絡電話",
    "address": "請精準擷取任何『地址』相關欄位的字串",
    "projectName": "借樣品案名",
    "returnDate": "預計歸還日期 (若無則輸出 null)"
  },
  "items": [
    { "model": "商品型號", "quantity": 數量, "unit": "單位(若無為null)" }
  ]
}

【新增情境 1.5：預留訂單 (佔位先留貨)】
若使用者對話內容包含「預留訂單」或「留貨」(且不是「借樣品」或「新品不良」)，請強制回傳以下 JSON 格式（絕對禁止呼叫報價）：
{
  "action": "reserve_order",
  "customer": {
    "company": "採購公司名稱",
    "name": "收件人",
    "phone": "聯絡電話",
    "address": "送貨地址",
    "remark": "備註內容 (若無則輸出 null)",
    "reserveDeadline": "預留期限，必須轉為 ISO 格式 YYYY-MM-DD (例如：使用者輸入『2026/05/31』或『2026年5月31日』皆輸出 2026-05-31；若無法解析則輸出 null)"
  },
  "orderItems": [
    { "model": "型號", "qty": 數量, "unitPrice": 單價數字或null, "unit": "單位(若無為null)" }
  ]
}
注意：預留訂單的商品請放在 orderItems (含單價)，不是 items。

【新增情境 2：新品不良 / 來回件申請】
若使用者對話內容包含「新品不良」或「來回件」，請強制回傳以下 JSON 格式（絕對禁止呼叫報價或計算總金額）：
{
  "action": "defective_return",
  "customer": {
    "company": "採購公司名稱",
    "name": "客戶姓名",
    "phone": "客戶聯絡電話",
    "address": "請精準擷取任何『地址』相關欄位的字串",
    "remark": "備註內容 (若無則輸出 null)"
  },
  "items": [
    { "model": "不良品型號", "quantity": 數量, "reason": "故障原因", "unit": "單位(若無為null)" }
  ]
}

【新增情境 3：詢問維修或客服資訊】
若使用者對話內容長句中包含詢問「維修地址」、「怎麼修」、「保固」、「哪裡維修」、「客服電話」等相關問題，請強制將 action 設為 "repair_info"，intent 設為 "faq"：
{
  "intent": "faq",
  "action": "repair_info",
  "keyword": null
}

【新增情境 4：詢問教學與操作指南】
若使用者對話內容包含詢問「操作指南」、「使用教學」、「說明書」、「怎麼用」等相關問題，請強制將 action 設為 "user_guide"，intent 設為 "faq"：
{
  "intent": "faq",
  "action": "user_guide",
  "keyword": null
}

使用者輸入内容：「${cleanUserText}」`;

    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: intentSchema
        }
    });

    try {
        const jsonText = response.candidates?.[0]?.content?.parts?.[0]?.text;
        if (jsonText) {
            const parsed = JSON.parse(jsonText);
            intentParams = { ...intentParams, ...parsed };

            // query 關鍵字容錯處理
            if (parsed.keywords && Array.isArray(parsed.keywords) && !parsed.keyword) {
                intentParams.keyword = parsed.keywords.join(' ');
            }
        }
    } catch (jsonErr) {
        console.error(`[Gemini Warn] JSON 解析失敗:`, jsonErr);
    }

    return intentParams;
}

module.exports = { parseUserIntent };
