require('dotenv').config();
const nodemailer = require('nodemailer');

console.log('HOST:', process.env.EMAIL_HOST);
console.log('PORT:', process.env.EMAIL_PORT);
console.log('USER:', process.env.EMAIL_USER);
console.log('PASS length:', (process.env.EMAIL_PASSWORD || '').length);

const t = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: Number(process.env.EMAIL_PORT),
    secure: true,
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASSWORD },
});

t.verify()
  .then(() => console.log('✅ SMTP OK'))
  .catch(e => console.error('❌ SMTP FAIL:', e.message));
