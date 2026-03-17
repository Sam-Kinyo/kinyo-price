const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
let indexContent = fs.readFileSync(indexPath, 'utf8');

const targetStr = "userText = rawUserMessage;";
const injectionStr = `userText = rawUserMessage;

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
                // -----------------------------------`;

indexContent = indexContent.replace(targetStr, injectionStr);
fs.writeFileSync(indexPath, indexContent, 'utf8');
console.log("Injected group ID probe logic.");
