/**
 * ====================BISMILLYAHI!!!========================================
 * UKEYS SHOP — SERVER
 *  Версия: 2.2.0 (perf + email-retry)
 * ------------------------------------------------------------
 *  Robokassa ВРЕМЕННО ОТКЛЮЧЕНА (заглушка оплаты).
 *  - Заказ создаётся и сохраняется в БД (НЕ удаляется).
 *  - Письма клиенту и админу отправляются ФОНОМ (не блокируют ответ)
 *    и имеют ЕДИНЫЙ механизм ретрая через checkPaidOrders().
 *  - После оплаты админ прикрепляет DropMeFiles-ссылку через
 *    /api/admin/attach-link → checkPaidOrders() отправит письмо.
 *
 *  ЗАВИСИМОСТИ (package.json):
 *    express, nodemailer, cors, dotenv, better-sqlite3, chatbotlite
 *    compression — опционально (если не установлен, сервер всё равно стартует)
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
const { ChatBot } = require('chatbotlite/client');
const { knowledgeFromFile } = require('chatbotlite/node');

// ⚡ [PERF] compression подключаем опционально: если пакета нет — просто warn
let compression = null;
try {
    compression = require('compression');
} catch {
    console.warn('⚠️ [PERF] Пакет compression не установлен (npm i compression) — gzip отключён.');
}

// ⚡ [PERF] Диагностические логи — только при DEBUG=1 (не тормозят stdout на каждый запрос)
const DEBUG = process.env.DEBUG === '1';
const debug = (...args) => { if (DEBUG) console.log(...args); };

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

// ⚡ [PERF] gzip-сжатие для HTML/JSON — меньше трафика, быстрее отдача
if (compression) app.use(compression());

// ⚡ [PERF] Кэш статики: браузер не перекачивает одни и те же картинки/видео 7 дней.
// extensions: ['html'] — на '/' отдаётся index.html без отдельного роута (см. 11.6)
app.use(express.static('public', {
    maxAge: '7d',
    extensions: ['html'],
}));

// ------------------------------------------------------------
// 3.5. КОНСТАНТЫ
// ------------------------------------------------------------
const DOWNLOAD_LINK_TTL_DAYS = 7; // единый срок: токен = письмо = проверка в checkPaidOrders

// ⚡ [PERF] QR-код проверяем ОДИН раз при старте, а не на каждый заказ
const QR_PATH = path.join(__dirname, 'public', 'qr.png');
const HAS_QR  = fs.existsSync(QR_PATH);
if (!HAS_QR) {
    console.warn('⚠️ [v2.2.0] Файл public/qr.png не найден — письма уйдут без QR-кода.');
}

// ⚡ [RETRY] Заказ, «застрявший» в статусе письма_отправляются дольше этого срока,
// считается зависшим (например, сервер упал mid-send) и сбрасывается на ретрай
const EMAIL_STALE_MINUTES = 10;

// ── Basic Auth для админки ────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'gangster';
const ADMIN_PASS = process.env.ADMIN_PASS;
if (!ADMIN_PASS) throw new Error('ADMIN_PASS не задан в окружении .env! Приложение остановлено.');

/**
 * checkAuth — middleware Basic Auth для админ-маршрутов.
 * Из заголовка Authorization достаём "Basic base64(login:password)",
 * сверяем с ADMIN_USER/ADMIN_PASS. При несовпадении — 401.
 */
