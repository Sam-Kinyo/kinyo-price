function calculateLevelPrice(cost, level, qty) {
    if (!cost) return 0;
    let evalQty = qty > 0 ? qty : 1;
    
    // 靜默數量天花板 (Stealth Quantity Ceiling)
    if (level === 1 && evalQty > 300) evalQty = 300;
    if (level === 2 && evalQty > 500) evalQty = 500;
    if (level === 3 && evalQty > 1000) evalQty = 1000;

    let divisor = 0.73;
    if (level === 1) {
        if (evalQty >= 100) divisor = 0.75;
        else divisor = 0.73;
    } else if (level === 2) {
        if (evalQty >= 500) divisor = 0.82;
        else if (evalQty >= 300) divisor = 0.80;
        else if (evalQty >= 100) divisor = 0.76;
        else divisor = 0.74;
    } else if (level >= 3) {
        if (evalQty >= 3000 && level >= 4) divisor = 0.89;
        else if (evalQty >= 1000) divisor = 0.865;
        else if (evalQty >= 500) divisor = 0.845;
        else if (evalQty >= 300) divisor = 0.825;
        else if (evalQty >= 100) divisor = 0.79;
        else divisor = 0.76;
    }

    return Math.ceil((cost / divisor) * 1.05);
}

module.exports = { calculateLevelPrice };
