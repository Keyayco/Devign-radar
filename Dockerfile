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

RUN mkdir -p /data

ENV PORT=3001
ENV BASE_PATH=""
ENV DB_PATH=/data/lead_monitor.db
ENV NODE_ENV=production

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health', r => process.exit(r.statusCode===200?0:1))"

CMD ["node", "server.js"]

