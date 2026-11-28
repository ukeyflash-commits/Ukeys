/**
 * ====================BISMILLYAHI!!!========================================
 * UKEYS SHOP — SERVER
 *  Версия: 2.3.0 (perf + email-retry + починка дублей и блокировок)
 *  База: server_ALISA2.js (v2.2.0) + правки после проверки ретрая.
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
 *
 *  ======================= ЖУРНАЛ ПРАВОК v2.3.0 ==========================
 *  🔧 [FIX-1] (раздел 3.1) В v2.2.0 ПОТЕРЯН счётчик посетителей
 *            visit-counter — восстановлен из v2.1.0.
 *  🔧 [FIX-2] (разделы 5.2, 10, 8.2, 11.2) Поэтапная отправка писем о
 *            заказе: сначала клиенту (флаг admin_order_mail_sent=1),
 *            потом админу. Раньше Promise.all при падении копии админу
 *            откатывал ВЕСЬ заказ — и на ретрае клиент получал письмо
 *            с QR ДВАЖДЫ. Теперь отправленное клиенту повторно не шлётся.
 *  🔧 [FIX-3] (разделы 3.5, 5.2, 10, 8.2) Лимит попыток MAX_EMAIL_ATTEMPTS:
 *            постоянная ошибка SMTP (несуществующий email) больше не
 *            ретраится каждую минуту вечно. Колонка email_attempts.
 *  🔧 [FIX-4] (разделы 8.1, 8.2) В фазе B убран `throw e` из цикла —
 *            один падающий заказ блокировал ВСЕ остальные оплаченные
 *            заказы навсегда (head-of-line blocking). Плюс копия админу
 *            стала не-критичной: её падение не вызывает ретрай письма
 *            клиенту с ссылкой.
 *  🔧 [FIX-5] (раздел 8) Единое имя отправителя "UKeys Shop",
 *            EMAIL_PORT приведён к числу.
 * =======================================================================
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
// 3.1 СЧЁТЧИК ПОСЕТИТЕЛЕЙ
// 🔧 [FIX-1] В v2.2.0 этот блок потерялся при переносе из v2.1.0 —
// visit-counter работает (visits.json), но не подключался к express.
// ------------------------------------------------------------
const { attachVisitCounter } = require('./visit-counter');
attachVisitCounter(app);

// ------------------------------------------------------------
// 3.5. КОНСТАНТЫ
// ------------------------------------------------------------
const DOWNLOAD_LINK_TTL_DAYS = 7; // единый срок: токен = письмо = проверка в checkPaidOrders

// ⚡ [PERF] QR-код проверяем ОДИН раз при старте, а не на каждый заказ
const QR_PATH = path.join(__dirname, 'public', 'qr.png');
const HAS_QR  = fs.existsSync(QR_PATH);
if (!HAS_QR) {
    console.warn('⚠️ [v2.3.0] Файл public/qr.png не найден — письма уйдут без QR-кода.');
}

// ⚡ [RETRY] Заказ, «застрявший» в статусе письма_отправляются дольше этого срока,
// считается зависшим (например, сервер упал mid-send) и сбрасывается на ретрай
const EMAIL_STALE_MINUTES = 10;

// 🔧 [FIX-3] Сколько раз пробуем отправить письма о заказе, прежде чем
// сдаться (например, email клиента не существует — «550 mailbox not found»).
// Без лимита ретрай работал бы каждую минуту вечно и забивал логи/SMTP.
const MAX_EMAIL_ATTEMPTS = 5;

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
    console.log('📁 [v2.3.0] Создана папка для файлов:', FILES_DIR);
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
// 🔧 [FIX-2] Этапность отправки писем о заказе:
//   admin_order_mail_sent = 0 → клиентское письмо ещё НЕ доставлено,
//                               шлём оба (клиент, потом админ).
//   admin_order_mail_sent = 1 → клиентское письмо УЖЕ доставлено,
//                               на ретрае шлём только копию админу.
// Без этой колонки падение копии админу приводило к ПОВТОРНОЙ отправке
// письма клиенту (дубль QR в почтовом ящике клиента).
addPendingCol('admin_order_mail_sent', 'INTEGER DEFAULT 0');
// 🔧 [FIX-3] Счётчик попыток отправки — для лимита ретрая.
addPendingCol('email_attempts', 'INTEGER DEFAULT 0');

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
    // Успех (все письма ушли): возвращаем в 'ожидает' (заказ ещё НЕ оплачен)
    // и ставим флаг
    markEmailsSent: db.prepare(`
        UPDATE pending_orders
        SET status = 'ожидает', order_emails_sent = 1
        WHERE inv_id = ?
    `),
    // Ошибка отправки: откат — на следующем тике будет ретрай.
    // 🔧 [FIX-2] НЕ трогает admin_order_mail_sent: прогресс этапа сохраняется.
    revertEmails: db.prepare(`
        UPDATE pending_orders
        SET status = 'ожидает', order_emails_sent = 0
        WHERE inv_id = ?
    `),
    // 🔧 [FIX-2] Промежуточная отметка «клиентское письмо доставлено».
    // Статус ПРЕНАМЕРЕННО остаётся 'письма_отправляются' — это защита от
    // гонки: если параллельный тик подберёт заказ (status='ожидает' и
    // order_emails_sent=0), он отправит клиентское письмо второй раз.
    markClientOrderMailSent: db.prepare(`
        UPDATE pending_orders
        SET admin_order_mail_sent = 1
        WHERE inv_id = ?
    `),
    // 🔧 [FIX-3] Увеличение счётчика попыток (вызывается перед каждой отправкой)
    bumpEmailAttempts: db.prepare(`
        UPDATE pending_orders SET email_attempts = email_attempts + 1 WHERE inv_id = ?
    `),
    // Восстановление зависших: сервер упал после захвата, но до mark/revert.
    // 🔧 [FIX-2] admin_order_mail_sent НЕ сбрасываем — доставленное клиенту
    // письмо не отправится повторно после «разморозки».
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

console.log('🗄️ [v2.3.0] База данных SQLite подключена (WAL + prepared statements).');

// ------------------------------------------------------------
// 6. ROBOKASSA — ОТКЛЮЧЕНА
// ------------------------------------------------------------
let robokassa = null;
console.log('💳 [v2.3.0] Robokassa ОТКЛЮЧЕНА (ЗАГЛУШКА ОПЛАТЫ)');

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
// 🔧 [FIX-5] Имя отправителя везде единое "UKeys Shop" (было "UKey Shop"
// в письме со ссылкой — разнобой в переписке с клиентом).
// 🔧 [FIX-5] EMAIL_PORT из .env приходит строкой — приводим к числу.
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
    port: Number(process.env.EMAIL_PORT) || 465, // 🔧 [FIX-5]
    secure: true, // 465 = implicit TLS. Для порта 587 нужно secure: false!
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
        console.log('✅ [v2.3.0] SMTP подключение работает!');
    } catch (error) {
        console.error('❌ [v2.3.0] Ошибка SMTP:', error.message);
    }
}

// ------------------------------------------------------------
// 8.1. ОТПРАВКА ССЫЛКИ КЛИЕНТУ (после оплаты)
// 🔧 [FIX-4] Раньше оба письма шлись через Promise.all: если клиентское
// письмо ДОСТАВЛЕНО, а копия админу упала — заказ откатывался в 'оплачен',
// и на ретрае клиент получал ссылку ПОВТОРНО. Теперь:
//   1) клиентское письмо — первоочередное, его падение = ретрай всего заказа;
//   2) копия админу — вспомогательная, её падение НЕ вызывает ретрай.
// ------------------------------------------------------------
/**
 * sendFileToClient(order) — письмо клиенту с DropMeFiles-ссылкой + копия админу.
 * Бросает исключение ТОЛЬКО если не ушло клиентское письмо: вызывающий
 * (checkPaidOrders, фаза B) откатит статус 'отправляется' → 'оплачен'.
 */
