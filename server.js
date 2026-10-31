/**
 * ============================================================
 *BISMILLYAHI!!!  
*UKEYS SHOP — SERVER
 *  Версия: 2.1.0 (исправленная gim!)
 *  Дата: 2026-XX-XX
 * ------------------------------------------------------------
 *  Robokassa ВРЕМЕННО ОТКЛЮЧЕНА (заглушка оплаты).
 *  - Заказ создаётся и сохраняется в БД (НЕ удаляется).
 *  - Письма клиенту и админу отправляются сразу (QR для оплаты).
 *  - После оплаты админ прикрепляет DropMeFiles-ссылку через
 *    /api/admin/attach-link → checkPaidOrders() отправит письмо.
 * 26.10.2026
 * ---настроена отправка писем и добавление
 *
 *
 *
 *
 *
 *
 *  ЗАВИСИМОСТИ (package.json):
 *    express, nodemailer, cors, dotenv,
 *    better-sqlite3, openai
 *   (@robokassa/sdk — когда вернём оплату)
 * ============================================================
 */

// ------------------------------------------------------------
// 0. ЗАГРУЗКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ
// ------------------------------------------------------------
require('dotenv').config();

// ------------------------------------------------------------
// 1. ИМПОРТ БИБЛИОТЕК
// ------------------------------------------------------------
const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const crypto     = require('crypto');
const Database   = require('better-sqlite3');
const OpenAI     = require('openai');
//НОВЫЙ МОДУЛЬ ДЛЯ отправки ПИСЕМ
const { sendEmail } = require('./mailer-resend');

//ДОБАВЛЕНИЕ ЗАЩИТЫ АДМИН ПАНЕЛИ admin.html
//




// ------------------------------------------------------------
// 1.5. ДИАГНОСТИКА ПЕРЕМЕННЫХ ОКРУЖЕНИЯ
// ------------------------------------------------------------
console.log('🔍 [ENV] EMAIL_PASSWORD задан:', !!process.env.EMAIL_PASSWORD);
console.log('🔍 [ENV] PORT:', process.env.PORT || '(по умолчанию 3000)');
console.log('🔍 [ENV] AI_API_KEY задан:', !!process.env.AI_API_KEY);
console.log('🔍 [ENV] AI_BASE_URL:', process.env.AI_BASE_URL || '(по умолчанию OpenAI)');
console.log('🔍 [ENV] .env путь:', path.join(__dirname, '.env'), '| существует:', fs.existsSync(path.join(__dirname, '.env')));

// ------------------------------------------------------------
// 2. ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ
// ------------------------------------------------------------
const app  = express();
const PORT = process.env.PORT || 3000;

// ------------------------------------------------------------
// 3. MIDDLEWARE
// ------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ------------------------------------------------------------
// 3.5. КОНСТАНТЫ
// ------------------------------------------------------------
const DOWNLOAD_LINK_TTL_DAYS = 7; // единый срок: токен = письмо = проверка в checkPaidOrders
// ── Basic Auth для админки ────────────────────────────────
// ── Basic Auth для админки ────────────────добавил  ночью────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'admin';

let ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) {
    // dev-пароль разрешён ТОЛЬКО если явно сказали "я разработчик"
    if (process.env.ALLOW_DEV_PASS === 'yes') {
        ADMIN_PASS = 'ChangeMe123';
        console.warn('⚠️  DEV-режим: используется ChangeMe123. НЕ для продакшена!');
    } else {
        throw new Error('ADMIN_PASS не задан в окружении! Приложение остановлено.');
    }
}

function checkAuth(req, res, next) {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Basic ')) {
        res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
        return res.status(401).send('Требуется авторизация');
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const idx = decoded.indexOf(':');
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="Admin Area"');
    return res.status(401).send('Неверный логин или пароль');
}

// все /api/admin/* под Basic Auth 26.10
app.use('/api/admin', checkAuth);

// страница админки тоже под Basic Auth (файл вне public/)26.10
app.get('/admin', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});








