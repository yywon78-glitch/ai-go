FROM node:18-alpine

WORKDIR /app

# 의존성만 먼저 복사 (레이어 캐시 활용)
COPY package*.json ./
RUN npm ci --omit=dev

# 소스 복사
COPY server.js game.js db.js ./
COPY public/ ./public/

# 데이터 디렉토리 (볼륨 마운트 대상)
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data
ENV NODE_ENV=production
ENV PORT=3100

EXPOSE 3100

CMD ["node", "server.js"]