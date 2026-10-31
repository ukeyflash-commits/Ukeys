// test-resend.js
const { sendEmail } = require('./mailer-resend');

(async () => {
  console.log('Запуск теста отправки через Resend...');

  try {
    await sendEmail(
      'ukeyflash@gmail.com', // Укажите ваш реальный email
      'Тест: Письмо с нового домена',
      'Это тестовое письмо. Если вы его видите, значит Resend настроен верно, а блокировки Selectel обойдены.',
      '<h1>Ура! Все работает.</h1><p>Домен <b>ukeyflash.ru</b> успешно верифицирован.</p>'
    );
    console.log('Тестовый скрипт завершен.');
  } catch (err) {
    console.error('Тест не пройден:', err.message);
    process.exit(1);
  }
})();