function checkAuth(req, res, next) {
    const header = req.headers.authorization || '';

    debug('🛡️ [checkAuth] path =', req.path, '| header =', header ? header.slice(0, 40) + '...' : '(пусто)');

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

// все /api/admin/* под Basic Auth
app.use('/api/admin', checkAuth);

// страница админки тоже под Basic Auth (файл вне public/)
app.get('/admin', checkAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

// ------------------------------------------------------------
// 4. ХРАНИЛИЩЕ ФАЙЛОВ ДЛЯ СКАЧИВАНИЯ
// ------------------------------------------------------------
const FILES_DIR = path.join(__dirname, 'private_files');
if (!fs.existsSync(FILES_DIR)) {
    fs.mkdirSync(FILES_DIR);
    console.log('📁 [v2.2.0] Создана папка для файлов:', FILES_DIR);
}

// ------------------------------------------------------------
// 5. БАЗА ДАННЫХ SQLITE
// ------------------------------------------------------------
const db = new Database(path.join(__dirname, 'ukey.db'));
db.pragma('journal_mode = WAL');
// ⚡ [PERF] При WAL режим NORMAL безопасен и заметно ускоряет запись (меньше fsync)
db.pragma('synchronous = NORMAL');

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
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        inv_id      INTEGER,
        url         TEXT UNIQUE NOT NULL,
        created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
        sent_at     DATETIME
    );
`);

// 5.2. Миграция (идемпотентная — колонки добавляются, только если их нет)
const pendingCols = db.prepare(`PRAGMA table_info(pending_orders)`).all().map(c => c.name);
console.log('🗄️ Текущие колонки pending_orders:', pendingCols.join(', '));

const addPendingCol = (name, def) => {
    if (!pendingCols.includes(name)) {
        db.exec(`ALTER TABLE pending_orders ADD COLUMN ${name} ${def}`);
        console.log(`🛠️ Добавлена колонка pending_orders.${name}`);
    } else {
        debug(`✔️ Колонка pending_orders.${name} уже есть`);
    }
};
addPendingCol('status',           "TEXT DEFAULT 'ожидает'");
addPendingCol('file_url',         'TEXT');
addPendingCol('file_created_at',  'TEXT');
addPendingCol('sent_to_client',   'INTEGER DEFAULT 0');
// ⚡ [RETRY] Флаг «письма о заказе отправлены»: 0 = не отправлены (нужен ретрай),
// 1 = отправлены. 2 не используем — логика «ошибка → ретрай на следующем тике».
addPendingCol('order_emails_sent', 'INTEGER DEFAULT 0');

// ⚡ [PERF] Индексы: без них SELECT по статусу сканирует всю таблицу каждый тик.
// idx_pending_status  — для фазы B (оплаченные заказы)
// idx_pending_emails  — для фазы A (очередь писем о новых заказах)
db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_orders(status, sent_to_client);
    CREATE INDEX IF NOT EXISTS idx_pending_emails ON pending_orders(status, order_emails_sent);
`);

// 5.3. ⚡ [PERF] Подготовленные выражения — компилируются ОДИН раз при старте,
// а не при каждом вызове db.prepare внутри функций/циклов.
const stmt = {
    // ── /api/order ──────────────────────────────────────────
    insertOrder: db.prepare(`
        INSERT INTO pending_orders (inv_id, name, email, phone, comment, cart_json, total)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `),

    // ── Очередь писем о новом заказе (фаза A) ───────────────
    selectNewEmails: db.prepare(`
        SELECT * FROM pending_orders
        WHERE status = 'ожидает' AND order_emails_sent = 0
    `),
    // Атомарный «захват»: переводим в промежуточный статус, чтобы
    // параллельный тик или рестарт не отправил письмо дважды
    claimEmails: db.prepare(`
        UPDATE pending_orders
        SET status = 'письма_отправляются'
        WHERE inv_id = ? AND status = 'ожидает' AND order_emails_sent = 0
    `),
    // Успех: возвращаем в 'ожидает' (заказ ещё НЕ оплачен) и ставим флаг
    markEmailsSent: db.prepare(`
        UPDATE pending_orders
        SET status = 'ожидает', order_emails_sent = 1
        WHERE inv_id = ?
    `),
    // Ошибка отправки: откат — на следующем тике будет ретрай
    revertEmails: db.prepare(`
        UPDATE pending_orders
        SET status = 'ожидает', order_emails_sent = 0
        WHERE inv_id = ?
    `),
    // Восстановление зависших: сервер упал после захвата, но до mark/revert
    resetStaleEmails: db.prepare(`
        UPDATE pending_orders
        SET status = 'ожидает', order_emails_sent = 0
        WHERE status = 'письма_отправляются'
          AND created_at < datetime('now', '-${EMAIL_STALE_MINUTES} minutes')
    `),

    // ── Очередь писем со ссылкой (фаза B, после оплаты) ─────
    selectPaid: db.prepare(`
        SELECT * FROM pending_orders
        WHERE status = 'оплачен' AND sent_to_client = 0
    `),
    claimPaid: db.prepare(`
        UPDATE pending_orders
        SET status = 'отправляется'
        WHERE inv_id = ? AND status = 'оплачен' AND sent_to_client = 0
    `),
    markSent: db.prepare(`
        UPDATE pending_orders
        SET status = 'отправлен', sent_to_client = 1
        WHERE inv_id = ?
    `),
    revertPaid: db.prepare(`
        UPDATE pending_orders SET status = 'оплачен' WHERE inv_id = ?
    `),
    markLinkUsed: db.prepare(`
        UPDATE file_links SET sent_at = CURRENT_TIMESTAMP WHERE url = ?
    `),

    // ── Админские операции ──────────────────────────────────
    getOrder:    db.prepare(`SELECT * FROM pending_orders WHERE inv_id = ?`),
    linkExists:  db.prepare(`SELECT * FROM file_links WHERE url = ?`),
    insertLink:  db.prepare(`INSERT INTO file_links (inv_id, url) VALUES (?, ?)`),
    attachLink:  db.prepare(`
        UPDATE pending_orders
        SET status = 'оплачен', file_url = ?, file_created_at = ?, sent_to_client = 0
        WHERE inv_id = ?
    `),
    ordersAll: db.prepare(`
        SELECT inv_id, name, email, phone, total, status,
               file_url, file_created_at, sent_to_client, order_emails_sent, created_at
        FROM pending_orders
        ORDER BY created_at DESC LIMIT 200
    `),
    ordersByStatus: db.prepare(`
        SELECT inv_id, name, email, phone, total, status,
               file_url, file_created_at, sent_to_client, order_emails_sent, created_at
        FROM pending_orders
        WHERE status = ?
        ORDER BY created_at DESC LIMIT 200
    `),

    // ── Токены скачивания ───────────────────────────────────
    insertToken: db.prepare(`INSERT INTO download_tokens (token, file_name, expires_at) VALUES (?, ?, ?)`),
    getToken:    db.prepare(`SELECT file_name, expires_at FROM download_tokens WHERE token = ?`),
    cleanTokens: db.prepare(`DELETE FROM download_tokens WHERE expires_at < ?`),
};