// ------------------------------------------------------------
// 4. ХРАНИЛИЩЕ ФАЙЛОВ ДЛЯ СКАЧИВАНИЯ
// ------------------------------------------------------------
const FILES_DIR = path.join(__dirname, 'private_files');
if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR);
    console.log('📁 [v2.1.0] Создана папка для файлов:', FILES_DIR);
}

// ------------------------------------------------------------
// 5. БАЗА ДАННЫХ SQLITE
// ------------------------------------------------------------
const db = new Database(path.join(__dirname, 'ukey.db'));
db.pragma('journal_mode = WAL');

// 5.1. Базовые таблицы
db.exec(`
    CREATE TABLE IF NOT EXISTS pending_orders (
        inv_id      INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        email       TEXT NOT NULL,
        phone       TEXT NOT NULL,
        comment     TEXT,
        cart_json   TEXT NOT NULL,
        total       REAL NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS download_tokens (
        token       TEXT PRIMARY KEY,
        file_name   TEXT NOT NULL,
        expires_at  INTEGER NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
CREATE TABLE IF NOT EXISTS file_links (
id INTEGER PRIMARY KEY AUTOINCREMENT ,
inv_id INTEGER ,
url TEXT UNIQUE NOT NULL ,
created_at DATETIME DEFAULT CURRENT_TIMESTAMP ,
sent_at DATETIME
);
`);

// 5.2. Миграция
const pendingCols = db.prepare(`PRAGMA table_info(pending_orders)`).all().map(c => c.name);
console.log('🗄️ Текущие колонки pending_orders:', pendingCols.join(', '));

const addPendingCol = (name, def) => {
    if (!pendingCols.includes(name)) {
        db.exec(`ALTER TABLE pending_orders ADD COLUMN ${name} ${def}`);
        console.log(`🛠️ Добавлена колонка pending_orders.${name}`);
    } else {
        console.log(`✔️ Колонка pending_orders.${name} уже есть`);
    }
};
addPendingCol('status',          "TEXT DEFAULT 'ожидает'");
addPendingCol('file_url',        'TEXT');
addPendingCol('file_created_at', 'TEXT');
addPendingCol('sent_to_client',  'INTEGER DEFAULT 0');

console.log('🗄️ [v2.1.0] База данных SQLite подключена.');

// ------------------------------------------------------------
// 6. ROBOKASSA — ОТКЛЮЧЕНА
// ------------------------------------------------------------
let robokassa = null;
console.log('💳 [v2.1.0] Robokassa ОТКЛЮЧЕНА (ЗАГЛУШКА ОПЛАТЫ)');

// ------------------------------------------------------------
// 7. ИИ-КЛИЕНТ
// ------------------------------------------------------------
const aiClient = new OpenAI({
    apiKey:  process.env.AI_API_KEY  || 'dummy-key',
    baseURL: process.env.AI_BASE_URL || 'https://api.openai.com/v1',
});

const SYSTEM_PROMPT = `Вы — вежливый и опытный консультант магазина UKeys.
Помогайте клиентам с выбором загрузочных флешек для спасения данных и восстановления систем.
Отвечайте кратко, по делу, с лёгким дружелюбным тоном.

# Информация о магазине
Мы продаём готовые решения для восстановления систем и спасения данных.

## Товары
- Ukey Windows PE — 1500 ₽ (восстановление Windows, сброс паролей, тесты памяти)
- Ukey Kali Linux — 2500 ₽ (пентест, восстановление данных, проверка безопасности сети)
- Ukey Windows PE Pro — 2000 ₽ (расширенный набор: глубокое восстановление файлов, антивирусные сканеры, UEFI)

## Контакты
Email: ukeyflash@gmail.com

# Правила ответа
1. Потеря данных — предложи Windows PE или Pro.
2. Проверка безопасности сети — предложи Kali Linux.
3. Уточняй ОС клиента (Windows/Mac) и суть проблемы.
4. Не выдумывай функции, которых нет в описании товаров.`;

