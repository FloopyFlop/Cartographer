# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS frontend
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts postcss.config.js tailwind.config.js ./
COPY src ./src
COPY public ./public
COPY scripts/release.mjs ./scripts/release.mjs
COPY THIRD_PARTY_NOTICES.md ./THIRD_PARTY_NOTICES.md
COPY LICENSE ./LICENSE
RUN npm run build

FROM ghcr.io/astral-sh/uv:0.8.13 AS uv

FROM python:3.12-slim-bookworm AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy UV_NO_CACHE=1
WORKDIR /app/backend
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
RUN uv sync --locked --no-dev --no-install-project

FROM python:3.12-slim-bookworm AS runtime
COPY --from=uv /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_NO_DEV=1 \
    UV_CACHE_DIR=/app/backend/.cache/uv \
    CARTOGRAPHER_HOST=0.0.0.0 \
    CARTOGRAPHER_PORT=5050 \
    CARTOGRAPHER_CACHE_DIRECTORY=/app/backend/.cache
RUN groupadd --gid 10001 cartographer \
    && useradd --uid 10001 --gid cartographer --home-dir /app --no-create-home cartographer \
    && mkdir -p /app/backend/.cache/uv /app/backend/.cache/tmp \
    && chown -R cartographer:cartographer /app/backend/.cache
WORKDIR /app/backend
COPY --from=dependencies /app/backend/.venv ./.venv
COPY backend/pyproject.toml backend/uv.lock backend/README.md ./
COPY backend/cartographer ./cartographer
COPY --from=frontend /app/dist /app/dist
USER cartographer
EXPOSE 5050
HEALTHCHECK --interval=30s --timeout=8s --start-period=30s --retries=3 \
    CMD uv run --no-sync python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5050/api/health', timeout=4).close()"
CMD ["uv", "run", "--no-sync", "python", "-m", "cartographer.production"]