async function sendFileToClient(order) {
    const clientMailOptions = {
        from:    `"UKeys Shop" <${EMAIL_CONFIG.user}>`, // 🔧 [FIX-5]
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
        from:    `"UKeys Shop" <${EMAIL_CONFIG.user}>`, // 🔧 [FIX-5] было "UKey Shop"
        to:      EMAIL_CONFIG.notifyEmail,
        subject: `Копия: Ссылка отправлена (Заказ №${order.inv_id})`,
        text:    `Клиенту ${order.name} (${order.email}) отправлена ссылка: ${order.file_url}`,
    };

    // Клиентское письмо первым: пока оно не доставлено — статус откатится на ретрай
    await transporter.sendMail(clientMailOptions);

    // Копия админу — best effort: её падение не должно дёргать ретрай клиента
    try {
        await transporter.sendMail(adminOptions);
    } catch (e) {
        console.warn(`⚠️ [FIX-4] Заказ №${order.inv_id}: копия админу не отправлена (${e.message}). Письмо клиенту доставлено — ретрай не нужен.`);
    }

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
 *    Отправка ПОЭТАПНАЯ (FIX-2): клиент → отметка → админ → order_emails_sent=1.
 *    Падение любого этапа → откат в 'ожидает' → ретрай на след. тике,
 *    при этом доставленные клиенту письма повторно НЕ отправляются.
 *    🔧 [FIX-3] После MAX_EMAIL_ATTEMPTS неудачных попыток ретрай останавливается.
 *    Перед фазой A сбрасывает зависшие 'письма_отправляются' старше EMAIL_STALE_MINUTES.
 *
 *  Фаза B — письма со ссылкой на скачивание (после оплаты).
 *    Логика прежняя: 'оплачен' → захват 'отправляется' → письмо → 'отправлен'.
 *    🔧 [FIX-4] Ошибка одного заказа больше НЕ прерывает цикл по остальным.
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
            console.warn(`♻️ [RETRY] Восстановлено зависших заказов: ${stale.changes} — письма уйдут повторно (только недоставленные этапы)`);
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

            // 🔧 [FIX-2] Поэтапная доставка: skipClient=true, если клиентское
            // письмо уже доставлено в прошлой попытке (шлём только копию админу).
            // 🔧 [FIX-3] Функция сама ведёт счётчик попыток и останавливает ретрай.
            await deliverOrderEmails(order.inv_id, orderData, !!order.admin_order_mail_sent);
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
                // 🔧 [FIX-4] Раньше здесь был `throw e`, который ВЫЛЕТАЛ из цикла
                // и прерывал обработку всех следующих оплаченных заказов: один
                // постоянно падающий заказ блокировал всю очередь навсегда.
                // Теперь просто откатываем статус — ретрай на следующем тике,
                // а остальные заказы обрабатываются дальше.
                stmt.revertPaid.run(order.inv_id);
                console.error(`❌ Заказ №${order.inv_id}: письмо со ссылкой не ушло (ретрай на следующем тике):`, e.message);
                continue;
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
    if (info.changes > 0) console.log(`🧹 [v2.3.0] Очищено ${info.changes} просроченных токенов.`);
}
setInterval(cleanExpiredTokens, 60 * 60 * 1000);