// ------------------------------------------------------------
// 8. ПОЧТА
// ------------------------------------------------------------
const EMAIL_CONFIG = {
    user:        'ukeyflash@gmail.com',
    password:    process.env.EMAIL_PASSWORD,
    notifyEmail: process.env.NOTIFY_EMAIL || 'gafarOf@yandex.ru',
};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_CONFIG.user,
        pass: EMAIL_CONFIG.password,
    },
});

async function testEmail() {
    try {
        await transporter.verify();
        console.log('✅ [v2.1.0] SMTP подключение работает!');
    } catch (error) {
        console.error('❌ [v2.1.0] Ошибка SMTP:', error.message);
    }
}

// ------------------------------------------------------------
// 8.1. ОТПРАВКА ССЫЛКИ КЛИЕНТУ (после оплаты)
// ------------------------------------------------------------
async function sendFileToClient(order) {
    try {
        // ── Письмо КЛИЕНТУ ─────────────────────────────────────
        const clientMailOptions = {
            from:    `"UKeys Shop" <${EMAIL_CONFIG.user}>`,
            to:      order.email,
            subject: `Ваш заказ №${order.inv_id} оплачен`,
            text:
                `Здравствуйте, ${order.name}!\n\n` +
                `Ваш заказ на сумму ${Number(order.total).toLocaleString('ru-RU')} ₽ успешно оплачен.\n\n` +
                `Ссылка на скачивание (DropMeFiles):\n${order.file_url}\n\n` +
                `Скачайте файл сразу: срок хранения на DropMeFiles ограничен ` +
                `(мы гарантируем актуальность ссылки ${DOWNLOAD_LINK_TTL_DAYS} дней).\n\n` +
                `С уважением, команда UKeys.`,
        };

        await transporter.sendMail(clientMailOptions);
        console.log(`✅ [Заказ №${order.inv_id}] Ссылка отправлена клиенту на ${order.email}`);

        // ── Письмо АДМИНУ (копия) ──────────────────────────────
        const adminOptions = {
            from:    `"UKey Shop" <${EMAIL_CONFIG.user}>`,
            to:      EMAIL_CONFIG.notifyEmail,
            subject: `Копия: Ссылка отправлена (Заказ №${order.inv_id})`,
            text:    `Клиенту ${order.name} (${order.email}) отправлена ссылка: ${order.file_url}`,
        };

        await transporter.sendMail(adminOptions);
        console.log(`✅ [Заказ №${order.inv_id}] Уведомление админу отправлено.`);

    } catch (error) {
        console.error(`❌ Ошибка при отправке письма для заказа №${order.inv_id}:`, error.message);
        throw error; // статус не меняется на «отправлен»
    }
}

