#!/bin/bash
# install-nginx-templates.sh — установка Nginx/Hestia-шаблонов rui-app
# для проксирования домена на 127.0.0.1:APP_PORT (Docker-контейнер).
#
# Запуск с Mac (пуш + установка через root SSH):
#   ./install-nginx-templates.sh
#   SERVER=root@your-server DOMAIN=your-domain.example ./install-nginx-templates.sh
#
# Напрямую на сервере (обязательно root):
#   sudo ./install-nginx-templates.sh --local          # шаблоны лежат рядом, в ./nginx/
#   sudo RUI_PORT=3005 DOMAIN=your-domain.example ./install-nginx-templates.sh --local
#
# Что делает:
#   HestiaCP есть  -> ставит шаблоны в /usr/local/hestia/data/templates/web/nginx/,
#                     находит владельца домена, применяет шаблон (proxy-tpl или tpl
#                     в зависимости от WEB_BACKEND) — nginx перечитывается сам
#   Hestia нет     -> пишет конфиг в /etc/nginx (sites-available / conf.d),
#                     включая 443-блок, если есть сертификат Let's Encrypt
#
# Переменные окружения:
#   SSH_KEY   — путь к SSH-ключу (по умолчанию ~/.ssh/id_ed25519)
#   SERVER    — root@хост (или DEPLOY_SERVER в .env)
#   DOMAIN    — домен (по умолчанию берётся из APP_URL в .env)
#   RUI_PORT  — порт приложения (по умолчанию APP_PORT из .env или 3005)

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

env_value() { grep -E "^$1=" "$SCRIPT_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2 || true; }

SERVER="${SERVER:-$(env_value DEPLOY_SERVER | sed 's|^[^@]*@|root@|')}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/id_ed25519}"
# Домен: env DOMAIN -> APP_URL из .env (https://domain -> domain)
if [ -z "${DOMAIN:-}" ]; then
  DOMAIN="$(env_value APP_URL | sed 's|^https\?://||; s|/.*$||; s|:.*$||')"
fi
[ -n "${DOMAIN:-}" ] || { echo "ОШИБКА: не задан домен (DOMAIN=... или APP_URL в .env)"; exit 1; }
STAGING_DIR="/tmp/rui-tpl-staging"

# Порт: env -> .env -> 3005
if [ -z "${RUI_PORT:-}" ] && [ -f "$SCRIPT_DIR/.env" ]; then
  RUI_PORT="$(grep -E '^APP_PORT=' "$SCRIPT_DIR/.env" | cut -d= -f2 || true)"
fi
RUI_PORT="${RUI_PORT:-3005}"

# ── Режим --local: установка на этом сервере ─────────────────────────
if [ "${1:-}" = "--local" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "ОШИБКА: запускайте от root (sudo)"; exit 1; }

  # Шаблоны: staging (пуш с Mac) или локальная папка nginx/ рядом со скриптом
  if [ -f "$STAGING_DIR/rui-app.tpl" ]; then
    SRC="$STAGING_DIR"
  elif [ -f "$SCRIPT_DIR/nginx/rui-app.tpl" ]; then
    SRC="$SCRIPT_DIR/nginx"
  else
    echo "ОШИБКА: файлы rui-app.tpl/.stpl не найдены ни в $STAGING_DIR, ни в $SCRIPT_DIR/nginx/"
    exit 1
  fi

  echo "=== Установка шаблонов rui-app ($DOMAIN -> 127.0.0.1:$RUI_PORT) ==="

  install_temp() {  # $1 = файл, $2 = целевой путь
    sed "s/__RUI_PORT__/$RUI_PORT/g" "$SRC/$1" > "$2"
    chown root:root "$2"
    chmod 644 "$2"
  }

  if [ -d /usr/local/hestia ]; then
    # ── Режим HestiaCP ──
    TPL_DIR="/usr/local/hestia/data/templates/web/nginx"
    mkdir -p "$TPL_DIR"
    install_temp rui-app.tpl  "$TPL_DIR/rui-app.tpl"
    install_temp rui-app.stpl "$TPL_DIR/rui-app.stpl"
    echo "[ok] шаблоны установлены в $TPL_DIR"

    # Владелец домена: /home/<user>/conf/web/<domain>
    DOMAIN_USER=""
    for home_dir in /home/*/conf/web/"$DOMAIN"; do
      if [ -d "$home_dir" ]; then
        DOMAIN_USER="$(echo "$home_dir" | cut -d/ -f3)"
        break
      fi
    done

    if [ -z "$DOMAIN_USER" ]; then
      echo ""
      echo "[!] Домен $DOMAIN не найден в Hestia (нет /home/*/conf/web/$DOMAIN)."
      echo "    Добавьте домен в панели (Web -> Add Domain), затем запустите скрипт снова."
      echo "    Шаблоны уже установлены: выберите 'rui-app' вручную и сделайте Rebuild."
      exit 0
    fi
    echo "[ok] владелец домена: пользователь '$DOMAIN_USER'"

    # WEB_BACKEND пуст -> nginx-only (v-change-web-domain-tpl),
    # иначе nginx работает прокси перед бэкендом (v-change-web-domain-proxy-tpl)
    WEB_BACKEND=""
    # shellcheck disable=SC1091
    [ -f /usr/local/hestia/conf/hestia.conf ] && . /usr/local/hestia/conf/hestia.conf

    if [ -n "${WEB_BACKEND:-}" ]; then
      echo "[..] применяю как proxy-шаблон (WEB_BACKEND=$WEB_BACKEND)"
      /usr/local/hestia/bin/v-change-web-domain-proxy-tpl "$DOMAIN_USER" "$DOMAIN" rui-app yes
    else
      echo "[..] применяю как web-шаблон (nginx-only)"
      /usr/local/hestia/bin/v-change-web-domain-tpl "$DOMAIN_USER" "$DOMAIN" rui-app yes
    fi
    echo "[ok] шаблон применён, nginx перезапущен"

    # SSL: stpl работает только при включённом Let's Encrypt на домене
    if [ ! -f "/home/$DOMAIN_USER/conf/web/$DOMAIN/ssl/$DOMAIN.crt" ]; then
      echo ""
      echo "[!] SSL-сертификат домена не найден."
      echo "    Включите Let's Encrypt: панель -> Web -> $DOMAIN -> SSL -> Enable Force HTTPS, затем Rebuild."
      echo "    До этого сайт доступен по http:// (вход в дашборд требует HTTPS из-за Secure-cookie)."
    fi

  elif command -v nginx >/dev/null 2>&1 || [ -d /etc/nginx ]; then
    # ── Режим standalone nginx (без Hestia) ──
    NGINX_CONF="/etc/nginx/sites-available/$DOMAIN.conf"
    ENABLED_LINK="/etc/nginx/sites-enabled/$DOMAIN.conf"
    USE_SITES=1
    if [ ! -d /etc/nginx/sites-available ]; then
      NGINX_CONF="/etc/nginx/conf.d/$DOMAIN.conf"
      USE_SITES=0
    fi

    SSL_BLOCK=""
    REDIRECT="location / { proxy_pass http://127.0.0.1:$RUI_PORT; proxy_http_version 1.1;
        proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }"

    if [ -d "/etc/letsencrypt/live/$DOMAIN" ]; then
      echo "[ok] найден сертификат Let's Encrypt — включаю 443"
      REDIRECT="location / { return 301 https://\$host\$request_uri; }"
      SSL_BLOCK="