// ------------------------------------------------------------
// 10. СБОРКА И ОТПРАВКА ПИСЕМ ПРИ СОЗДАНИИ ЗАКАЗА
// ------------------------------------------------------------
/**
 * buildOrderMails(orderData) — собирает письма клиенту (с QR-кодом оплаты)
 * и письмо-копию админу. Ничего не отправляет.
 * Бросает исключение при ошибке сборки (сломанная корзина).
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

    return { clientMailOptions, adminMailOptions };
}

// ── Отправители ──────────────────────────────────────────────
// Клиентское письмо и копия админу разделены (было: один sendOrderEmails
// с Promise.all — при частичном успехе весь заказ откатывался и клиент
// получал дубль). sendOrderEmails оставлен как тонкая обёртка для
// совместимости, но логика доставки — в deliverOrderEmails (FIX-2).
async function sendClientOrderEmail(orderData) {
    const { clientMailOptions } = buildOrderMails(orderData);
    await transporter.sendMail(clientMailOptions);
}

async function sendAdminOrderEmail(orderData) {
    const { adminMailOptions } = buildOrderMails(orderData);
    await transporter.sendMail(adminMailOptions);
}

// Старое имя оставлено для совместимости: шлёт оба письма разом
// (использовать только там, где дубль клиенту не критичен).
async function sendOrderEmails(orderData) {
    const { clientMailOptions, adminMailOptions } = buildOrderMails(orderData);
    await Promise.all([
        transporter.sendMail(clientMailOptions),
        transporter.sendMail(adminMailOptions),
    ]);
}

/**
 * 🔧 [FIX-2] deliverOrderEmails — ЕДИНАЯ точка доставки писем о новом заказе.
 * Вызывается из /api/order (fire-and-forget) и из checkPaidOrders (фаза A).
 *
 * Этапы:
 *   1) bumpEmailAttempts — считаем попытку (FIX-3);
 *   2) если клиентское письмо ещё не доставлено — отправляем и ставим
 *      admin_order_mail_sent=1. Статус ПРЕНАМЕРЕННО остаётся
 *      'письма_отправляются' — это блокирует параллельный тик от
 *      повторной отправки клиенту между этапами;
 *   3) отправляем копию админу;
 *   4) успех: status='ожидает', order_emails_sent=1 — задача закрыта.
 *
 * При ошибке любого этапа: revertEmails (status='ожидает', order_emails_sent=0).
 * admin_order_mail_sent сохраняется → на ретрае клиентское письмо
 * НЕ отправляется повторно.
 *
 * 🔧 [FIX-3] Если попыток стало MAX_EMAIL_ATTEMPTS — ретрай останавливается:
 * заказ помечается order_emails_sent=1 с громким логом (нужно разово
 * глянуть в админке / связаться с клиентом вручную).
 *
 * skipClient=true — клиентское письмо уже доставлено, шлём только админу.
 */
