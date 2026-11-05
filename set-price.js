#!/usr/bin/env node
/**
 * set-price.js — автоматическая смена цены товара в index.html и server.js
 *
 * Использование:
 *   node set-price.js "UKey быстрый старт" 750
 *   node set-price.js "UKey Kalinux" 1200 --dry-run
 *   node set-price.js --list                 # показать все товары и цены
 *
 * Флаги:
 *   --dry-run   только показать diff, ничего не писать
 *   --list      вывести текущие цены из обоих файлов и выйти
 *   --no-backup не создавать .bak-файлы
 */

const fs   = require('fs');
const path = require('path');

const INDEX_FILE  = path.join(__dirname, 'index.html');
const SERVER_FILE = path.join(__dirname, 'server.js');

// ---------- аргументы ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const args  = argv.filter(a => !a.startsWith('--'));

if (flags.has('--list')) {
    listPrices();
    process.exit(0);
}

if (args.length !== 2) {
    console.error('❌ Использование: node set-price.js "<название товара>" <новая цена> [--dry-run]');
    console.error('   Пример: node set-price.js "UKey Kalinux" 1200');
    process.exit(1);
}

const [productName, priceArg] = args;
const newPrice = Number(priceArg.replace(/[^\d.]/g, ''));

if (!Number.isFinite(newPrice) || newPrice <= 0) {
    console.error(`❌ Некорректная цена: "${priceArg}"`);
    process.exit(1);
}

// ---------- основная логика ----------
const dryRun   = flags.has('--dry-run');
const noBackup = flags.has('--no-backup');

let changed = 0;
let errors  = 0;

function backup(file) {
    if (noBackup) return;
    const bak = `${file}.bak-${Date.now()}`;
    fs.copyFileSync(file, bak);
    console.log(`💾 Бэкап: ${path.basename(bak)}`);
}

/**
 * Заменяет price у объекта с данным name в JS-коде.
 * Работает и для `name: "X", price: 500`, и для `name: 'X', price: 500`.
 * Учитывает произвольный порядок полей (ищет name, потом ближайший price в том же {...}).
 */
function patchJsProducts(source, productName, newPrice, label) {
    // Находим все вхождения name: "..." / name: '...'
    const nameRe = /name\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
    let m;
    let matchedObjects = 0;

    while ((m = nameRe.exec(source)) !== null) {
        const foundName = m[2];
        if (foundName.trim() !== productName.trim()) continue;

        // Границы объекта: идём назад до `{` и вперёд до `}` с балансом скобок
        const start = findObjectStart(source, m.index);
        const end   = findObjectEnd(source, m.index);
        if (start < 0 || end < 0) {
            console.error(`⚠️  [${label}] Не удалось определить границы объекта для "${foundName}"`);
            continue;
        }

        let objText = source.slice(start, end + 1);
        const priceRe = /(\bprice\s*:\s*)(\d+(?:\.\d+)?)/;
        if (!priceRe.test(objText)) {
            console.error(`⚠️  [${label}] В объекте "${foundName}" нет поля price`);
            continue;
        }

        const oldObj = objText;
        objText = objText.replace(priceRe, (_, p1) => `${p1}${newPrice}`);
        if (objText !== oldObj) {
            // Применяем точечную замену в исходнике
            const oldPriceMatch = oldObj.match(priceRe);
            const oldPrice = oldPriceMatch ? oldPriceMatch[2] : '?';
            const newObj = source.slice(0, start) + objText + source.slice(end + 1);

            console.log(`✏️  [${label}] "${foundName}": ${oldPrice} ₽ → ${newPrice} ₽`);
            changed++;
            matchedObjects++;
            return { source: newObj, count: matchedObjects };
        }
    }

    return { source, count: 0 };
}

function findObjectStart(src, idx) {
    let depth = 0;
    for (let i = idx; i >= 0; i--) {
        const ch = src[i];
        if (ch === '}') depth++;
        else if (ch === '{') {
            if (depth === 0) return i;
            depth--;
        }
    }
    return -1;
}

function findObjectEnd(src, idx) {
    let depth = 0;
    for (let i = idx; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            if (depth === 0) return i;
            depth--;
        }
    }
    return -1;
}

function processFile(file, label) {
    if (!fs.existsSync(file)) {
        console.error(`❌ Файл не найден: ${file}`);
        errors++;
        return;
    }
    const src = fs.readFileSync(file, 'utf8');
    const { source: patched, count } = patchJsProducts(src, productName, newPrice, label);

    if (count === 0) {
        console.warn(`⚠️  [${label}] Товар "${productName}" не найден (или price уже ${newPrice})`);
        return;
    }

    if (dryRun) {
        console.log(`🔎 [${label}] dry-run — файл НЕ изменён`);
        return;
    }

    backup(file);
    fs.writeFileSync(file, patched, 'utf8');
    console.log(`✅ [${label}] Записано: ${path.basename(file)}`);
}

function listPrices() {
    for (const [file, label] of [[INDEX_FILE, 'index.html'], [SERVER_FILE, 'server.js']]) {
        console.log(`\n📄 ${label}`);
        if (!fs.existsSync(file)) { console.log('   (файл не найден)'); continue; }
        const src = fs.readFileSync(file, 'utf8');
        const re  = /name\s*:\s*(['"])((?:\\.|(?!\1).)*)\1\s*,\s*(?:price\s*:\s*(\d+(?:\.\d+)?))/g;
        // на случай другого порядка полей — второй проход
        const entries = [];
        let m;
        while ((m = re.exec(src)) !== null) entries.push({ name: m[2], price: m[3] });

        if (entries.length === 0) {
            // fallback: ищем объекты по name и вытаскиваем price из {...}
            const nameRe = /name\s*:\s*(['"])((?:\\.|(?!\1).)*)\1/g;
            let n;
            while ((n = nameRe.exec(src)) !== null) {
                const start = findObjectStart(src, n.index);
                const end   = findObjectEnd(src, n.index);
                if (start < 0 || end < 0) continue;
                const obj = src.slice(start, end + 1);
                const pm  = obj.match(/\bprice\s*:\s*(\d+(?:\.\d+)?)/);
                if (pm) entries.push({ name: n[2], price: pm[1] });
            }
        }

        entries.forEach(e => console.log(`   • ${e.name} — ${e.price} ₽`));
    }
}

console.log(`\n🎯 Товар: "${productName}"  →  новая цена: ${newPrice} ₽${dryRun ? '  (dry-run)' : ''}\n`);
processFile(INDEX_FILE,  'index.html');
processFile(SERVER_FILE, 'server.js');

console.log(`\n📊 Итог: изменено объектов — ${changed}, ошибок — ${errors}\n`);
process.exit(errors > 0 ? 1 : 0);