server {
    listen 443 ssl;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:$RUI_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
"
    fi

    cat > "$NGINX_CONF" <<EOF
# Автогенерировано install-nginx-templates.sh ($DOMAIN -> 127.0.0.1:$RUI_PORT)
server {
    listen 80;
    server_name $DOMAIN;

    location ^~ /.well-known/acme-challenge/ { root /var/www/html; default_type "text/plain"; }
    $REDIRECT
}
$SSL_BLOCK
EOF

    [ "$USE_SITES" -eq 1 ] && ln -sf "$NGINX_CONF" "$ENABLED_LINK"
    nginx -t
    systemctl reload nginx
    echo "[ok] конфиг установлен: $NGINX_CONF, nginx перечитан"

    if [ ! -d "/etc/letsencrypt/live/$DOMAIN" ]; then
      echo ""
      echo "[!] SSL-сертификата нет. Выпустите (вход в дашборд требует HTTPS):"
      echo "    certbot --nginx -d $DOMAIN"
      echo "    затем перезапустите этот скрипт — 443-блок добавится автоматически"
    fi

  else
    echo "ОШИБКА: не найден ни HestiaCP (/usr/local/hestia), ни nginx (/etc/nginx)"
    exit 1
  fi

  # Приложение живо?
  if curl -fsS -m 5 "http://127.0.0.1:$RUI_PORT/api/health" >/dev/null 2>&1; then
    echo "[ok] приложение отвечает на 127.0.0.1:$RUI_PORT/api/health"
  else
    echo "[!] Приложение не отвечает на 127.0.0.1:$RUI_PORT/api/health — проверьте: docker compose ps"
  fi
  echo "=== Готово ==="
  exit 0
fi

# ── Режим по умолчанию: с Mac -> root SSH на сервер ──────────────────
for f in nginx/rui-app.tpl nginx/rui-app.stpl; do
  [ -f "$SCRIPT_DIR/$f" ] || { echo "ОШИБКА: нет файла $f"; exit 1; }
done
[ -f "$SSH_KEY" ] || { echo "ОШИБКА: SSH-ключ не найден: $SSH_KEY"; exit 1; }
[ -n "$SERVER" ] || { echo "ОШИБКА: не задан сервер (SERVER=root@host или DEPLOY_SERVER в .env)"; exit 1; }

echo "=== Установка шаблонов на $SERVER (домен $DOMAIN, порт $RUI_PORT) ==="
ssh_run() { ssh -i "$SSH_KEY" -o ConnectTimeout=15 "$SERVER" "$*"; }

echo "--- Загрузка шаблонов ---"
ssh_run "rm -rf $STAGING_DIR && mkdir -p $STAGING_DIR"
scp -q -i "$SSH_KEY" nginx/rui-app.tpl nginx/rui-app.stpl "$SERVER:$STAGING_DIR/"
echo "OK"

echo "--- Установка (root) ---"
ssh_run "RUI_PORT=$RUI_PORT DOMAIN=$DOMAIN bash -s -- --local" < "$0"
