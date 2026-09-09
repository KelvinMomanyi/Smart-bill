FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

COPY prisma ./prisma
RUN npm ci --include=dev && npm cache clean --force

COPY . .

RUN npm run build

# Apply migrations once as a release step. Run a second service with npm run worker.
CMD ["npm", "run", "start"]
