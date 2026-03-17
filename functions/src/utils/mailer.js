const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'sam.kuo@kinyo.tw', // 從先前紀錄取回
        pass: 'ttqv qjjn scyf qfug'
    }
});

module.exports = { transporter };
