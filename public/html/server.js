
// server.js

require('dotenv').config();

const OpenAI = require('openai');


console.log('🔑 DEEPSEEK_API_KEY loaded?', !!process.env.DEEPSEEK_API_KEY);
const express = require('express');
const nodemailer = require('nodemailer');
const cors = require('cors');
const path = require('path');
const { ChatBot } = require('chatbotlite');//ЧАТ БОТ

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// 📧 НАСТРОЙКИ ПОЧТЫ — ЗАМЕНИТЕ НА СВOИ          13.07.
// ============================================
const EMAIL_CONFIG = {
    // Email, с которого будут отправляться письма
    user: 'ukeyflash@gmail.com',           // ← ЗАМЕНИТЕ!
    // Пароль приложения (не обычный пароль!)
    password: 'pxayebixuenaulwf',           // ← ЗАМЕНИТЕ!
    // Email для получения уведомлений о заказах
    notifyEmail: 'gafarOf@yandex.ru'      // ← ЗАМЕНИТЕ!
};

// Настройка транспорта
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_CONFIG.user,
        pass: EMAIL_CONFIG.password
    }
});
/* ТЕСТ ПОЛУЧЕНИЯ ПОЧТЫ */

// ТЕСТ ОТПРАВКИ (запустите отдельно)
async function testEmail() {
    try {
        await transporter.verify();
        console.log('✅ SMTP подключение работает!');
    } catch (error) {
        console.error('❌ Ошибка SMTP:', error.message);
    }
}

// Вызовите после запуска сервера
testEmail();





// ============================================
// 📝 ОТПРАВКА ПИСЬМА
// ============================================
async function sendOrderEmails(orderData) {
    const { name, email, phone, comment, cart, total } = orderData;

    // Формируем список товаров
    const cartHtml = cart.map(item => `
        <tr>
            <td>${item.name}</td>
            <td style="text-align:center">${item.quantity}</td>
            <td style="text-align:right">${item.price.toLocaleString()} ₽</td>
            <td style="text-align:right">${(item.price * item.quantity).toLocaleString()} ₽</td>
        </tr>
    `).join('');

    const cartText = cart.map(item =>
        `  ${item.name} × ${item.quantity} = ${(item.price * item.quantity).toLocaleString()} ₽`
    ).join('\n');

    // Письмо для клиента
    const clientMailOptions = {
        from: `"UKeys Shop" <${EMAIL_CONFIG.user}>`,
        to: email,
        subject: '✅ Ваш заказ в UKeys подтвержден!',
        html: `
            <h2>✅ Ваш заказ принят!</h2>
            <p>Здравствуйте, <strong>${name}</strong>!</p>
            <p>Спасибо за заказ в магазине <strong>UKeys</strong>.</p>

            <h3>📦 Состав заказа:</h3>
            <table style="width:100%; border-collapse:collapse;">
                <tr style="background:#667eea; color:white;">
                    <th style="padding:8px; text-align:left;">Товар</th>
                    <th style="padding:8px;">Кол-во</th>
                    <th style="padding:8px; text-align:right;">Цена</th>
                    <th style="padding:8px; text-align:right;">Сумма</th>
                </tr>
                ${cartHtml}
                <tr style="font-weight:bold; font-size:18px;">
                    <td colspan="3" style="text-align:right; padding:12px;">Итого:</td>
                    <td style="text-align:right; padding:12px; color:#28a745;">${total.toLocaleString()} ₽</td>
                </tr>
            </table>

            <h3>📞 Контактные данные:</h3>
            <p><strong>Телефон:</strong> ${phone}</p>
            ${comment ? `<p><strong>Комментарий:</strong> ${comment}</p>` : ''}

            <hr style="margin:20px 0;">
            <p style="color:#666; font-size:14px;">
                Мы свяжемся с вами для подтверждения заказа.<br>
                С уважением, команда UKeys ❤️
            </p>
        `,
        text: `
            ✅ Ваш заказ в UKeys подтвержден!

            Здравствуйте, ${name}!
            Спасибо за заказ в магазине UKeys.

            📦 Состав заказа:
            ${cartText}

            Итого: ${total.toLocaleString()} ₽

            📞 Контактные данные:
            Телефон: ${phone}
            ${comment ? `Комментарий: ${comment}` : ''}

            Мы свяжемся с вами для подтверждения заказа.
            С уважением, команда UKeys ❤️
        `
    };

    // Письмо для администратора
    const adminMailOptions = {
        from: `"UKeys Shop" <${EMAIL_CONFIG.user}>`,
        to: EMAIL_CONFIG.notifyEmail,
        subject: `🛒 НОВЫЙ ЗАКАЗ от ${name} | UKeys`,
        html: `
            <h2>🛒 НОВЫЙ ЗАКАЗ</h2>
            <p><strong>От:</strong> ${name}</p>
            <p><strong>Телефон:</strong> ${phone}</p>
            <p><strong>Email:</strong> ${email}</p>
            ${comment ? `<p><strong>Комментарий:</strong> ${comment}</p>` : ''}

            <h3>📦 Состав заказа:</h3>
            <table style="width:100%; border-collapse:collapse;">
                <tr style="background:#667eea; color:white;">
                    <th style="padding:8px; text-align:left;">Товар</th>
                    <th style="padding:8px;">Кол-во</th>
                    <th style="padding:8px; text-align:right;">Цена</th>
                    <th style="padding:8px; text-align:right;">Сумма</th>
                </tr>
                ${cartHtml}
                <tr style="font-weight:bold; font-size:18px;">
                    <td colspan="3" style="text-align:right; padding:12px;">Итого:</td>
                    <td style="text-align:right; padding:12px; color:#28a745;">${total.toLocaleString()} ₽</td>
                </tr>
            </table>
        `,
        text: `
            🛒 НОВЫЙ ЗАКАЗ от ${name}

            От: ${name}
            Телефон: ${phone}
            Email: ${email}
            ${comment ? `Комментарий: ${comment}` : ''}

            Состав заказа:
            ${cartText}

            Итого: ${total.toLocaleString()} ₽
        `
    };

    // Отправляем оба письма
    await transporter.sendMail(clientMailOptions);
    await transporter.sendMail(adminMailOptions);
}

