FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --include=optional && node -e 'require.resolve("@next/swc-linux-" + process.arch + "-gnu")'
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000
COPY --from=build --chown=node:node /app /app
COPY --chmod=755 ops/runtime-entrypoint.sh /usr/local/bin/radar-entrypoint
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/radar-entrypoint"]
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "0.0.0.0"]
