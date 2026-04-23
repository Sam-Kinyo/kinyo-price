/**
 * emailSettings.js
 * 存放 #大量訂單 #商品預留 #廠價申請 的寄送對象設定
 */

const emailSettings = {
    '#大量訂單': [
        'crystal.lin@nakay.com.tw',
        'iris@nakay.com.tw',
        'irene.tien@nakay.com.tw',
        'chloe@nakay.com.tw',
        'kelly@nakay.com.tw',
        'din@kinyo.tw',
        'sam.kuo@kinyo.tw'
    ],
    '#商品預留': [
        'chloe@nakay.com.tw',
        'kelly@nakay.com.tw',
        'din@kinyo.tw',
        'sam.kuo@kinyo.tw'
    ],
    '#廠價申請': [
        'crystal.lin@nakay.com.tw',
        'iris@nakay.com.tw',
        'irene.tien@nakay.com.tw',
        'yafen@nakay.com.tw',
        'winnie_yeh@kinyo.tw',
        'alancheng@nakay.com.tw',
        'sam.kuo@kinyo.tw'
    ],
    '#申請廠價': [
        'crystal.lin@nakay.com.tw',
        'iris@nakay.com.tw',
        'irene.tien@nakay.com.tw',
        'yafen@nakay.com.tw',
        'winnie_yeh@kinyo.tw',
        'alancheng@nakay.com.tw',
        'sam.kuo@kinyo.tw'
    ]
};

const SENDER_EMAIL = 'sam.kuo@kinyo.tw';

module.exports = {
    emailSettings,
    SENDER_EMAIL
};
