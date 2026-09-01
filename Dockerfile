# Multi-stage build для минимального размера образа
FROM ubuntu:24.04 AS downloader

WORKDIR /tmp
RUN apt-get update && apt-get install -y \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Скачать yt-dlp. Используем самодостаточную сборку yt-dlp_linux (PyInstaller,
# без внешних зависимостей) — обычный "yt-dlp" это Python zipapp, которому
# нужен python3, а в финальном образе (oven/bun:1-slim) его нет.
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o yt-dlp && \
    chmod +x yt-dlp

# PO Token Provider plugin for yt-dlp. The provider server itself runs as an
# optional Docker Compose service; this ZIP only adds the client integration.
ARG BGUTIL_VERSION=1.3.1
RUN curl -fL "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/${BGUTIL_VERSION}/bgutil-ytdlp-pot-provider.zip" \
    -o bgutil-ytdlp-pot-provider.zip

# Production image
FROM oven/bun:1-slim

WORKDIR /app

# Установить зависимости
RUN apt-get update && apt-get install -y \
    curl \
    ffmpeg \
    libopus0 \
    libsodium23 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Скопировать yt-dlp из downloader stage
COPY --from=downloader /tmp/yt-dlp /app/bin/yt-dlp
RUN chmod +x /app/bin/yt-dlp
RUN mkdir -p /app/bin/yt-dlp-plugins
COPY --from=downloader /tmp/bgutil-ytdlp-pot-provider.zip /app/bin/yt-dlp-plugins/bgutil-ytdlp-pot-provider.zip

# Скопировать файлы проекта
COPY package.json bun.lock ./

# @discordjs/opus (нативный энкодер) не имеет прекомпилированного бинарника под
# эту платформу и компилируется из исходников при установке — нужны build tools
# и заголовки libopus. Ставим их временно, собираем зависимости, затем удаляем,
# чтобы не раздувать финальный образ. Без нативного энкодера voice использует
# чистый JS opusscript, который под Bun иногда молча отдаёт битые/пустые фреймы
# (звук не слышно, хотя всё выглядит подключённым).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libopus-dev \
    pkg-config \
    && bun install --production \
    && apt-get purge -y python3 make g++ libopus-dev pkg-config \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

COPY src ./src
COPY config ./config

# Создать директории для данных
RUN mkdir -p data logs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f "http://localhost:${WEB_PORT:-8787}/health" 2>/dev/null || exit 1

# Запустить бот
CMD ["bun", "run", "src/index.js"]
