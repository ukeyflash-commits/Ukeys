// mailer-resend.js
const { Resend } = require('resend');

// ================== НАСТРОЙКИ ==================
// Вставьте ключ, который скопировали в панели Resend (начинается с re_)
const API_KEY = '01a19345-39be-7403-b2f0-a010469caaa2';
// ===============================================

const resend = new Resend(API_KEY);

/**
 * Отправка письма через Resend API (HTTPS, порт 443)
 * @param {string|string[]} to - адрес(а) получателя
 * @param {string} subject - тема
 * @param {string} text - текстовая версия
 * @param {string} [html] - HTML версия (опционально)
 */
async function sendEmail(to, subject, text, html = null) {
  const recipients = Array.isArray(to) ? to : [to];

  const payload = {
    // ВАЖНО: Заменили onboarding@resend.dev на ваш верифицированный домен!
    from: 'UKeyFlash <noreply@ukeyflash.ru>',
    to: recipients,
    subject: subject,
    text: text,
  };

  if (html) {
    payload.html = html;
  }

  try {
    const { data, error } = await resend.emails.send(payload);

    if (error) {
      console.error('Ошибка Resend API:', error);
      throw new Error(error.message);
    }

    console.log('Успех! Письмо отправлено. ID:', data.id);
    return data;
  } catch (err) {
    console.error('Критическая ошибка при отправке:', err);
    throw err;
  }
}

module.exports = { sendEmail };
