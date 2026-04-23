/**
 * emailService.js
 * 透過 nodemailer 將指定的文字內容轉換為 HTML 格式寄出
 */
const nodemailer = require('nodemailer');
const { SENDER_EMAIL } = require('../config/emailSettings');

/**
 * 建立 SMTP 連線
 * 需要 GMAIL_USER 和 GMAIL_PASS (或於 Firebase Config 中設定)
 */
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER || SENDER_EMAIL,
        pass: process.env.GMAIL_PASS
    }
});

/**
 * 發送 LINE Bot 的通知信件
 * @param {string} category '#大量訂單', '#商品預留', '#廠價申請'
 * @param {string} textContent 原始輸入的文字內容
 * @param {Array<string>} recipientEmails 目標收件人
 */
async function sendNotificationEmail(category, textContent, recipientEmails) {
    if (!recipientEmails || recipientEmails.length === 0) {
        throw new Error(`找不到分類 [${category}] 的收信人`);
    }

    // 將換行轉為 HTML 的 <br>
    const htmlContent = textContent.replace(/\n/g, '<br>');

    let subject = `【系統自動交辦】${category.replace('#', '')}處理`;

    // 針對 #廠價申請 或 #申請廠價，進行特定格式解析
    if (category === '#廠價申請' || category === '#申請廠價') {
        let clientName = '';
        let model = '';
        
        // 擷取客戶名稱
        const clientMatch = textContent.match(/客戶名稱\s*[：:]\s*(.+)/);
        if (clientMatch && clientMatch[1]) {
            clientName = clientMatch[1].trim();
        }
        
        // 擷取型號
        const modelMatch = textContent.match(/型號\s*[：:]\s*(.+)/);
        if (modelMatch && modelMatch[1]) {
            model = modelMatch[1].trim();
        }
        
        // 組合主旨：【廠價申請】(特販九) +(客戶) +(型號)
        const parts = [];
        if (clientName) parts.push(clientName);
        if (model) parts.push(model);
        
        if (parts.length > 0) {
            subject = `【廠價申請】(特販九) ${parts.join(' ')}`;
        } else {
            subject = `【廠價申請】(特販九)`; // Fallback 如果沒填寫的話
        }
    } else if (category === '#商品預留' || category === '#大量訂單') {
        let projectName = '';
        let model = '';
        
        // 擷取案名
        const projectMatch = textContent.match(/案名\s*[：:]\s*(.+)/);
        if (projectMatch && projectMatch[1]) {
            projectName = projectMatch[1].trim();
        }
        
        // 擷取型號
        const modelMatch = textContent.match(/型號\s*[：:]\s*(.+)/);
        if (modelMatch && modelMatch[1]) {
            model = modelMatch[1].trim();
        }
        
        const categoryName = category.replace('#', '');
        const parts = [];
        if (projectName) parts.push(projectName);
        if (model) parts.push(model);
        
        if (parts.length > 0) {
            subject = `【${categoryName}】(特販九) ${parts.join(' ')}`;
        } else {
            subject = `【${categoryName}】(特販九)`;
        }
    }

    const mailOptions = {
        from: `特販九-郭庭豪 <${process.env.GMAIL_USER || SENDER_EMAIL}>`,
        to: Array.isArray(recipientEmails) ? recipientEmails.join(', ') : recipientEmails,
        subject: subject,
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #ccc; border-radius: 5px; max-width: 800px;">
                <h2 style="color: #333; margin-top: 0;">📋 【交辦事項：${category.replace('#', '')}】</h2>
                <div style="margin-top: 15px; padding: 20px; background-color: #f9f9f9; border-left: 4px solid #ea580c; font-size: 16px; line-height: 1.6;">
                    ${htmlContent}
                </div>
                <hr style="margin-top: 30px; border: 0; border-top: 1px solid #eee;" />
                <p style="color: #888; font-size: 12px; line-height: 1.4;">
                    *本信件內容為系統從內部 LINE 群組對話自動擷取轉發，請儘速處理。<br>
                    發送時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
                </p>
            </div>
        `
    };

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log(`[EmailService] 成功發送 ${category} 信件: ${info.messageId}`);
        return info;
    } catch (error) {
        console.error(`[EmailService] 發送信件失敗:`, error);
        throw error;
    }
}

module.exports = {
    sendNotificationEmail
};
