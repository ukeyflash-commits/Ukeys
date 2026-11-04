#!/usr/bin/env bash


set -euo pipefail

#Bismillyah!!======================SETTINGS======31.10.2026==

APP_DIR="/var/www/my-node-app"
GIT_BRANCH="master"
SERVICE_NAME="myapp"
NODE_ENV="production"
LOG_FILE="/var/log/myapp-deploy.log"

#ЛОГИРОВАНИЕ И В КОНСОЛЬ И В ФАЙЛ
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo -e "\n[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
fail() { echo -e "\n[$\u274C ОШИБКА:  $*" >&2; exit 1; }

log   "==================   НАЧАЛО ДЕПЛОЯ   ==================  "

# ------- 1.Проверки ----------

[ -d  "$APP_DIR" ] || fail "Папка проекта не найдена: $APP_DIR"
command -v git >/dev/null || fail "git не установлен"
command -v node >/dev/null || fail "node не установлен"
command -v npm >/dev/null || fail "npm не установлен"

cd "$APP_DIR" || fail "Не удалолось перейти в $APP_DIR"

#------------------2.ТЕКУЩАЯ ВЕТКА РАЗРАБОТКИ-----------------------------
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
log "Текущая ветка: $CURRENT_BRANCH | Целевая: $GIT_BRANCH"

if [ "$CURRENT_BRANCH" != "$GIT_BRANCH" ];then
    log "Переключаюсь на ветку $GIT_BRANCH..."
    git fetch origin "$GIT_BRANCH"
    git checkout "$GIT_BRANCH"
fi


#================== 3.ЗАБИРАЕМ ИЗМЕНЕНИЯ с GIT ===================

log "git pull origin $GIT_BRANCH ..."

git pull origin "$GIT_BRANCH" || fail "git pull не удался!!!"

log "Последний коммит: $(git log -1 --oneline)"


#---------------------------  4.Зависимости -----------------------------------------

log "Устанавливаю  зависимости (npm ci)..."
if [ -f package-lock.json ]; then
    npm ci --omit=dev
else
   log "package-lock.json не найден --- использую npm install"
npm install --omit=dev
fi


#------------------ 5.Сборка если есть 

if grep -q "build" package.json 2>/dev/null; then
  log "Сборка проекта (npm run build)..."
NODE_ENV="$NODE_ENV" npm run build
else 
  log "Скрипт buid не найден -- пропускаю сборку" 
fi

#-------------------- 6. Перезапуск службы -----------------

log "Перезапускаю службу: $SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME" || fail "Не удалось перезапустить $SERVICE_NAME" 

sleep 2

if sudo systemctl is-active --quiet "$SERVICE_NAME"; then 
    log "!!!Служба $SERVICE_NAME активна"
else 
   sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager || true
fail "Служба $SERVICE_NAME не запустилась ----- смотрите логи выше" 
fi


log "---------------------------Ин ша Аллах! Деплой завершен успешно!---------------"



