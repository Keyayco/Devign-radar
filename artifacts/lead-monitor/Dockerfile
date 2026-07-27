FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip \
    build-essential python3-dev \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt --break-system-packages

COPY . .

# DB lives inside the container — persists across restarts, resets only on new deploys
RUN mkdir -p /app/data

# Railway injects PORT automatically — override here only if needed
ENV PORT=3000
ENV BASE_PATH=""
ENV DB_PATH=/app/data/lead_monitor.db
ENV NODE_ENV=production
# Set these in Railway's Variables tab — they survive redeploys
ENV TELEGRAM_BOT_TOKEN=""
ENV TELEGRAM_CHAT_ID=""

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["node", "server.js"]
