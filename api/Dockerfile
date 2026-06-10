FROM node:20-alpine

WORKDIR /app

COPY api/package.json ./

RUN npm install --omit=dev

COPY api/server.js ./

EXPOSE 3000

CMD ["node", "server.js"]