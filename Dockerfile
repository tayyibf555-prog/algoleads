FROM node:20-alpine

# better-sqlite3 ships native bindings — needs build toolchain to compile.
# We could use a multi-stage build to drop the toolchain after install,
# but the image is small enough that single-stage keeps the Dockerfile simple.
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install deps first for layer caching
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source
COPY . .

# Persistent SQLite file lives at /app/db (mounted as a Fly volume)
RUN mkdir -p /app/db

ENV NODE_ENV=production
EXPOSE 4002
CMD ["node", "server.js"]
