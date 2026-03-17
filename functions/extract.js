const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, 'index.js');
const targetPath = path.join(__dirname, 'src', 'workflows', 'specialActionWorkflow.js');

let indexContent = fs.readFileSync(indexPath, 'utf8');

const startStr = "if (intentParams.action === 'borrow_sample') {";
const endStr = "continue; // 執行完特殊意圖後跳過後續查詢邏輯";

const startIndex = indexContent.indexOf(startStr);
const endMatchIndex = indexContent.indexOf(endStr, startIndex);

if (startIndex === -1 || endMatchIndex === -1) {
    console.error("Markers not found");
    process.exit(1);
}

// Find the exact } for the batch_order block
const endOfEndStr = endMatchIndex + endStr.length;
// The code right after `continue; ...` is `\n                } else if (intentParams.intent`
// So we just slice up to the `}` right before `else if`.
const sliceEnd = indexContent.indexOf("} else if (intentParams.intent", endOfEndStr);

const extractedBlock = indexContent.substring(startIndex, sliceEnd);

// Wrap it in a function
const newModuleContent = `const { admin, db } = require('../utils/firebase');

async function handleSpecialActions(intentParams, dependencies) {
    const { lineClient, replyToken } = dependencies;
    
    // Extracted logic from index.js
    ${extractedBlock.trim()}
    
    return true; // handled
}

module.exports = { handleSpecialActions };
`;

fs.writeFileSync(targetPath, newModuleContent, 'utf8');

// Replace the block in index.js with the function call
const replacement = `const { handleSpecialActions } = require('./src/workflows/specialActionWorkflow');
                
                const isSpecialAction = ['borrow_sample', 'defective_return', 'batch_order'].includes(intentParams.action);
                if (isSpecialAction) {
                    await handleSpecialActions(intentParams, { lineClient, replyToken });
                    continue; // 執行完特殊意圖後跳過後續查詢邏輯
                `;

indexContent = indexContent.substring(0, startIndex) + replacement + indexContent.substring(sliceEnd);
fs.writeFileSync(indexPath, indexContent, 'utf8');

console.log("Successfully extracted special actions and updated index.js");