async function deliverOrderEmails(invId, orderData, skipClient = false) {
    stmt.bumpEmailAttempts.run(invId);
    const attempts = ((stmt.getOrder.get(invId) || {}).email_attempts) || 1;

    try {
        if (!skipClient) {
            await sendClientOrderEmail(orderData);
            // Отметку «клиент доставлен» ставим строго ПОСЛЕ успешной sendMail.
            stmt.markClientOrderMailSent.run(invId);
            console.log(`📧 [${invId}] Письмо с QR отправлено клиенту: ${orderData.email}`);
        }
        await sendAdminOrderEmail(orderData);
        stmt.markEmailsSent.run(invId);
        console.log(`✅ [${invId}] Письма о заказе доставлены полностью (клиент + админ).`);
        return true;
    } catch (err) {
        stmt.revertEmails.run(invId); // статус → 'ожидает', order_emails_sent → 0
        if (attempts >= MAX_EMAIL_ATTEMPTS) {
            stmt.markEmailsSent.run(invId); // сдаёмся, чтобы не ретраить вечно
            console.error(`❌ [RETRY] Заказ #${invId}: ${attempts} неудачных попыток — ретрай ОСТАНОВЛЕН. Причина: ${err.message}`);
        } else {
            console.error(`❌ [RETRY] Заказ #${invId}: попытка ${attempts}/${MAX_EMAIL_ATTEMPTS} не удалась (${err.message}) — ретрай на следующем тике.`);
        }
        return false;
    }
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
 * Валидирует данные, сохраняет заказ в БД и МГНОВЕННО отвечает клиенту.
 * Письма (QR клиенту + копия админу) отправляются фоном:
 *   1) сразу после ответа — fire-and-forget;
 *   2) если SMTP упал — откат флага, и checkPaidOrders ретраит на следующем тике.
 * Даже если процесс умрёт между захватом и отправкой — защитная
 * "разморозка" зависших статусов (10 мин) вернёт заказ в очередь.
 * 🔧 [FIX-2] Доставка идёт через deliverOrderEmails (поэтапно) —
 * повторная отправка клиенту после частичной ошибки исключена.
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
        console.log(`📝 [v2.3.0] Заказ #${invId} сохранён в БД. Сумма: ${totalNum} ₽`);

        // ⚡ [RETRY] Атомарно захватываем заказ для отправки писем.
        // Это защищает от гонки: если сейчас же придёт тик checkPaidOrders,
        // он увидит статус 'письма_отправляются' и не отправит второй раз.
        const claim = stmt.claimEmails.run(invId);

        const payPageUrl = `/pay.html?invId=${invId}`;
        // ⚡ [PERF] Отвечаем клиенту СРАЗУ, до отправки писем
        res.json({
            success: true, // ⚡ [PERF] исправлена опечатка 'sucess'
            invId,
            payPageUrl,
        });

        if (claim.changes === 1) {
            const orderData = {
                name, email, phone, comment, cart,
                total: totalNum,
                baseUrl: `${req.protocol}://${req.get('host')}`,
            };

            // ⚡ [RETRY] fire-and-forget: письма не блокируют ответ.
            // 🔧 [FIX-2] Поэтапная доставка (клиент → админ) с ретраем из таймера.
            deliverOrderEmails(invId, orderData)
                .catch(err => console.error(`❌ [${invId}] Неожиданная ошибка фоновой доставки:`, err.message));
        } else {
            console.warn(`⚠️ Заказ #${invId}: не удалось захватить для писем (возможно, дубликат invId)`);
        }
    } catch (error) {
        console.error('❌ [v2.3.0] Ошибка создания заказа:', error);
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
    console.log(`🚀 [v2.3.0] Сервер запущен на http://localhost:${PORT}`);
    console.log(`📧 [v2.3.0] Уведомления на ${EMAIL_CONFIG.notifyEmail}`);
    console.log(`🖥️  [v2.3.0] Админка: http://localhost:${PORT}/admin`);
    testEmail().catch(err => console.error('❌ [v2.3.0] testEmail:', err.message));
    setInterval(checkPaidOrders, 60 * 1000); // каждые 60 сек — обе фазы очереди писем
});
