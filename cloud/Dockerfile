# Open Pathways Cloud — Dockerfile.
#
# Built from the repo root so /src/ and /cloud/ are both in the build
# context. Two services share this image: the web container and the worker
# container, distinguished by command (see docker-compose.yml).
#
# Final stage uses Microsoft's Playwright image so Chromium and its system
# deps come pre-installed. The audit core's run-dynamic-checks.js requires
# Chromium specifically (CDP-only); Firefox/WebKit support was deliberately
# dropped in /src.

ARG PLAYWRIGHT_VERSION=v1.59.1-jammy

# ---------------- builder ----------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Cache deps separately from source so unrelated edits don't bust the layer.
COPY package.json package-lock.json* ./
COPY cloud/package.json cloud/package-lock.json* cloud/

# Install the cloud package's deps. We don't run `npm ci` at the root
# because /src is invoked as a bare module and uses the root deps from the
# final image; root deps install in the next layer once we have full src.
RUN npm ci --omit=dev --prefix cloud --no-audit --no-fund

# Now bring in the rest. We need /src for cloud to require, /cloud for the
# server, and the package.json files. Everything else is filtered by
# .dockerignore.
COPY src ./src
COPY cloud ./cloud
# Root package.json declares the audit core's deps (playwright, yauzl, ...).
# Install them here so the final image doesn't need npm at runtime.
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------- final ----------------
FROM mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}

WORKDIR /app

# Non-root user is already provided by the playwright image as `pwuser`.
# Use it; the image's HOME is /home/pwuser.
USER pwuser

COPY --chown=pwuser:pwuser --from=builder /app /app

ENV NODE_ENV=production \
    OPEN_PATHWAYS_PORT=4280

EXPOSE 4280

# /api/health returns 503 if DB or storage is unreachable; Coolify uses
# this for routing, and the local Dockerfile uses it for the runtime
# healthcheck.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.OPEN_PATHWAYS_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Default command runs the web server. Override to `node cloud/worker/index.js`
# for the worker container (see docker-compose.yml).
CMD ["node", "cloud/server/index.js", "--no-open"]
