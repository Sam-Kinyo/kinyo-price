const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
let content = fs.readFileSync(indexPath, 'utf8');

const startMarker = `throw new Error('SILENT_IGNORE'); // 中斷處理但不回傳訊息`;
const endMarker = `// --- 額外處理：訂單模板回覆 ---`;

const startIndex = content.indexOf(startMarker);
if (startIndex === -1) {
    console.error("Start Marker not found!");
    process.exit(1);
}

// 找尋對應的 closing bracket
const searchStart = startIndex + startMarker.length;
const nextBracket = content.indexOf('}', searchStart);
if (nextBracket === -1) {
    console.error("Next bracket not found!");
    process.exit(1);
}

const endIndex = content.indexOf(endMarker);
if (endIndex === -1) {
    console.error("End Marker not found!");
    process.exit(1);
}

const replacement = `
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '⛔ 此群組尚未綁定報價權限。' }]
                        });
                        throw new Error('PERMISSION_DENIED');
                    }
                } else {
                    // 2. 私訊環境：查驗 Users 集合 (出了群組就失去庇護)
                    const userSnapshot = await db.collection('Users').where('line_uid', '==', lineUid).limit(1).get();
                    if (!userSnapshot.empty) {
                        const userDocData = userSnapshot.docs[0].data();
                        userEmail = userSnapshot.docs[0].id; // 取得使用者的 Email 或是 doc ID
                        if (userDocData.level) {
                            realLevel = parseInt(userDocData.level) || 0;
                            level = parseInt(userDocData.currentViewLevel) || realLevel;
                            isVip = !!userDocData.vipColumn;
                            currentViewLevel = level;

                            if (realLevel < 1 && !isVip) {
                                await lineClient.replyMessage({
                                    replyToken: replyToken,
                                    messages: [{ type: 'text', text: '⛔ 您的個人帳號尚未開通報價權限，請聯繫業務申請。' }]
                                });
                                throw new Error('PERMISSION_DENIED');
                            }
                        } else {
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '⛔ 您的個人帳號尚未開通報價權限，請聯繫業務申請。' }]
                            });
                            throw new Error('PERMISSION_DENIED');
                        }
                    } else {
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '尚未綁定帳號或無查詢權限，請透過系統選單進行綁定。' }]
                        });
                        throw new Error('PERMISSION_DENIED');
                    }
                }
            }

            try {
                // --- 例外處理：優先放行管理員的 #綁定群組 指令，避免陷入死結 ---
                if (event.type === 'message' && event.message.type === 'text') {
                    const text = event.message.text.trim();
                    if (isGroup && text.includes('@KINYO挺好的') && (text.includes('#綁定群組') || text.includes('#解除綁定'))) {
                        // 交給後續既有的綁定 / 解除邏輯處理，此處直接略過全域權限阻擋
                    } else {
                        // --- 核心全域權限防線啟動 ---
                        await verifyGlobalPermission();
                    }
                } else if (event.type === 'postback') {
                    await verifyGlobalPermission();
                }
            } catch (e) {
                if (e.message === 'SILENT_IGNORE' || e.message === 'PERMISSION_DENIED') {
                    continue; // 捕獲自定義權限異常，結束此 event 的處理
                }
                console.error('[全域權限驗證]', e);
                continue;
            }

            if (event.type === 'message' && event.message.type === 'text') {
                const rawUserMessage = event.message.text.trim();
                userText = rawUserMessage;

                // --- 新增：取得來源 ID 探測指令 ---
                if (rawUserMessage === '@KINYO挺好的 取群組ID') {
                    const sourceId = event.source.groupId || event.source.roomId || event.source.userId;
                    await lineClient.replyMessage({
                        replyToken: replyToken,
                        messages: [{
                            type: 'text',
                            text: \`[系統管理員資訊]\\n此來源的 ID 為：\\n\${sourceId}\`
                        }]
                    });
                    continue;
                }
                // -----------------------------------

                if (isGroup) {
                    const botName = '@KINYO挺好的';
                    const isBotTag = rawUserMessage.startsWith(botName);

                    // --- 新增：靜態關鍵字攔截 (維修/客服) ---
                    if (isBotTag && (rawUserMessage.includes('維修') || rawUserMessage.includes('客服'))) {
                        const repairFlex = {
                            type: 'flex',
                            altText: '產品維修與寄件指南',
                            contents: {
                                type: 'bubble',
                                size: 'mega',
                                header: {
                                    type: 'box',
                                    layout: 'vertical',
                                    backgroundColor: '#E11D48',
                                    contents: [
                                        { type: 'text', text: '🛠️ 產品維修與寄件指南', color: '#ffffff', weight: 'bold', size: 'lg' }
                                    ]
                                },
                                body: {
                                    type: 'box',
                                    layout: 'vertical',
                                    spacing: 'md',
                                    contents: [
                                        { type: 'text', text: '本公司商品享有一年保固。請將商品寄回本公司維修部，修復後我們將為您寄回。', wrap: true, size: 'sm', color: '#333333' },
                                        { type: 'separator', margin: 'md' },
                                        { type: 'text', text: '📍 寄送資訊', weight: 'bold', size: 'sm', color: '#111111', margin: 'md' },
                                        { type: 'text', text: '收件人：耐嘉維修部\\n電話：03-5396627\\n地址：300新竹市東區經國路一段187號', wrap: true, size: 'sm', color: '#666666' },
                                        { type: 'separator', margin: 'md' },
                                        { type: 'text', text: '📦 包裹內請務必附上紙條註明：', weight: 'bold', size: 'sm', color: '#E11D48', margin: 'md' },
                                        { type: 'text', text: '1. 故障原因\\n2. 聯絡人姓名與電話\\n3. 寄回地址\\n4. 購買證明 (發票或收據)', wrap: true, size: 'sm', color: '#666666' },
                                        { type: 'separator', margin: 'md' },
                                        { type: 'text', text: '📞 使用問題詢問：03-5396627\\n📱 線上客服 LINE ID：@kinyo', wrap: true, size: 'xs', color: '#999999', margin: 'md' }
                                    ]
                                }
                            }
                        };
                        await lineClient.replyMessage({ replyToken: replyToken, messages: [repairFlex] });
                        continue;
                    }
                    // -----------------------------------------

                    // 若沒有標記機器人，直接略過
                    if (!isBotTag) continue;

                    // 拔除標記詞，留下乾淨的指令
                    userText = rawUserMessage.replace(botName, '').trim();

                    // 處理綁定指令
                    if (userText.startsWith('#綁定群組')) {
                        const adminUid = 'U7043cd6c4576c96ddb23d316fba32a9b'; // 郭庭豪的 LINE UID

                        // 權限攔截防線
                        if (lineUid !== adminUid) {
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此變更' }]
                            });
                            continue;
                        }

                        const targetLevel = parseInt(userText.replace('#綁定群組', '').trim(), 10);
                        if (!isNaN(targetLevel)) {
                            await db.collection('Groups').doc(groupId).set({ level: targetLevel });
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: \`✅ 本群組已綁定 Level \${targetLevel}\` }]
                            });
                        }
                        continue;
                    }

                    // 處理解除綁定指令
                    if (userText.startsWith('#解除綁定')) {
                        const adminUid = 'U7043cd6c4576c96ddb23d316fba32a9b'; // 郭庭豪的 LINE UID

                        if (lineUid !== adminUid) {
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此變更' }]
                            });
                            continue;
                        }

                        // 將群組的權限記錄刪除
                        await db.collection('Groups').doc(groupId).delete();
                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '✅ 本群組已成功解除報價權限綁定。' }]
                        });
                        continue;
                    }

                    // 處理接單總部設定指令
                    if (userText.startsWith('#設定為接單總部')) {
                        const adminUid = 'U7043cd6c4576c96ddb23d316fba32a9b';
                        if (lineUid !== adminUid) {
                            await lineClient.replyMessage({
                                replyToken: replyToken,
                                messages: [{ type: 'text', text: '⛔ 權限不足：僅限系統管理員執行此設定' }]
                            });
                            continue;
                        }

                        // 將群組 ID 寫入系統設定表
                        await db.collection('SystemConfig').doc('OrderSettings').set({
                            notifyGroupId: groupId,
                            updatedAt: admin.firestore.FieldValue.serverTimestamp()
                        }, { merge: true });

                        await lineClient.replyMessage({
                            replyToken: replyToken,
                            messages: [{ type: 'text', text: '✅ 已將本群組設定為【接單總部】\\n未來新訂單將同步推播至此。' }]
                        });
                        continue;
                    }
                }

                `;

const newContent = content.substring(0, nextBracket + 1) + replacement + content.substring(endIndex);

fs.writeFileSync(indexPath, newContent, 'utf8');
console.log("Repair 2 completed successfully.");
