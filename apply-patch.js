// apply-patch.js
// Точечный патч server.js по маркерам. Делает бэкап server.js.bak
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'server.js');
const BAK  = path.join(__dirname, `server.js.bak.${Date.now()}`);

let src = fs.readFileSync(FILE, 'utf8');
fs.writeFileSync(BAK, src);
console.log(`💾 Бэкап: ${BAK}`);

let applied = 0;
let failed  = [];

function patch(name, from, to) {
    if (!src.includes(from)) {
        failed.push(name);
        console.warn(`⚠️  [${name}] маркер не найден — пропущено`);
        return;
    }
    if (src.includes(to) && to.length > 20) {
        console.log(`ℹ️  [${name}] похоже, уже применено — пропущено`);
        return;
    }
    src = src.replace(from, to);
    applied++;
    console.log(`✅ [${name}] применено`);
}

// ─────────────────────────────────────────────────────────
// 1. Убрать двойной checkAuth с роутов
// ─────────────────────────────────────────────────────────
patch(
    '1a. attach-link — убрать checkAuth',
    "app.post('/api/admin/attach-link', checkAuth,(req, res) => {",
    "app.post('/api/admin/attach-link', (req, res) => {"
);

patch(
    '1b. orders — убрать checkAuth',
    "app.get('/api/admin/orders',checkAuth , (req, res) => {",
    "app.get('/api/admin/orders', (req, res) => {"
);

// ─────────────────────────────────────────────────────────
// 2. Починить проверку дубликата ссылки (искать в file_links по url)
// ─────────────────────────────────────────────────────────
patch(
    '2. existingLink — искать в file_links по url',
    `      const existingLink = db.prepare('SELECT * FROM pending_orders WHERE inv_id = ?').get(fileUrl);
if (existingLink){
          return res.status(400).json({
               error: \`Эта ссылка уже прикреплена к заказу #\${existingLink.inv_id}. Выберите другую!\`
});

}`,
    `      const existingLink = db.prepare('SELECT * FROM file_links WHERE url = ?').get(fileUrl);
      if (existingLink) {
          return res.status(400).json({
              error: \`Эта ссылка уже прикреплена к заказу #\${existingLink.inv_id}. Выберите другую!\`
          });
      }`
);

// ─────────────────────────────────────────────────────────
// 3. Защита от повторной отправки письма в attach-link
// ─────────────────────────────────────────────────────────
patch(
    '3. attach-link — защита от повторной отправки',
    `        const order = db.prepare('SELECT * FROM pending_orders WHERE inv_id = ?').get(invId);
        if (!order) return res.status(404).json({ error: 'Заказ не найден' });`,
    `        const order = db.prepare('SELECT * FROM pending_orders WHERE inv_id = ?').get(invId);
        if (!order) return res.status(404).json({ error: 'Заказ не найден' });

        if (order.sent_to_client === 1) {
            return res.status(400).json({
                error: 'Письмо клиенту уже отправлено. Сначала сбросьте sent_to_client вручную.'
            });
        }`
);

// ─────────────────────────────────────────────────────────
// 4. Атомарный захват в checkPaidOrders
// ─────────────────────────────────────────────────────────
patch(
    '4. checkPaidOrders — атомарный захват',
    `            // 4. Отправляем письмо
            await sendFileToClient(order);

            // 5. Помечаем как отправленный
            db.prepare(\`
                UPDATE pending_orders
                SET status = 'отправлен', sent_to_client = 1
                WHERE inv_id = ?
            \`).run(order.inv_id);`,
    `            // 4. Атомарно захватываем заказ, чтобы не отправить дважды
            const claim = db.prepare(\`
                UPDATE pending_orders
                SET status = 'отправляется'
                WHERE inv_id = ? AND status = 'оплачен' AND sent_to_client = 0
            \`).run(order.inv_id);
            if (claim.changes !== 1) {
                console.log(\`⏭️  Заказ #\${order.inv_id} уже кем-то захвачен — пропуск\`);
                continue;
            }

            // 5. Отправляем письмо
            try {
                await sendFileToClient(order);
            } catch (e) {
                // откатываем статус, чтобы попробовать снова на следующем тике
                db.prepare(\`
                    UPDATE pending_orders SET status = 'оплачен' WHERE inv_id = ?
                \`).run(order.inv_id);
                throw e;
            }

            // 6. Помечаем как отправленный
            db.prepare(\`
                UPDATE pending_orders
                SET status = 'отправлен', sent_to_client = 1
                WHERE inv_id = ?
            \`).run(order.inv_id);`
);

// ─────────────────────────────────────────────────────────
// 5. Проверка даты file_created_at
// ─────────────────────────────────────────────────────────
patch(
    '5. checkPaidOrders — валидация даты',
    `            // 3. Проверяем срок давности ссылки
            const linkDate = new Date(order.file_created_at);
            const now      = new Date();
            const diffDays = (now - linkDate) / (1000 * 60 * 60 * 24);`,
    `            // 3. Проверяем срок давности ссылки
            const linkDate = new Date(order.file_created_at);
            if (!linkDate || isNaN(linkDate.getTime())) {
                console.log(\`❌ Заказ №\${order.inv_id}: некорректный file_created_at\`);
                continue;
            }
            const now      = new Date();
            const diffDays = (now - linkDate) / (1000 * 60 * 60 * 24);`
);

// ─────────────────────────────────────────────────────────
// 6. Флаг защиты таймера (переписать checkPaidOrders)
// ─────────────────────────────────────────────────────────
// Заменяем начало функции и её обёртку
patch(
    '6a. checkPaidOrders — обёртка с флагом',
    `async function checkPaidOrders() {
    try {`,
    `let __checkingPaidOrders = false;
async function checkPaidOrders() {
    if (__checkingPaidOrders) {
        console.log('⏭️  checkPaidOrders уже выполняется — пропуск тика');
        return;
    }
    __checkingPaidOrders = true;
    try {`
);

patch(
    '6b. checkPaidOrders — finally сбрасывает флаг',
    `    } catch (err) {
        console.error('Ошибка при проверке оплаченных заказов:', err.message);
    }
}`,
    `    } catch (err) {
        console.error('Ошибка при проверке оплаченных заказов:', err.message);
    } finally {
        __checkingPaidOrders = false;
    }
}`
);

// ─────────────────────────────────────────────────────────
// 7. Исправить лог админки
// ─────────────────────────────────────────────────────────
patch(
    '7. лог админки /admin.html → /admin',
    "console.log(`🖥️  [v2.1.0] Админка: http://localhost:${PORT}/admin.html`);",
    "console.log(`🖥️  [v2.1.0] Админка: http://localhost:${PORT}/admin`);"
);

// ─────────────────────────────────────────────────────────
// 8. Env для notifyEmail
// ─────────────────────────────────────────────────────────
patch(
    '8. notifyEmail из env',
    "    notifyEmail: 'gafarOf@yandex.ru',",
    "    notifyEmail: process.env.NOTIFY_EMAIL || 'gafarOf@yandex.ru',"
);

// ─────────────────────────────────────────────────────────
// Итог
// ─────────────────────────────────────────────────────────
fs.writeFileSync(FILE, src);
console.log('');
console.log(`📊 Применено: ${applied} | Пропущено: ${failed.length}`);
if (failed.length) {
    console.log('❌ Не найдены маркеры для:');
    failed.forEach(n => console.log('   - ' + n));
    console.log('💡 Проверьте, что server.js не менялся вручную в этих местах.');
    process.exit(1);
} else {
    console.log('✅ Все патчи применены. Проверьте diff:');
    console.log(`   diff -u ${path.basename(BAK)} server.js`);
}
