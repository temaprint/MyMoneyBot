#!/bin/bash
# deploy.sh — деплой RUI-бота и дашборда на сервер
#
# Usage:
#   ./deploy.sh            # полный деплой (rsync + build + up)
#   ./deploy.sh --quick    # без пересборки образов
#   ./deploy.sh --check    # только статус на сервере
#
# Переменные окружения:
#   SSH_KEY   — путь к SSH-ключу (по умолчанию ~/.ssh/id_ed25519)
#   SERVER    — user@host сервера (или DEPLOY_SERVER в .env)
#   REMOTE_DIR — путь на сервере (или DEPLOY_DIR в .env, по умолчанию ~/rui)

set -e
cd "$(dirname "$0")"

# Сервер и путь: переменные окружения или .env (DEPLOY_SERVER / DEPLOY_DIR), в git не попадают
env_value() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2 || true; }
SERVER="${SERVER:-$(env_value DEPLOY_SERVER)}"
REMOTE_DIR="${REMOTE_DIR:-$(env_value DEPLOY_DIR)}"
REMOTE_DIR="${REMOTE_DIR:-rui}"
[ -n "$SERVER" ] || { echo "ОШИБКА: не задан сервер (DEPLOY_SERVER=user@host в .env или export SERVER=user@host)"; exit 1; }
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
APP_PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2 || true)"
APP_PORT="${APP_PORT:-3005}"

QUICK_MODE=false
CHECK_ONLY=false
for arg in "$@"; do
  case $arg in
    --quick|-q) QUICK_MODE=true ;;
    --check|-c) CHECK_ONLY=true ;;
  esac
done

ssh_run() { ssh -i "$SSH_KEY" -o ConnectTimeout=15 "$SERVER" "$*"; }
# упавший билд не должен маскироваться пайпом в tail — иначе деплой «пройдёт» со старым образом
ssh_run_strict() { ssh -i "$SSH_KEY" -o ConnectTimeout=15 "$SERVER" "set -o pipefail && $*"; }

echo ""
echo "=== RUI deploy -> $SERVER:$REMOTE_DIR ==="
echo ""

check_status() {
  echo "--- Статус контейнеров ---"
  ssh_run "cd $REMOTE_DIR && docker compose ps" || { echo "ОШИБКА: нет соединения или контейнеры не запущены"; exit 1; }
  echo ""
  echo "--- Логи app (последние 20 строк) ---"
  ssh_run "cd $REMOTE_DIR && docker compose logs --tail=20 app" || true
  echo ""
  echo "--- Health check ---"
  ssh_run "curl -sS -m 5 http://127.0.0.1:$APP_PORT/api/health" || true
  echo ""
  echo "--- Ротация логов Docker (daemon.json) ---"
  ssh_run "grep -q max-size /etc/docker/daemon.json 2>/dev/null" \
    && echo "OK: глобальная ротация настроена" \
    || echo "ВНИМАНИЕ: нет /etc/docker/daemon.json с max-size — логи могут расти бесконечно (см. скилл docker-optimize, Часть 3)"
}

if [ "$CHECK_ONLY" = true ]; then
  check_status
  exit 0
fi

# --- Pre-flight ---
echo "--- Pre-flight ---"
for f in docker-compose.yml Dockerfile .env prisma/schema.prisma src/index.js; do
  [ -f "$f" ] || { echo "ОШИБКА: нет файла $f"; exit 1; }
done
[ -f "$SSH_KEY" ] || { echo "ОШИБКА: SSH-ключ не найден: $SSH_KEY (задайте: export SSH_KEY=/path/to/key)"; exit 1; }
echo "OK"

# --- Синхронизация кода ---
echo "--- Sync файлов на сервер ---"
rsync -avz --delete \
  -e "ssh -i $SSH_KEY" \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'docker-compose.dev.yml' \
  --exclude 'data' \
  --exclude '*.log' \
  --exclude '.DS_Store' \
  ./ "$SERVER:$REMOTE_DIR/"
echo "OK"

# --- .env отдельно ---
echo "--- Копирование .env ---"
scp -q -i "$SSH_KEY" .env "$SERVER:$REMOTE_DIR/.env"
echo "OK"

# --- Сборка ---
if [ "$QUICK_MODE" = true ]; then
  echo "--- Сборка пропущена (--quick) ---"
else
  echo "--- Docker build (может занять пару минут) ---"
  ssh_run_strict "cd $REMOTE_DIR && docker compose build --pull 2>&1 | tail -5"
  echo "OK"
fi

# --- Перезапуск ---
echo "--- Перезапуск контейнеров ---"
ssh_run "cd $REMOTE_DIR && docker compose down && docker compose up -d"
sleep 5

# --- Уборка старых образов (volumes не трогаем) ---
echo "--- Prune неиспользуемых образов ---"
ssh_run "docker image prune -a -f >/dev/null && docker builder prune -f >/dev/null" || true

check_status

echo "=== ДЕПЛОЙ ЗАВЕРШЁН ==="
echo "Дашборд: $(grep -E '^APP_URL=' .env | cut -d= -f2 || echo "$SERVER") (Nginx -> 127.0.0.1:$APP_PORT)"
echo "Команды: ./deploy.sh --check | ./deploy.sh --quick"
