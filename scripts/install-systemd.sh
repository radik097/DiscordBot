#!/bin/bash
# Установить systemd сервис для автозапуска бота на Linux

set -e

if [ "$EUID" -ne 0 ]; then
   echo "❌ Этот скрипт должен быть запущен с sudo"
   exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_FILE="$SCRIPT_DIR/discord-bot.service"
SERVICE_NAME="discord-bot"

echo "🔧 Установка systemd сервиса для $SERVICE_NAME"

# Скопировать файл сервиса
echo "📋 Копирую $SERVICE_FILE в /etc/systemd/system/"
cp "$SERVICE_FILE" "/etc/systemd/system/$SERVICE_NAME.service"

# Перезагрузить systemd
echo "🔄 Перезагружаю systemd демона..."
systemctl daemon-reload

# Включить автозапуск
echo "🚀 Включаю автозапуск при загрузке системы..."
systemctl enable "$SERVICE_NAME.service"

echo ""
echo "✅ Сервис установлен!"
echo ""
echo "Команды управления:"
echo "  systemctl start $SERVICE_NAME      # Запустить сейчас"
echo "  systemctl stop $SERVICE_NAME       # Остановить"
echo "  systemctl restart $SERVICE_NAME    # Перезагрузить"
echo "  systemctl status $SERVICE_NAME     # Статус"
echo "  journalctl -fu $SERVICE_NAME       # Логи в реальном времени"
echo ""
echo "Бот будет автоматически запускаться при перезагрузке системы."