// ------------------------------------------------------------
// 8.2. ПРОВЕРКА БАЗЫ (ТАЙМЕР): оплачен → отправлен
// ------------------------------------------------------------
let __checkingPaidOrders = false;
async function checkPaidOrders() {
    if (__checkingPaidOrders) {
        console.log('⏭️  checkPaidOrders уже выполняется — пропуск тика');
        return;
    }
    __checkingPaidOrders = true;
    try {
        // 1. Ищем заказы: статус='оплачен', ещё не отправлен
        const orders = db.prepare(`
            SELECT * FROM pending_orders
            WHERE status = 'оплачен' AND sent_to_client = 0
        `).all();

        if (orders.length === 0) return;

        // 2. Проходим по каждому
        for (const order of orders) {
            if (!order.file_url || !order.file_created_at) {
                console.log(`❌ Заказ №${order.inv_id} оплачен, но ссылка не прикреплена!`);
                continue;
            }

            // 3. Проверяем срок давности ссылки
            const linkDate = new Date(order.file_created_at);
            if (!linkDate || isNaN(linkDate.getTime())) {
                console.log(`❌ Заказ №${order.inv_id}: некорректный file_created_at`);
                continue;
            }
            const now      = new Date();
            const diffDays = (now - linkDate) / (1000 * 60 * 60 * 24);

            if (diffDays > DOWNLOAD_LINK_TTL_DAYS) {
                console.log(`❌ Заказ №${order.inv_id}: ссылка просрочена (${Math.floor(diffDays)} дн.). Нужно обновить file_url!`);
                continue;
            }

            // 4. Атомарно захватываем заказ, чтобы не отправить дважды
            const claim = db.prepare(`
                UPDATE pending_orders
                SET status = 'отправляется'
                WHERE inv_id = ? AND status = 'оплачен' AND sent_to_client = 0
            `).run(order.inv_id);
            if (claim.changes !== 1) {
                console.log(`⏭️  Заказ #${order.inv_id} уже кем-то захвачен — пропуск`);
                continue;
            }

            // 5. Отправляем письмо
            try {
                await sendFileToClient(order);
            } catch (e) {
                // откатываем статус, чтобы попробовать снова на следующем тике
                db.prepare(`
                    UPDATE pending_orders SET status = 'оплачен' WHERE inv_id = ?
                `).run(order.inv_id);
                throw e;
            }

            // 6. Помечаем как отправленный
            db.prepare(`
                UPDATE pending_orders
                SET status = 'отправлен', sent_to_client = 1
                WHERE inv_id = ?
            `).run(order.inv_id);

//Помечаем ссылку как использованную
        db.prepare(`
               UPDATE file_links
               SET sent_at = CURRENT_TIMESTAMP
               WHERE url = ?
`).run(order.file_url);

            console.log(`✅ [Заказ №${order.inv_id}] обработан и помечен как отправленный.`);
        }
    } catch (err) {
        console.error('Ошибка при проверке оплаченных заказов:', err.message);
    } finally {
        __checkingPaidOrders = false;
    }
}

// ------------------------------------------------------------
// 9. ТОКЕНЫ ДЛЯ СКАЧИВАНИЯ (резерв — сейчас не используется)
// ------------------------------------------------------------
function generateDownloadToken(fileName) {
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + DOWNLOAD_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO download_tokens (token, file_name, expires_at) VALUES (?, ?, ?)')
      .run(token, fileName, expiresAt);
    return token;
}

function cleanExpiredTokens() {
    const info = db.prepare('DELETE FROM download_tokens WHERE expires_at < ?').run(Date.now());
    if (info.changes > 0) console.log(`🧹 [v2.1.0] Очищено ${info.changes} просроченных токенов.`);
}
setInterval(cleanExpiredTokens, 60 * 60 * 1000);

