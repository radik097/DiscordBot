#!/bin/bash
set -e

echo "🤖 Discord Bot Docker Setup"
echo "=============================="

# Проверить Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker не установлен. Установите Docker Desktop или Docker Engine."
    exit 1
fi

# Проверить docker-compose
if ! command -v docker-compose &> /dev/null; then
    echo "⚠️  docker-compose не найден, попробую 'docker compose'..."
    if ! docker compose version &> /dev/null; then
        echo "❌ Docker Compose не установлен."
        exit 1
    fi
    COMPOSE_CMD="docker compose"
else
    COMPOSE_CMD="docker-compose"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PROJECT_DIR"

# Проверить .env
if [ ! -f .env ]; then
    echo "📝 Создаю .env из .env.example..."
    cp .env.example .env
    echo "⚠️  Отредактируйте .env с вашими данными:"
    echo "   - DISCORD_TOKEN"
    echo "   - CLIENT_ID"
    echo "   - GUILD_ID"
    exit 1
fi

# Проверить обязательные переменные
source .env
if [ -z "$DISCORD_TOKEN" ] || [ -z "$CLIENT_ID" ]; then
    echo "❌ DISCORD_TOKEN или CLIENT_ID не установлены в .env"
    exit 1
fi

echo "✅ Конфигурация проверена"

# Создать директории
echo "📁 Создаю директории..."
mkdir -p config data logs

# Проверить config/structure.json
if [ ! -f config/structure.json ]; then
    echo "⚠️  config/structure.json не найден. Создаю пустой конфиг..."
    cat > config/structure.json << 'EOF'
{
  "roles": [],
  "categories": [],
  "channels": [],
  "musicAllowedRoles": []
}
EOF
fi

# Проверить config/rules.md
if [ ! -f config/rules.md ]; then
    echo "⚠️  config/rules.md не найден. Создаю пустой файл..."
    echo "# Правила сервера" > config/rules.md
fi

echo "🐳 Собираю Docker образ..."
$COMPOSE_CMD build --no-cache

echo ""
echo "✅ Инициализация завершена!"
echo ""
echo "Следующие шаги:"
echo "1. Отредактируйте .env если необходимо"
echo "2. Запустите бот: $COMPOSE_CMD up -d"
echo "3. Проверьте логи: $COMPOSE_CMD logs -f"
echo "4. Откройте веб-панель: http://localhost:8787"
echo ""
echo "Полезные команды:"
echo "  $COMPOSE_CMD up -d       # Запустить"
echo "  $COMPOSE_CMD down        # Остановить"
echo "  $COMPOSE_CMD logs -f     # Логи"
echo "  $COMPOSE_CMD restart     # Перезагрузить"
echo "  $COMPOSE_CMD pull        # Обновить образ"
