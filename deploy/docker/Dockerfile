FROM node:22.22.2-bookworm-slim

WORKDIR /srv
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts/bundle.mjs ./scripts/bundle.mjs
COPY LICENSE ./LICENSE
COPY docs/operations/first-version.md ./docs/operations/first-version.md

# pnpm 10 deploy requires injected workspace packages. --legacy copies the built
# workspace graph into /opt/ecs without dropping production links.
RUN CI=true pnpm install --frozen-lockfile \
  && pnpm bundle /opt/ecs

WORKDIR /opt/ecs
ENV NODE_ENV=production
VOLUME ["/data"]
EXPOSE 8473

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8473/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/src/main.js"]
CMD ["serve", "--data", "/data", "--host", "0.0.0.0"]