// ------------------------------------------------------------
// 10. ОТПРАВКА ПИСЕМ ПРИ СОЗДАНИИ ЗАКАЗА
// ------------------------------------------------------------
async function sendOrderEmails(orderData) {
    const { name, email, phone, comment, cart, total } = orderData;

    const totalNum = Number(total) || 0;

    if (!Array.isArray(cart) || cart.length === 0) {
        throw new Error('Корзина пуста или имеет неверный формат');
    }
    const safeCart = cart.map(item => ({
        name:     String(item.name || 'Товар'),
        price:    Number(item.price) || 0,
        quantity: Number(item.quantity) || 1,
    }));

    const cartHtml = safeCart.map(item => `
        <tr>
            <td style="padding: 8px; border-bottom: 1px solid #eee;">${item.name}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">${item.quantity}</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${item.price.toLocaleString('ru-RU')} ₽</td>
            <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right;">${(item.price * item.quantity).toLocaleString('ru-RU')} ₽</td>
        </tr>
    `).join('');

    const qrPath = path.join(__dirname, 'public', 'qr.png');
    const hasQr  = fs.existsSync(qrPath);
    if (!hasQr) {
        console.warn('⚠️ [v2.1.0] Файл public/qr.png не найден — письмо уйдёт без QR-кода.');
    }

    const clientMailOptions = {
        from: `"UKeys Shop" <${EMAIL_CONFIG.user}>`,
        to: email,
        subject: '✅ Благодарим за ваш заказ!',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                <h2 style="color: #28a745;">✅ Для оплаты отсканируйте QR-код!</h2>
                <p>Здравствуйте, <strong>${name}</strong>!</p>
                <p>Спасибо вам за заказ <strong>UKeys</strong>. Сумма к оплате: <strong>${totalNum.toLocaleString('ru-RU')} ₽</strong>.</p>

                ${hasQr ? `
                <div style="text-align: center; margin: 30px 0;">
                    <img src="cid:qr-code-image" alt="QR код для оплаты"
                         style="width: 250px; height: 250px; border: 1px solid #ccc; padding: 10px; border-radius: 10px;" />
                    <p style="font-size: 14px; color: #666;">
                        Отсканируйте код в приложении банка и введите сумму
                        <strong>${totalNum.toLocaleString('ru-RU')} ₽</strong>
                    </p>
                </div>` : `
                <p style="color:#c00;">QR-код временно недоступен. Мы свяжемся с вами для оплаты.</p>`}

                <h3>📦 Состав заказа:</h3>
                <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
                    <tr style="background: #667eea; color: white;">
                        <th style="padding: 10px; text-align: left;">Товар</th>
                        <th style="padding: 10px; text-align: center;">Кол-во</th>
                        <th style="padding: 10px; text-align: right;">Цена</th>
                        <th style="padding: 10px; text-align: right;">Сумма</th>
                    </tr>
                    ${cartHtml}
                    <tr style="font-weight: bold; font-size: 18px; background: #f9f9f9;">
                        <td colspan="3" style="text-align: right; padding: 12px;">Итого:</td>
                        <td style="text-align: right; padding: 12px; color: #28a745;">${totalNum.toLocaleString('ru-RU')} ₽</td>
                    </tr>
                </table>

                <h3>📞 Контактные данные:</h3>
                <p><strong>Телефон:</strong> ${phone}</p>
                ${comment ? `<p><strong>Комментарий:</strong> ${comment}</p>` : ''}

                <hr style="margin: 20px 0; border: none; border-top: 1px solid #eee;">
                <p style="color: #666; font-size: 14px;">
                    Сразу после оплаты вы получите письмо с ссылкой на скачивание.<br>
                    С уважением, команда UKeys ❤️
                </p>
            </div>
        `,
        text: `✅ Благодарим за ваш заказ!\n\nЗдравствуйте, ${name}!\n\n` +
              (hasQr ? 'Для оплаты отсканируйте QR-код в письме.\n' : '') +
              `Сумма к оплате: ${totalNum.toLocaleString('ru-RU')} ₽\n\nТелефон: ${phone}`,
        attachments: hasQr ? [{
            filename: 'qr.png',
            path: qrPath,
            cid: 'qr-code-image',
        }] : [],
    };

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
                    <th style="padding:8px; text-align:center;">Кол-во</th>
                    <th style="padding:8px; text-align:right;">Цена</th>
                    <th style="padding:8px; text-align:right;">Сумма</th>
                </tr>
                ${cartHtml}
                <tr style="font-weight:bold; font-size:18px;">
                    <td colspan="3" style="text-align:right; padding:12px;">Итого:</td>
                    <td style="text-align:right; padding:12px; color:#28a745;">${totalNum.toLocaleString('ru-RU')} ₽</td>
                </tr>
            </table>
        `,
        text: `🛒 НОВЫЙ ЗАКАЗ от ${name}\n\nТелефон: ${phone}\nEmail: ${email}\n\nИтого: ${totalNum.toLocaleString('ru-RU')} ₽`,
    };

    await transporter.sendMail(clientMailOptions);
    await transporter.sendMail(adminMailOptions);
    console.log(`📧 [v2.1.0] Письма по заказу отправлены на ${email} и ${EMAIL_CONFIG.notifyEmail}`);
}

// ------------------------------------------------------------
// 11. API ЭНДПОИНТЫ
// ------------------------------------------------------------

