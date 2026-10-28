#!/bin/bash

# Цвета для красивого вывода
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Путь к проекту
PROJECT_DIR="/home/gangster/my-node-app"
SERVER_FILE="$PROJECT_DIR/server.js"
SERVICE_NAME="node-app"

# Функция для вывода заголовка
print_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${GREEN}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

# Функция проверки синтаксиса
check_syntax() {
    print_header "🔍 Проверка синтаксиса server.js"
    if node -c "$SERVER_FILE" 2>/dev/null; then
        echo -e "${GREEN}✅ Синтаксис правильный!${NC}"
        return 0
    else
        echo -e "${RED}❌ Ошибка синтаксиса!${NC}"
        echo -e "${YELLOW}Подробности:${NC}"
        node -c "$SERVER_FILE"
        return 1
    fi
}

# Функция перезапуска сервера
restart_server() {
    print_header "🔄 Перезапуск сервера"
    sudo systemctl restart "$SERVICE_NAME"
    echo -e "${GREEN}✅ Сервер перезапущен${NC}"
}

# Функция проверки статуса
check_status() {
    print_header "📊 Статус сервера"
    sudo systemctl status "$SERVICE_NAME" --no-pager
}

# Функция показа логов
show_logs() {
    print_header "📋 Последние логи (Ctrl+C для выхода)"
    sudo journalctl -u "$SERVICE_NAME" -f
}

# Функция остановки сервера
stop_server() {
    print_header "🛑 Остановка сервера"
    sudo systemctl stop "$SERVICE_NAME"
    echo -e "${GREEN}✅ Сервер остановлен${NC}"
}

# Функция запуска сервера
start_server() {
    print_header "🚀 Запуск сервера"
    sudo systemctl start "$SERVICE_NAME"
    echo -e "${GREEN}✅ Сервер запущен${NC}"
}

# Функция полного деплоя (проверка + перезапуск)
deploy() {
    print_header "🚀 Деплой приложения"
    if check_syntax; then
        restart_server
        sleep 2
        check_status
        echo -e "\n${GREEN}✅ Деплой успешно завершен!${NC}"
        echo -e "${YELLOW}🌐 Откройте: http://localhost${NC}"
    else
        echo -e "${RED}❌ Деплой отменен из-за ошибок синтаксиса${NC}"
        return 1
    fi
}

# Функция показа меню
show_menu() {
    echo -e "${BLUE}╔══════════════════════════════════╗${NC}"
    echo -e "${BLUE}║   Управление Node.js сервером    ║${NC}"
    echo -e "${BLUE}╠══════════════════════════════════╣${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}1${NC}) 🚀 Деплой (проверка + перезапуск) ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}2${NC}) ✅ Проверить синтаксис           ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}3${NC}) 🔄 Перезапустить сервер          ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}4${NC}) 🟢 Запустить сервер              ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}5${NC}) 🔴 Остановить сервер             ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}6${NC}) 📊 Статус сервера                ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}7${NC}) 📋 Смотреть логи                 ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}8${NC}) 🧪 Тестовый запрос               ${BLUE}║${NC}"
    echo -e "${BLUE}║${NC} ${GREEN}0${NC}) 🚪 Выход                         ${BLUE}║${NC}"
    echo -e "${BLUE}╚══════════════════════════════════╝${NC}"
    echo -n "Выберите действие [0-8]: "
}

# Функция тестового запроса
test_request() {
    print_header "🧪 Тестовый запрос к серверу"
    echo -e "${YELLOW}Запрос к http://localhost...${NC}"
    if curl -s -o /dev/null -w "%{http_code}" http://localhost | grep -q "200"; then
        echo -e "${GREEN}✅ Сервер отвечает (HTTP 200 OK)${NC}"
        echo -e "\n${YELLOW}Содержимое главной страницы:${NC}"
        curl -s http://localhost | head -20
    else
        echo -e "${RED}❌ Сервер не отвечает или ошибка${NC}"
    fi
}

# Главная функция
main() {
    # Проверяем существование файла server.js
    if [ ! -f "$SERVER_FILE" ]; then
        echo -e "${RED}❌ Ошибка: Файл server.js не найден в $PROJECT_DIR${NC}"
        exit 1
    fi
    
    # Если передан аргумент командной строки
    case "$1" in
        "deploy") deploy ;;
        "check") check_syntax ;;
        "restart") restart_server ;;
        "start") start_server ;;
        "stop") stop_server ;;
        "status") check_status ;;
        "logs") show_logs ;;
        "test") test_request ;;
        "")
            # Интерактивный режим
            while true; do
                echo ""
                show_menu
                read choice
                case $choice in
                    1) deploy ;;
                    2) check_syntax ;;
                    3) restart_server ;;
                    4) start_server ;;
                    5) stop_server ;;
                    6) check_status ;;
                    7) show_logs ;;
                    8) test_request ;;
                    0) 
                        echo -e "${GREEN}До свидания! 👋${NC}"
                        exit 0
                        ;;
                    *)
                        echo -e "${RED}❌ Неверный выбор. Попробуйте снова.${NC}"
                        ;;
                esac
                echo ""
                read -p "Нажмите Enter для продолжения..."
            done
            ;;
        *)
            echo -e "${RED}❌ Неизвестная команда: $1${NC}"
            echo "Использование: $0 [deploy|check|restart|start|stop|status|logs|test]"
            exit 1
            ;;
    esac
}

# Запуск главной функции
main "$1"
