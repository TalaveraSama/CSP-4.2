# Single-image deployment of the CSP panel (API + SPA). No JVM involved.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci || npm install
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8090 HOST=0.0.0.0
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev || npm install --omit=dev
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
EXPOSE 8090
CMD ["node", "server/dist/index.js"]