// 11.1 Список товаров
app.get('/api/info', (req, res) => {
    res.json({
        products: [
            { name: 'Ukey Windows PE',     price: 500, file: 'ukey_winpe.iso', video:'../img/key1.mp4'   },
            { name: 'Ukey Kali Linux',     price: 1000, file: 'ukey_kali.iso', video:'../img/kali.mp4'    },
            { name: 'Ukey Windows PE Pro', price: 2500, file: 'ukey_winpe_pro.iso',video:'../img/nindza.mp4' },
        ],
    });
});

// 11.2 Создание заказа (Robokassa отключена — заказ НЕ удаляется)
app.post('/api/order', async (req, res) => {
    try {
        const { name, email, phone, comment, cart, total } = req.body;

        if (!name || !email || !phone || !Array.isArray(cart) || cart.length === 0) {
            return res.status(400).json({ message: 'Заполните все поля и корзину' });
        }

        let totalNum = Number(total);
        if (!Number.isFinite(totalNum) || totalNum <= 0) {
            totalNum = cart.reduce(
                (sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 1),
                0
            );
        }
        if (totalNum <= 0) {
            return res.status(400).json({ message: 'Некорректная сумма заказа' });
        }

        const invId = Date.now();

        db.prepare(`
            INSERT INTO pending_orders (inv_id, name, email, phone, comment, cart_json, total)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(invId, name, email, phone, comment || null, JSON.stringify(cart), totalNum);

        console.log('ДАННЫЕ ДЛЯ БАЗЫ:', invId, name, email, phone, totalNum);
        console.log(`📝 [v2.1.0] Заказ #${invId} сохранён в БД. Сумма: ${totalNum} ₽`);

        const orderData = {
            name,
            email,
            phone,
            comment,
            cart,
            total:   totalNum,
            baseUrl: `${req.protocol}://${req.get('host')}`,
        };

        try {
            await sendOrderEmails(orderData);
            console.log(`✅ [v2.1.0] Письма по заказу #${invId} отправлены (QR клиенту).`);
        } catch (mailErr) {
            console.error('❌ [v2.1.0] Ошибка отправки писем:', mailErr.message);
            return res.status(500).json({
                success: false,
                message: 'Заказ создан, но письмо не отправлено. Проверьте EMAIL_PASSWORD.',
            });
        }

        // Заказ НЕ удаляем — он ждёт подтверждения оплаты.
        // После /api/admin/attach-link получит status='оплачен'
        // и checkPaidOrders() отправит клиенту ссылку.

        const paymentUrl = `/?paid=1&invId=${invId}`;
        res.json({ success: true, paymentUrl, invId });
    } catch (error) {
        console.error('❌ [v2.1.0] Ошибка создания заказа:', error);
        res.status(500).json({ success: false, message: 'Ошибка сервера' });
    }
});

// 11.2.1 Прикрепить DropMeFiles-ссылку к заказу (админ)
app.post('/api/admin/attach-link', (req, res) => {
    try {
        const invId   = Number(req.body.invId);
        const fileUrl = String(req.body.fileUrl || '').trim();

        if (!invId) return res.status(400).json({ error: 'invId обязателен' });
        if (!/^https?:\/\//i.test(fileUrl)) {
            return res.status(400).json({ error: 'fileUrl должен начинаться с http:// или https://' });
        }

        const order = db.prepare('SELECT * FROM pending_orders WHERE inv_id = ?').get(invId);
        if (!order) return res.status(404).json({ error: 'Заказ не найден' });

        if (order.sent_to_client === 1) {
            return res.status(400).json({
                error: 'Письмо клиенту уже отправлено. Сначала сбросьте sent_to_client вручную.'
            });
        }

//Защита от повторного использования ссылки проверяет базу
      const existingLink = db.prepare('SELECT * FROM file_links WHERE url = ?').get(fileUrl);
      if (existingLink) {
          return res.status(400).json({
              error: `Эта ссылка уже прикреплена к заказу #${existingLink.inv_id}. Выберите другую!`
          });
      }

      //Записывваем ссылку в новую таблицу file_links
db.prepare('INSERT INTO file_links (inv_id, url) VALUES (?, ?)').run(invId, fileUrl);

        db.prepare(`
            UPDATE pending_orders
            SET status = 'оплачен',
                file_url = ?,
                file_created_at = ?,
                sent_to_client = 0
            WHERE inv_id = ?
        `).run(fileUrl, new Date().toISOString(), invId);

        console.log(`🔗 [attach-link] Заказ #${invId}: прикреплена ссылка ${fileUrl}`);
        res.json({ ok: true, invId, fileUrl });
    } catch (err) {
        console.error('❌ [attach-link]', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 11.2.2 Список заказов для админки
app.get('/api/admin/orders', (req, res) => {
    try {
        const status = req.query.status;

        let sql = `
            SELECT inv_id, name, email, phone, total, status,
                   file_url, file_created_at, sent_to_client, created_at
            FROM pending_orders
        `;
        const params = [];

        if (status) {
            sql += ' WHERE status = ?';
            params.push(status);
        }

        sql += ' ORDER BY created_at DESC LIMIT 200';

        const rows = db.prepare(sql).all(...params);
        res.json({ ok: true, count: rows.length, orders: rows });
    } catch (err) {
        console.error('❌ [admin/orders]', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 11.3 Вебхук Robokassa — ОТКЛЮЧЕНО
/*
app.post('/robokassa/result', async (req, res) => {
    // ... будет активировано при возврате оплаты
});
*/

// 11.4 Скачивание файла по токену (резерв — сейчас не используется)
app.get('/api/download/:token', (req, res) => {
    const tokenData = db.prepare('SELECT file_name, expires_at FROM download_tokens WHERE token = ?')
                        .get(req.params.token);

    if (!tokenData || tokenData.expires_at < Date.now()) {
        return res.status(404).send('<h1>❌ Ссылка недействительна или истекла</h1>');
    }

    const filePath = path.join(FILES_DIR, tokenData.file_name);
    if (!fs.existsSync(filePath)) {
        return res.status(404).send('<h1>❌ Файл не найден</h1>');
    }

    res.setHeader('Content-Disposition', `attachment; filename="${tokenData.file_name}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    fs.createReadStream(filePath).pipe(res);
});

// 11.5 Чат-бот (SSE)
app.post('/api/chat', async (req, res) => {
    try {
        const { message, transcript } = req.body;
        console.log('📩 [v2.1.0] Сообщение в чат:', message);

        const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
        if (Array.isArray(transcript)) {
            for (const msg of transcript) {
                if (msg.role && msg.content) messages.push({ role: msg.role, content: msg.content });
            }
        }
        messages.push({ role: 'user', content: message });

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const stream = await aiClient.chat.completions.create({
            model:       process.env.AI_MODEL || 'deepseek-chat',
            messages,
            stream:      true,
            temperature: 0.7,
        });

        for await (const chunk of stream) {
            const content = chunk.choices[0]?.delta?.content || '';
            if (content) res.write(`data: ${JSON.stringify({ text: content })}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        res.end();
    } catch (error) {
        console.error('❌ [v2.1.0] Ошибка чат-бота:', error);
        if (!res.headersSent) res.status(500).json({ error: 'Ошибка сервера' });
        else res.end();
    }
});

// 11.6 Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order.html'));
});

// ------------------------------------------------------------
// 12. ЗАПУСК
// ------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [v2.1.0] Сервер запущен на http://localhost:${PORT}`);
    console.log(`📧 [v2.1.0] Уведомления на ${EMAIL_CONFIG.notifyEmail}`);
    console.log(`🤖 [v2.1.0] ИИ подключён к: ${process.env.AI_BASE_URL || 'OpenAI'}`);
    console.log(`🖥️  [v2.1.0] Админка: http://localhost:${PORT}/admin`);
    testEmail().catch(err => console.error('❌ [v2.1.0] testEmail:', err.message));
    setInterval(checkPaidOrders, 60 * 1000);
});
