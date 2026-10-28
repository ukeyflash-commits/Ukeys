// Динамические эффекты
document.addEventListener('DOMContentLoaded', function() {
    console.log('Сайт загружен, статика работает!');
    
    // Добавляем анимацию для карточек
    const cards = document.querySelectorAll('.card');
    cards.forEach((card, index) => {
        card.style.animationDelay = `${index * 0.1}s`;
        card.style.animation = 'fadeInUp 0.5s ease-out';
    });
});

// Добавляем CSS анимацию
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeInUp {
        from {
            opacity: 0;
            transform: translateY(20px);
        }
        to {
            opacity: 1;
            transform: translateY(0);
        }
    }
`;
document.head.appendChild(style);
// Функция для кнопки
function testFunction() {
    const messageDiv = document.getElementById('message');
    if (messageDiv) {
        messageDiv.innerHTML = '🎉 Кнопка успешно нажата! ПУСТЬ JavaScript работает:)';
        messageDiv.style.color = '#764ba2';
        messageDiv.style.fontWeight = 'bold';
        messageDiv.style.marginTop = '15px';
        
        // Через 3 секунды очищаем сообщение
        setTimeout(() => {
            messageDiv.innerHTML = '';
        }, 3000);
    } else {
        console.error('Элемент message не найден');
        alert('Кнопка нажата! (alert)');
    }
}

console.log('JS файл загружен, testFunction доступна');