console.log('🗄️ [v2.2.0] База данных SQLite подключена (WAL + prepared statements).');

// ------------------------------------------------------------
// 6. ROBOKASSA — ОТКЛЮЧЕНА
// ------------------------------------------------------------
let robokassa = null;
console.log('💳 [v2.2.0] Robokassa ОТКЛЮЧЕНА (ЗАГЛУШКА ОПЛАТЫ)');

// ------------------------------------------------------------
// 7. ИИ-КЛИЕНТ (ChatbotLite)
// ------------------------------------------------------------
let chatBotLite = null;
try {
    chatBotLite = new ChatBot({
        knowledge: knowledgeFromFile("./knowledge.md"),
        providers: {
            keys: { custom: process.env.SELECTEL_API_KEY },
            chain: [{
                provider: "custom",
                baseUrl: process.env.SELECTEL_BASE_URL,   // https://api.tf.selcloud.ru/v1
                model: process.env.SELECTEL_MODEL,
                apiKey: process.env.SELECTEL_API_KEY,
            }],
        },
    });
    console.log('✅ [ChatbotLite] Бот успешно инициализирован (TokenFactory).');
} catch (e) {
    console.error('❌ [ChatbotLite] Ошибка инициализации:', e.message);
}

// ------------------------------------------------------------
// 8. ПОЧТА
// ------------------------------------------------------------
const EMAIL_CONFIG = {
    user: 'info@ukeyflash.ru',
    password: process.env.EMAIL_PASSWORD,
    notifyEmail: process.env.NOTIFY_EMAIL || 'ukeyflash@gmail.com',
};

// ⚡ [PERF] pool: true — одно SMTP-соединение переиспользуется для всех писем,
// вместо TCP+TLS-рукопожатия на каждое
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: true,
    pool: true,
    maxConnections: 3,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
    },
});

async function testEmail() {
    try {
        await transporter.verify();
        console.log('✅ [v2.2.0] SMTP подключение работает!');
    } catch (error) {
        console.error('❌ [v2.2.0] Ошибка SMTP:', error.message);
    }
}

// ------------------------------------------------------------
// 8.1. ОТПРАВКА ССЫЛКИ КЛИЕНТУ (после оплаты)
// ------------------------------------------------------------
/**
 * sendFileToClient(order) — письмо клиенту с DropMeFiles-ссылкой + копия админу.
 * Бросает исключение при ошибке SMTP: вызывающий (checkPaidOrders, фаза B)
 * откатит статус 'отправляется' → 'оплачен', и письмо уйдёт на ретрае.
 */
