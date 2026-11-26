FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --legacy-peer-deps
COPY . .
RUN npx vite build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000
COPY --from=build /app /app
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["npx", "tsx", "server.ts"]
