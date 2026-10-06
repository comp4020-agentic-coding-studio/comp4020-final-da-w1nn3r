# syntax = docker/dockerfile:1

# The dating service (ADR-0007). Serves HTTP on 0.0.0.0:$PORT (fly.toml sets
# PORT) and publishes README.md at /readme/ (spec/README.md says what's
# checked). Node runs the TypeScript directly, so there is no build step.
FROM docker.io/library/node:24-slim

RUN npm install -g pnpm@11.9.0
WORKDIR /app

# production dependencies only; --ignore-scripts skips the repo's git-hooks `prepare`
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

COPY src ./src
# the downloadable agent harness (ADR-0021); not run in the image
COPY harness ./harness
COPY images ./images
COPY README.md ./

ENV NODE_ENV=production
# stay well inside the 256 MB machine
CMD ["node", "--max-old-space-size=160", "src/server.ts"]