async function sendFileToClient(order) {
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

    const adminOptions = {
        from:    `"UKey Shop" <${EMAIL_CONFIG.user}>`,
        to:      EMAIL_CONFIG.notifyEmail,
        subject: `Копия: Ссылка отправлена (Заказ №${order.inv_id})`,
        text:    `Клиенту ${order.name} (${order.email}) отправлена ссылка: ${order.file_url}`,
    };

    // ⚡ [PERF] Оба письма уходят параллельно: время = самому медленному, а не сумме
    await Promise.all([
        transporter.sendMail(clientMailOptions),
        transporter.sendMail(adminOptions),
    ]);

    console.log(`✅ [Заказ №${order.inv_id}] Ссылка отправлена клиенту (${order.email}) + копия админу.`);
}

// ------------------------------------------------------------
// 8.2. ТАЙМЕР: единая очередь отправки писем
// ------------------------------------------------------------
let __checkingPaidOrders = false;

/**
 * checkPaidOrders() — запускается раз в минуту. Две фазы:
 *
 *  Фаза A — письма о новом заказе (QR для оплаты).
 *    Берёт заказы status='ожидает' AND order_emails_sent=0.
 *    Атомарно захватывает (статус → 'письма_отправляются'), отправляет письма.
 *    Успех → status='ожидает', order_emails_sent=1.
 *    Ошибка SMTP → откат в 'ожидает' (order_emails_sent=0) → ретрай на след. тике.
 *    Перед фазой A сбрасывает зависшие 'письма_отправляются' старше EMAIL_STALE_MINUTES
 *    (сервер мог упасть между захватом и отметкой).
 *
 *  Фаза B — письма со ссылкой на скачивание (после оплаты).
 *    Логика прежняя: 'оплачен' → захват 'отправляется' → письмо → 'отправлен'.
 */
