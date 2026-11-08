# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

WORKDIR /app

# 先装依赖，利用层缓存（依赖只有 axios，版本已精确锁定，npm 装即可）
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev --no-audit --no-fund

# 再拷代码
COPY server ./server
COPY sources ./sources
COPY web ./web

RUN mkdir -p /app/data/sources && chown -R node:node /app
USER node

EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "server/index.mjs"]
