# Gorchestra Web

Vite, React, and TypeScript frontend for Gorchestra.

## Commands

```sh
bun install
bun dev
bun run build
```

During local development, Vite proxies `/api` requests to the Go backend at `http://localhost:8080`.

The repository root also provides combined backend/frontend development commands:

```sh
bun run dev
bun run dev:tailnet
```