async function checkPaidOrders() {
    if (__checkingPaidOrders) {
        debug('⏭️  checkPaidOrders уже выполняется — пропуск тика');
        return;
    }
    __checkingPaidOrders = true;
    try {
        // ── Фаза 0: восстановление зависших захватов писем о заказе ──
        const stale = stmt.resetStaleEmails.run();
        if (stale.changes > 0) {
            console.warn(`♻️ [RETRY] Восстановлено зависших заказов: ${stale.changes} — письма уйдут повторно`);
        }

        // ── Фаза A: письма о НОВОМ заказе (QR для оплаты) ────────────
        const newOrders = stmt.selectNewEmails.all();
        for (const order of newOrders) {
            // парсим корзину из cart_json
            let cart;
            try {
                cart = JSON.parse(order.cart_json);
            } catch {
                cart = null;
            }
            if (!Array.isArray(cart) || cart.length === 0) {
                console.error(`❌ Заказ #${order.inv_id}: корзина сломана — письма не могут быть собраны. Помечаю order_emails_sent=1, чтобы не зацикливать ретрай.`);
                stmt.markEmailsSent.run(order.inv_id);
                continue;
            }

            // атомарный захват
            const claim = stmt.claimEmails.run(order.inv_id);
            if (claim.changes !== 1) continue; // уже кто-то обрабатывает

            const orderData = {
                name: order.name,
                email: order.email,
                phone: order.phone,
                comment: order.comment,
                cart,
                total: order.total,
                baseUrl: '', // в письмах о заказе baseUrl не используется
            };

            try {
                await sendOrderEmails(orderData);
            } catch (e) {
                // откат: на следующем тике ретрай
                stmt.revertEmails.run(order.inv_id);
                console.error(`❌ [RETRY] Письма по заказу #${order.inv_id} не ушли (будет ретрай через минуту):`, e.message);
                continue;
            }

            stmt.markEmailsSent.run(order.inv_id);
            console.log(`✅ [RETRY] Письма о заказе #${order.inv_id} отправлены (QR клиенту).`);
        }

        // ── Фаза B: письма со ССЫЛКОЙ (оплаченные заказы) ────────────
        const orders = stmt.selectPaid.all();
        for (const order of orders) {
            if (!order.file_url || !order.file_created_at) {
                console.log(`❌ Заказ №${order.inv_id} оплачен, но ссылка не прикреплена!`);
                continue;
            }

            // проверяем срок давности ссылки
            const linkDate = new Date(order.file_created_at);
            if (!linkDate || isNaN(linkDate.getTime())) {
                console.log(`❌ Заказ №${order.inv_id}: некорректный file_created_at`);
                continue;
            }
            const diffDays = (new Date() - linkDate) / (1000 * 60 * 60 * 24);
            if (diffDays > DOWNLOAD_LINK_TTL_DAYS) {
                console.log(`❌ Заказ №${order.inv_id}: ссылка просрочена (${Math.floor(diffDays)} дн.). Нужно обновить file_url!`);
                continue;
            }

            // атомарный захват, чтобы не отправить дважды
            const claim = stmt.claimPaid.run(order.inv_id);
            if (claim.changes !== 1) {
                debug(`⏭️  Заказ #${order.inv_id} уже кем-то захвачен — пропуск`);
                continue;
            }

            try {
                await sendFileToClient(order);
            } catch (e) {
                stmt.revertPaid.run(order.inv_id); // откат → ретрай на следующем тике
                throw e;
            }

            stmt.markSent.run(order.inv_id);
            stmt.markLinkUsed.run(order.file_url); // помечаем ссылку как использованную
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
/** generateDownloadToken — создаёт случайный токен с TTL и пишет в download_tokens. */
function generateDownloadToken(fileName) {
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + DOWNLOAD_LINK_TTL_DAYS * 24 * 60 * 60 * 1000;
    stmt.insertToken.run(token, fileName, expiresAt);
    return token;
}

/** cleanExpiredTokens — раз в час чистит просроченные токены. */
function cleanExpiredTokens() {
    const info = stmt.cleanTokens.run(Date.now());
    if (info.changes > 0) console.log(`🧹 [v2.2.0] Очищено ${info.changes} просроченных токенов.`);
}
setInterval(cleanExpiredTokens, 60 * 60 * 1000);

// ------------------------------------------------------------
// 10. СБОРКА И ОТПРАВКА ПИСЕМ ПРИ СОЗДАНИИ ЗАКАЗА
// ------------------------------------------------------------
/**
 * sendOrderEmails(orderData) — ТОЛЬКО собирает письма клиенту (с QR-кодом оплаты)
 * и письмо-копию админу, отправляет оба.
 * Вызывается из /api/order (фоном) и из checkPaidOrders (фаза A, ретрай).
 * Бросает исключение при ошибке SMTP — вызывающий решает, что делать
 * (в /api/order это revert+ретрай через таймер, здесь то же самое).
 */
async function buildOrderMails(orderData) {
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

    const clientMailOptions = {
        from: `"UKeys Shop" <${EMAIL_CONFIG.user}>`,
        to: email,
        subject: '✅ Благодарим за ваш заказ!',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
                <h2 style="color: #28a745;">✅ Для оплаты отсканируйте QR-код!</h2>
                <p>Здравствуйте, <strong>${name}</strong>!</p>
                <p>Спасибо вам за заказ <strong>UKeys</strong>. Сумма к оплате: <strong>${totalNum.toLocaleString('ru-RU')} ₽</strong>.</p>

                ${HAS_QR ? `
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
              (HAS_QR ? 'Для оплаты отсканируйте QR-код в письме.\n' : '') +
              `Сумма к оплате: ${totalNum.toLocaleString('ru-RU')} ₽\n\nТелефон: ${phone}`,
        attachments: HAS_QR ? [{
            filename: 'qr.png',
            path: QR_PATH,
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
    // ⚡ [LOGIC] Функция только СОБИРАЕТ письма — отправляют отдельные функции ниже
    return { clientMailOptions, adminMailOptions };
}

// ⚡ [LOGIC] Отправители. sendOrderEmails сохраняем под тем же именем —
// её вызывает фаза A в checkPaidOrders (строки ~530) для ретрая.
async function sendClientOrderEmail(orderData) {
    const { clientMailOptions } = buildOrderMails(orderData);
    await transporter.sendMail(clientMailOptions);
    console.log(`📧 Письмо с QR отправлено клиенту: ${clientMailOptions.to}`);
}

async function sendAdminOrderEmail(orderData) {
    const { adminMailOptions } = buildOrderMails(orderData);
    await transporter.sendMail(adminMailOptions);
}

async function sendOrderEmails(orderData) {
    const { clientMailOptions, adminMailOptions } = buildOrderMails(orderData);
    await Promise.all([
        transporter.sendMail(clientMailOptions),
        transporter.sendMail(adminMailOptions),
    ]);
}







// ------------------------------------------------------------
// 11. API ЭНДПОИНТЫ
// ------------------------------------------------------------

// 11.1 GET /api/info — список товаров для витрины
app.get('/api/info', (req, res) => {
    res.json({
        products: [
            { name: 'Ukey CORE',       price: 1500, file: 'ukey_winpe.iso',     video: '../img/key1.mp4'    },
            { name: 'Ukey Kali Linux', price: 1000, file: 'ukey_kali.iso',      video: '../img/kali.mp4'    },
            { name: 'Ukey ULTIMATE',   price: 2500, file: 'ukey_winpe_pro.iso', video: '../img/nindza.mp4'  },
        ],
    });
});

// 11.2 POST /api/order — создание заказа
/**
 * Валидирует данные, сохраняет заказ в БД, отправляет письмо клиенту с QR
 * (ждём его ДО ответа — окно с QR показывается после доставки письма),
 * копия админу уходит фоном. Ошибка SMTP у клиентского письма → ретрай
 * через checkPaidOrders на следующем тике.
 */
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

        // ⚡ [PERF] invId из crypto вместо Date.now(): два заказа в одну
        // миллисекунду больше не роняют endpoint с UNIQUE-конфликтом
        const invId = parseInt(crypto.randomBytes(6).toString('hex'), 16);

        // ⚡ [RETRY] insertOrder создаёт запись со статусом 'ожидает'
        // и order_emails_sent=0 (дефолты колонок)
        stmt.insertOrder.run(invId, name, email, phone, comment || null, JSON.stringify(cart), totalNum);
        console.log(`📝 [v2.2.0] Заказ #${invId} сохранён в БД. Сумма: ${totalNum} ₽`);

        // ⚡ [LOGIC] Захват очереди: тик таймера не отправит письмо повторно
        const claim = stmt.claimEmails.run(invId);

        if (claim.changes === 1) {
            const orderData = {
                name, email, phone, comment, cart,
                total: totalNum,
                baseUrl: `${req.protocol}://${req.get('host')}`,
            };

            // ⚡ [LOGIC] Ждём ТОЛЬКО письмо клиенту с QR.
            // Окно с QR в браузере появится после фактической доставки письма.
            try {
                await sendClientOrderEmail(orderData);
                stmt.markEmailsSent.run(invId);
                console.log(`✅ [LOGIC] QR-письмо доставлено клиенту (#${invId}).`);
            } catch (mailErr) {
                stmt.revertEmails.run(invId); // ретрай на ближайшем тике
                console.error(`❌ [LOGIC] QR-письмо по заказу #${invId} не ушли — ретрай через минуту:`, mailErr.message);
                // Окно с QR всё равно показываем: QR есть на pay.html
            }

            // Копия админу — фон: её ошибка не задерживает клиента
            sendAdminOrderEmail(orderData).catch(err =>
                console.error(`⚠️ Копия админу по заказу #${invId} не ушла:`, err.message)
            );
        } else {
            console.warn(`⚠️ Заказ #${invId}: письмо уже в очереди (гонка) — пропускаю`);
        }

        // Ответ клиенту — ПОСЛЕ попытки отправки письма клиенту
        const payPageUrl = `/pay.html?invId=${invId}`;
        res.json({
            success: true,
            invId,
            payPageUrl,
        });
    } catch (error) {
        console.error('❌ [v2.2.0] Ошибка создания заказа:', error);
        // ⚡ [PERF] headersSent: если ответ уже ушёл (или письма ушли фоном),
        // второй res.json недопустим — просто закрываем соединение
        if (!res.headersSent) {
            res.status(500).json({ success: false, message: 'Ошибка сервера' });
        } else {
            res.end();
        }
    }
});

// 11.2.1 POST /api/admin/attach-link — прикрепить DropMeFiles-ссылку (админ)
/**
 * Проверяет заказ, защищает от повторного использования ссылки (таблица
 * file_links с UNIQUE по url), помечает заказ 'оплачен' — дальше его подхватит
 * фаза B таймера checkPaidOrders.
 */
app.post('/api/admin/attach-link', (req, res) => {
    try {
        const invId   = Number(req.body.invId);
        const fileUrl = String(req.body.fileUrl || '').trim();

        if (!invId) return res.status(400).json({ error: 'invId обязателен' });
        if (!/^https?:\/\//i.test(fileUrl)) {
            return res.status(400).json({ error: 'fileUrl должен начинаться с http:// или https://' });
        }

        const order = stmt.getOrder.get(invId);
        if (!order) return res.status(404).json({ error: 'Заказ не найден' });

        if (order.sent_to_client === 1) {
            return res.status(400).json({
                error: 'Письмо клиенту уже отправлено. Сначала сбросьте sent_to_client вручную.'
            });
        }

        // защита от повторного использования ссылки
        const existingLink = stmt.linkExists.get(fileUrl);
        if (existingLink) {
            return res.status(400).json({
                error: `Эта ссылка уже прикреплена к заказу #${existingLink.inv_id}. Выберите другую!`
            });
        }

        stmt.insertLink.run(invId, fileUrl);
        stmt.attachLink.run(fileUrl, new Date().toISOString(), invId);

        console.log(`🔗 [attach-link] Заказ #${invId}: прикреплена ссылка ${fileUrl}`);
        res.json({ ok: true, invId, fileUrl });
    } catch (err) {
        console.error('❌ [attach-link]', err.message);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// 11.2.2 GET /api/admin/orders — список заказов для админки
app.get('/api/admin/orders', (req, res) => {
    try {
        const status = req.query.status;
        const rows = status
            ? stmt.ordersByStatus.all(status)
            : stmt.ordersAll.all();
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

// 11.4 GET /api/download/:token — скачивание файла по токену (резерв)
/**
 * Проверяет токен в БД и TTL, отдаёт файл потоком из private_files.
 * ⚡ [PERF] existsSync убран: лишний синхронный вызов + race condition
 * (файл может исчезнуть между проверкой и чтением). Ошибки чтения
 * ловим в stream.on('error') с проверкой res.headersSent.
 */
app.get('/api/download/:token', (req, res) => {
    const tokenData = stmt.getToken.get(req.params.token);

    if (!tokenData || tokenData.expires_at < Date.now()) {
        return res.status(404).send('<h1>❌ Ссылка недействительна или истекла</h1>');
    }

    const filePath = path.join(FILES_DIR, tokenData.file_name);
    res.setHeader('Content-Disposition', `attachment; filename="${tokenData.file_name}"`);
    res.setHeader('Content-Type', 'application/octet-stream');

    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
        console.error('❌ [download] Ошибка чтения файла:', err.message);
        if (!res.headersSent) res.status(404).send('<h1>❌ Файл не найден</h1>');
        else res.end();
    });
    stream.pipe(res);
});

// 11.5 POST /api/chat — чат-бот (SSE) через ChatbotLite
/**
 * Стриминг ответа ИИ в формате Server-Sent Events.
 * flushHeaders отправляет заголовки сразу — клиент не ждёт первый чанк.
 */
app.post('/api/chat', async (req, res) => {
    try {
        const { message, transcript } = req.body;
        debug('📩 [ChatbotLite] Сообщение в чат:', message);

        if (!chatBotLite) {
            return res.status(500).json({ error: 'Чат-бот не инициализирован' });
        }

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders(); // ⚡ [PERF] заголовки уходят сразу, не ждём первый чанк

        const stream = await chatBotLite.replyStream(message, {
            history: transcript || []
        });

        for await (const chunk of stream) {
            res.write(chunk);
        }
        res.end();
    } catch (error) {
        console.error('❌ [ChatbotLite] Ошибка чата:', error);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Внутренняя ошибка сервера' });
        } else {
            res.end();
        }
    }
});

// 11.6 Главная страница — УДАЛЕНА как отдельный роут:
// ⚡ [PERF] express.static с extensions: ['html'] отдаёт public/index.html на '/'

// ------------------------------------------------------------
// 12. ЗАПУСК
// ------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [v2.2.0] Сервер запущен на http://localhost:${PORT}`);
    console.log(`📧 [v2.2.0] Уведомления на ${EMAIL_CONFIG.notifyEmail}`);
    console.log(`🖥️  [v2.2.0] Админка: http://localhost:${PORT}/admin`);
    testEmail().catch(err => console.error('❌ [v2.2.0] testEmail:', err.message));
    setInterval(checkPaidOrders, 60 * 1000); // каждые 60 сек — обе фазы очереди писем
});