// ============================================
// 📡 API ЭНДПОИНТЫ
// ============================================

// Информация о товарах
app.get('/api/info', (req, res) => {
    res.json({
        products: [
            { name: "Ukey Windows PE", price: 1200 },
            { name: "Ukey Kali Linux", price: 1500 },
            { name: "Ukey Windows PE Pro", price: 1800 }
        ]
    });
});

// Обработка заказа
app.post('/api/order', async (req, res) => {
    try {
        const orderData = req.body;

        // Проверка данных
        if (!orderData.name || !orderData.email || !orderData.phone) {
            return res.status(400).json({ message: 'Заполните все обязательные поля' });
        }

        if (!orderData.cart || orderData.cart.length === 0) {
            return res.status(400).json({ message: 'Корзина пуста' });
        }

        // Отправляем письма
        await sendOrderEmails(orderData);

        console.log('📦 Заказ получен:', orderData);
        res.json({
            success: true,
            message: 'Заказ успешно отправлен! Проверьте вашу почту.'
        });

    } catch (error) {
        console.error('❌ Ошибка:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка при отправке заказа. Попробуйте позже.'
        });
    }
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📧 Уведомления будут приходить на ${EMAIL_CONFIG.notifyEmail}`);
    console.log(`📨 Письма отправляются с ${EMAIL_CONFIG.user}`);
});

// 3. Чат-бот (DeepSeek)
app.post('/api/chat', async (req, res) => {
    try{
        const { message,transcript } = req.body;
        const stream = await bot.replyStream(message, { history: transcript || [] });
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        stream.pipe(res);
    } catch (error) {
        console.error('❌ Ошибка чат-бота:', error);
        res.status(500).json({ error: 'Ошибка сервера при обработке запроса чата' });
    }
});
//ИЛЬДАР 22.08 правки не работает чат бот

// app.post('/api/chat', async (req, res) => {
//     try {
//         const { message, transcript = [] } = req.body;

//         const deepseek = new OpenAI({
//             apiKey: process.env.DEEPSEEK_API_KEY,
//             baseURL: 'https://api.deepseek.com/v1',
//         });

//         const response = await deepseek.chat.completions.create({
//             model: 'deepseek-chat',
//             messages: [
//                 { role: 'system', content: 'Ты консультант магазина UKeys. Отвечай вежливо и по делу.' },
//                 ...transcript, // если передаёте историю
//                 { role: 'user', content: message }
//             ],
//             stream: false,
//         });

//         res.json({ reply: response.choices[0].message.content });
//     } catch (error) {
//         console.error('❌ Ошибка DeepSeek:', error.response?.data || error.message);
//         res.status(500).json({ error: 'Ошибка при обращении к DeepSeek API' });
//     }
// });


// ============================================
// 🤖 НАСТРОЙКА ЧАТ-БОТА (DeepSeek)
// ============================================
const bot = new ChatBot({
    providers: {
        keys: {
            deepseek: process.env.DEEPSEEK_API_KEY
        }
    },
    chain: [
        { provider: 'deepseek', model: 'deepseek-chat' }
    ],
    systemPrompt: 'Вы — консультант магазина UKeys. Отвечайте вежливо и по делу.',
    knowledge: '# Магазин UKeys\nМы продаём ключи для активации программного обеспечения.\n\n## Товары\n- Ukey Windows PE — 1200 ₽\n- Ukey Kali Linux — 1500 ₽\n- Ukey Windows PE Pro — 1800 ₽\n\n## Контакты\nТелефон:\nEmail: ukeyflash@gmail.com'
});
