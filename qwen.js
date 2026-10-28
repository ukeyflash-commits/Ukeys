async function main() {
  try {
    const res = await fetch('http://localhost:8080/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'coder-model',
        messages: [{ role: 'user', content: 'Привет! Напиши 1 строку кода на JS.' }]
      })
    });

    // Сначала проверяем, ответил ли сервер успешно (код 200)
    if (!res.ok) {
      console.log(`Сервер вернул ошибку HTTP ${res.status}`);
    }

    // Читаем ответ как текст, чтобы увидеть, что реально пришло
    const textData = await res.text();
    
    try {
      // Пытаемся распарсить как JSON
      const data = JSON.parse(textData);
      
      // Безопасно проверяем наличие нужных полей
      if (data.choices && data.choices[0] && data.choices[0].message) {
        console.log("Ответ нейросети:");
        console.log(data.choices[0].message.content);
      } else {
        console.log("Пришел JSON, но структура другая. Вот что ответил сервер:");
        console.log(data);
      }
    } catch (e) {
      console.log("Сервер вернул не JSON. Вот сырой ответ:");
      console.log(textData);
    }
    
  } catch (error) {
    console.error('Ошибка сети (прокси не запущен?):', error.message);
  }
}

main();
