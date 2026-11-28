/**
 * ============================================================
 * VISIT-COUNTER — независимый счётчик посетителей, v2.1
 * ------------------------------------------------------------
 * ИСПРАВЛЕНО:
 *   - uniqueToday теперь корректно сбрасывается в полночь
 *   - добавлен опциональный authMiddleware для /api/visits/* и /visits-stats
 *
 * Эндпоинты:
 *   POST /api/visit          — фиксация визита (сниппет со страниц)
 *   GET  /api/visits/total   — { total, today, uniqueToday }
 *   GET  /api/visits/days    — массив по дням за N дней (?days=7|30)
 *   GET  /api/visits/badge   — SVG-бейдж «Посетителей: N»
 *   GET  /visits-stats       — страница со статистикой и графиком
 * ============================================================
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DATA_FILE     = path.join(__dirname, 'visits.json');
const SAVE_EVERY_MS = 30 * 1000;

// ── Хранилище ──────────────────────────────────────────────
// uniqueDay — дата, к которой относится uniqueToday (для сброса в полночь)
let data = { total: 0, days: {}, uniqueToday: 0, uniqueDay: null, visitors: {} };

try {
    if (fs.existsSync(DATA_FILE)) {
        data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (typeof data.uniqueToday !== 'number') data.uniqueToday = 0;
        if (typeof data.uniqueDay  !== 'string')  data.uniqueDay  = null;
        if (!data.visitors) data.visitors = {};
        // На случай если старый файл содержал раздутый uniqueToday —
        // пересчитываем его из visitors (там только сегодняшние хеши).
        const today = new Date().toISOString().slice(0, 10);
        data.uniqueToday = Object.values(data.visitors)
            .filter(v => v === today).length;
        data.uniqueDay = today;
        console.log('📊 [counter] Загружено визитов:', data.total,
                    '| уникальных сегодня (пересчитано):', data.uniqueToday);
    }
} catch (e) {
    console.error('📊 [counter] Не смог прочитать visits.json:', e.message);
}

let dirty = false;
setInterval(() => {
    if (!dirty) return;
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify(data));
        dirty = false;
    } catch (e) {
        console.error('📊 [counter] Ошибка сохранения:', e.message);
    }
}, SAVE_EVERY_MS);

process.on('exit',    () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(data)); } catch (_) {} });
process.on('SIGINT',  () => process.exit());
process.on('SIGTERM', () => process.exit());

const todayKey = () => new Date().toISOString().slice(0, 10);

// ── Регистрация визита ────────────────────────────────────
function registerVisit(req) {
    const day = todayKey();

    // ⬇️ ГЛАВНЫЙ ФИКС: сброс uniqueToday при смене дня
    if (data.uniqueDay !== day) {
        data.uniqueDay   = day;
        data.uniqueToday = 0;
        data.visitors    = {};   // чистим хеши прошлых дней
    }

    const ua  = req.headers['user-agent'] || '';
    const raw = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + '|' + ua;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);

    data.total++;
    data.days[day] = (data.days[day] || 0) + 1;

    if (data.visitors[hash] !== day) {
        data.visitors[hash] = day;
        data.uniqueToday++;
    }
    dirty = true;
}

// ── Ряд по дням для графика ────────────────────────────────
function getDailySeries(nDays) {
    const n = Math.min(Math.max(parseInt(nDays) || 7, 1), 90);
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        const key = d.toISOString().slice(0, 10);
        out.push({
            date:  key,
            label: key.slice(8, 10) + '.' + key.slice(5, 7),
            visits: data.days[key] || 0,
        });
    }
    return out;
}

// ── Роуты ──────────────────────────────────────────────────
function mountRoutes(app, auth) {
    // публичный трекер — всегда открыт (его дёргает сниппет на страницах)
    app.post('/api/visit', (req, res) => {
        registerVisit(req);
        res.json({ ok: true });
    });

    // всё ниже — опционально под auth
    const guard = auth || ((req, res, next) => next());

    app.get('/api/visits/total', guard, (req, res) => {
        const day = todayKey();
        res.json({
            total:       data.total,
            today:       data.days[day] || 0,
            uniqueToday: data.uniqueToday || 0,
        });
    });

    app.get('/api/visits/days', guard, (req, res) => {
        res.json({ ok: true, days: getDailySeries(req.query.days) });
    });

    app.get('/api/visits/badge', guard, (req, res) => {
        const n = data.total.toLocaleString('ru-RU');
        const w = 24 + n.length * 9;
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'no-store');
        res.send(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="24">` +
            `<rect width="${w}" height="24" rx="4" fill="#667eea"/>` +
            `<text x="12" y="16" fill="#fff" font-family="Arial" font-size="12">Посетителей: ${n}</text>` +
            `</svg>`
        );
    });

    app.get('/visits-stats', guard, (req, res) => {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html>
        <html lang="ru">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Статистика визитов — UKeys</title>
        <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; background: #f4f6fb; color: #333;
               max-width: 720px; margin: 0 auto; padding: 24px 16px; }
        h1 { font-size: 22px; margin-bottom: 4px; }
        .sub { color: #888; font-size: 13px; margin-bottom: 20px; }
        .cards { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 24px; }
        .card { flex: 1 1 140px; background: #fff; border-radius: 10px; padding: 14px 16px;
                box-shadow: 0 1px 4px rgba(0,0,0,.08); }
        .card .num { font-size: 26px; font-weight: bold; color: #667eea; }
        .card .lbl { font-size: 12px; color: #888; margin-top: 2px; }
        .chart { background: #fff; border-radius: 10px; padding: 20px 16px 8px;
                 box-shadow: 0 1px 4px rgba(0,0,0,.08); }
        .chart h2 { font-size: 15px; margin-bottom: 16px; }
        .bars { display: flex; align-items: flex-end; gap: 6px; height: 160px; padding-bottom: 6px; }
        .bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center;
                    justify-content: flex-end; height: 100%; }
        .bar-val { font-size: 11px; color: #555; margin-bottom: 2px; }
        .bar { width: 100%; max-width: 42px; background: linear-gradient(180deg,#667eea,#764ba2);
               border-radius: 5px 5px 0 0; min-height: 3px; transition: height .4s ease; }
        .bar.today { background: linear-gradient(180deg,#28a745,#1e7e34); }
        .labels { display: flex; gap: 6px; margin-top: 6px; }
        .labels span { flex: 1; text-align: center; font-size: 10px; color: #999;
                       max-width: 42px; overflow: hidden; }
        .switch { margin-top: 16px; }
        .switch a { display: inline-block; padding: 6px 14px; margin-right: 6px; font-size: 13px;
                    color: #667eea; text-decoration: none; border: 1px solid #667eea;
                    border-radius: 6px; }
        .switch a.active { background: #667eea; color: #fff; }
        </style>
        </head>
        <body>
        <h1>📊 Статистика визитов</h1>
        <div class="sub">UKeys Shop — счётчик независимый, данные в visits.json</div>
        <div class="cards">
        <div class="card"><div class="num" id="c-total">…</div><div class="lbl">Всего визитов</div></div>
        <div class="card"><div class="num" id="c-today">…</div><div class="lbl">Сегодня</div></div>
        <div class="card"><div class="num" id="c-unique">…</div><div class="lbl">Уникальных сегодня</div></div>
        </div>
        <div class="chart">
        <h2>Визиты по дням</h2>
        <div class="bars" id="bars"></div>
        <div class="labels" id="labels"></div>
        <div class="switch">
        <a href="?days=7" id="sw-7">7 дней</a>
        <a href="?days=30" id="sw-30">30 дней</a>
        </div>
        </div>
        <script>
        const nDays = (new URLSearchParams(location.search).get('days') === '30') ? 30 : 7;
        document.getElementById('sw-' + nDays).classList.add('active');
        fetch('/api/visits/total').then(r => r.json()).then(d => {
            document.getElementById('c-total').textContent  = d.total.toLocaleString('ru-RU');
            document.getElementById('c-today').textContent  = d.today.toLocaleString('ru-RU');
            document.getElementById('c-unique').textContent = d.uniqueToday.toLocaleString('ru-RU');
        });
        fetch('/api/visits/days?days=' + nDays).then(r => r.json()).then(d => {
            const bars = document.getElementById('bars');
            const labels = document.getElementById('labels');
            const max = Math.max(...d.days.map(x => x.visits), 1);
            const todayKey = new Date().toISOString().slice(0, 10);
            d.days.forEach(day => {
                const h = Math.round((day.visits / max) * 130);
                const wrap = document.createElement('div');
                wrap.className = 'bar-wrap';
                wrap.innerHTML =
                    '<div class="bar-val">' + (day.visits || '') + '</div>' +
                    '<div class="bar ' + (day.date === todayKey ? 'today' : '') + '" ' +
                    'style="height:' + h + 'px" title="' + day.date + ': ' + day.visits + '"></div>';
                bars.appendChild(wrap);
                const lbl = document.createElement('span');
                lbl.textContent = (nDays <= 7) ? day.label : (day.date.slice(8, 10));
                labels.appendChild(lbl);
            });
        });
        </script>
        </body>
        </html>`);
    });
}

// ── Режим 1: встроить в существующий app ───────────────────
function attachVisitCounter(app, authMiddleware) {
    mountRoutes(app, authMiddleware);
    console.log('📊 [counter] Подключён (/api/visit, /api/visits/*, /visits-stats)',
                authMiddleware ? '| статистика под auth' : '| статистика публичная');
}

// ── Режим 2: автономный сервер ─────────────────────────────
if (require.main === module) {
    const express = require('express');
    const PORT = process.env.VISIT_PORT || 3001;
    const app = express();
    app.use(express.json());
    mountRoutes(app);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(`📊 [counter] Запущен независимо на http://localhost:${PORT}`)
    );
}

module.exports = { attachVisitCounter, registerVisit, getDailySeries };
