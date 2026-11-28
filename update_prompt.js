const fs = require('fs');
const path = require('path');

let newText = '';

// Читаем весь вводимый текст из консоли до нажатия Ctrl+D
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => newText += chunk);

process.stdin.on('end', () => {
    newText = newText.trim();
    if (!newText) {
        console.error('❌ Ошибка: Текст пустой. Отмена.');
        process.exit(1);
    }

    const serverFile = path.join(__dirname, 'server.js');
    if (!fs.existsSync(serverFile)) {
        console.error('❌ Ошибка: server.js не найден в этой папке.');
        process.exit(1);
    }

    let src = fs.readFileSync(serverFile, 'utf8');

    // Экранируем обратные кавычки и ${}, чтобы не сломать шаблонную строку JS
    const safeText = newText.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

    // Регулярное выражение для поиска блока SYSTEM_PROMPT
    // Оно ищет "const SYSTEM_PROMPT = `" и всё до закрывающей "`;"
    const regex = /const\s+SYSTEM_PROMPT\s*=\s*`[\s\S]*?`;/;

    if (!regex.test(src)) {
        console.error('❌ Ошибка: Блок `const SYSTEM_PROMPT = \`...\`;` не найден в server.js.');
        process.exit(1);
    }

    // Заменяем старый промпт на новый
    src = src.replace(regex, 'const SYSTEM_PROMPT = `' + safeText + '`;');
    fs.writeFileSync(serverFile, src, 'utf8');

    console.log('\n✅ Успех! SYSTEM_PROMPT в server.js успешно обновлен.');
});
