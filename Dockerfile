# syntax=docker/dockerfile:1.7
#
# The proxy as an image: build the TypeScript, then ship `dist` on a runtime
# layer carrying production dependencies only.
#
# The registry token arrives as a BuildKit **secret**, never an `ARG` or an
# `ENV`: both are recorded in the image history, so `docker history` would hand
# the token to anyone who can pull the image. `.npmrc` reads it from
# `NODE_AUTH_TOKEN`, which is set for the length of one `RUN` and is not
# committed to a layer.
#
#   docker build --secret id=npm_token,env=NODE_AUTH_TOKEN -t lelantos/mcp-x402 .
#
# What this image deliberately does not contain:
#
#   - `mcp.config.json`, which names the upstreams and their prices. Mount it,
#     so one image serves every deployment: `-v ./mcp.config.json:/app/mcp.config.json:ro`.
#   - any key. `LELANTOS_VIEWING_KEY` and `MCP_EVM_PRIVATE_KEY` come from the
#     environment at run time.
#   - a shell for stdio upstreams to spawn. An upstream with `"transport":
#     "stdio"` runs a command *inside this container*, so its interpreter must be
#     installed here; the slim base has node and nothing else.

FROM node:24-slim AS deps
WORKDIR /app
# Only the manifests, so a source edit does not invalidate the install layer.
COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN --mount=type=secret,id=npm_token \
    NODE_AUTH_TOKEN="$(cat /run/secrets/npm_token)" npm ci --omit=dev \
    && npm cache clean --force
COPY --from=build /app/dist ./dist

# The replay ledger. Every consumed payment is recorded here, so a container
# that loses it will accept a receipt it has already honoured — the file is
# state, not a log. Mount a volume over it in any real deployment.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
ENV MCP_LEDGER=/data/consumed.log

# The default bind is 127.0.0.1, which inside a container means "this container
# only" and would make the published port answer nothing.
ENV MCP_HOST=0.0.0.0 MCP_PORT=8402
EXPOSE 8402

USER node

# `/health` is the one route that costs nothing and needs no payment.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_PORT||8402)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run with `--init`: stdio upstreams are child processes, and PID 1 without an
# init does not reap them. `index.ts` handles SIGINT/SIGTERM itself, so stopping
# the container closes the upstreams rather than orphaning them.
CMD ["node", "dist/index.js"]
