FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5050

VOLUME ["/app/data", "/app/downloads"]

CMD ["node", "src/server.js", "--host", "0.0.0.0", "--port", "5050"]
