function parse(input) {
    const cleaned = String(input).trim()
        .replace(/[＊✕×*]/g, 'x')
        .replace(/[＠]/g, '@')
        .replace(/元整?|NT\$?|\$/gi, '')
        .replace(/[個台組盒支瓶罐袋包片條顆]/g, ' ')
        .replace(/(?<![A-Za-z])pcs?(?![A-Za-z])/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    let m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s*x\s*(\d+)\s*([箱件])?\s*(?:@\s*(\d+))?/i);
    if (m) return { model: m[1].toUpperCase(), qty: +m[2], unit: m[3]||null, price: m[4] ? +m[4] : null, _cleaned: cleaned };
    m = cleaned.match(/^([A-Za-z][A-Za-z0-9\-]+)\s+(\d+)\s*([箱件])?\s*(?:@?\s*(\d+))?/i);
    if (m) return { model: m[1].toUpperCase(), qty: +m[2], unit: m[3]||null, price: m[4] ? +m[4] : null, _cleaned: cleaned };
    return { _cleaned: cleaned, _matched: false };
}
const tests = [
    'kh9660w 5台 1658元',
    'kh9660gy 3台 1658元',
    'KH9660 x5 @100',
    'KH9660 5 100',
    'KH9660 5',
    'KH9660 5 1箱 100',
    'Pco2550 248台 770元',
    'KPB2512BR 10個 320元',
];
for (const t of tests) console.log(JSON.stringify(t).padEnd(30), '=>', JSON.stringify(parse(t)));
