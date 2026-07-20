# Hosted Development Previews

Hosted previews let a Gorchestra session own a development stack without tying it to an individual agent turn. A workspace supplies a declarative recipe, Gorchestra supervises the processes, and one stable preview host routes requests to the recipe's named services.

The feature is intended for development servers, documentation sites, APIs, and other local tools that can remain attached to a foreground process. Hosted previews are supported on macOS and Linux. Gorchestra itself can run on Windows, but hosted-preview process supervision is not supported there in version 1.

## Quick Start

Create `.gorchestra/host.yaml` inside the session workspace:

```yaml
version: 1
name: storefront

inherit_env:
  - NODE_ENV

services:
  - name: web
    command:
      - bun
      - run
      - dev
      - --
      - --host
      - "${GORCHESTRA_HOST}"
      - --port
      - "${GORCHESTRA_PORT}"
    cwd: web
    port: auto
    env:
      NODE_ENV: development
      PUBLIC_API_BASE: /api
    readiness:
      type: http
      path: /
      timeout: 45s
    proxy:
      host_header: upstream
      rewrite_origin: true

  - name: api
    command: [go, run, ./cmd/api]
    cwd: .
    port: auto
    env:
      API_LISTEN: "${GORCHESTRA_HOST}:${GORCHESTRA_PORT}"
    readiness:
      type: http
      path: /healthz
      timeout: 30s

  - name: worker
    command: [bun, run, worker]
    cwd: .
    port: none
    readiness:
      type: none

routes:
  - path: /api
    service: api
    strip_prefix: false
  - path: /
    service: web
    strip_prefix: false
```

Then validate and start it from the session UI or CLI:

```sh
gorchestra host validate --session "$SESSION_ID"
gorchestra host start --session "$SESSION_ID"
gorchestra host url --session "$SESSION_ID"
```

When a command runs inside a Gorchestra agent, `GORCHESTRA_SESSION_ID`, `GORCHESTRA_API_URL`, and `GORCHESTRA_BIN` are supplied automatically. That makes the shorter agent-facing form possible:

```sh
"$GORCHESTRA_BIN" host validate
"$GORCHESTRA_BIN" host start
"$GORCHESTRA_BIN" host logs --follow
```

## Recipe Reference

The recipe is strict YAML. Unknown fields, multiple YAML documents, invalid paths, and files larger than 1 MiB are rejected. The recipe and every service working directory must resolve inside the workspace, including after symlinks are resolved.

### Top-Level Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | Recipe format version. Version 1 requires the integer `1`. |
| `name` | no | Lowercase DNS label used to form the preview slug. Defaults to the workspace directory name. |
| `inherit_env` | no | Explicit list of additional environment variable names copied from the Gorchestra process. |
| `services` | yes | One or more named process definitions. |
| `routes` | no | Path-to-service routes on the shared preview host. |

`name` and service names must contain only lowercase letters, digits, and hyphens, must start and end with a letter or digit, and must be at most 63 characters.

### Service Fields

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique service name. |
| `command` | yes | Non-empty argv array. Gorchestra executes it directly, without an implicit shell. |
| `cwd` | no | Working directory relative to the workspace. Defaults to `.` and may not escape the workspace. |
| `port` | no | `auto`, `none`, or a fixed integer from 1 through 65535. Defaults to `none`. |
| `env` | no | Literal per-service environment values. Runtime variables may be interpolated with `${NAME}`. |
| `readiness` | no | Readiness probe. Defaults to `tcp` for a service with a port and `none` otherwise. |
| `proxy` | no | Host and Origin handling for proxied HTTP requests. |

Prefer `port: auto` unless an upstream tool requires a fixed port. Gorchestra assigns an available loopback port and exposes it through `PORT` and `GORCHESTRA_PORT`. A service without an HTTP route can use `port: none`.

Readiness supports the following forms:

```yaml
readiness:
  type: none
```

```yaml
readiness:
  type: tcp
  timeout: 30s
```

```yaml
readiness:
  type: http
  path: /healthz
  timeout: 30s
```

`tcp` and `http` require a service port. The default timeout is 30 seconds. An HTTP path must be an absolute request path such as `/healthz`.

Proxy behavior defaults to an upstream Host header without Origin rewriting:

```yaml
proxy:
  host_header: upstream # upstream or external
  rewrite_origin: false
```

Use `host_header: external` when the development server needs to see the public preview hostname. Use `rewrite_origin: true` with the default upstream Host mode when the development server validates browser Origin against its loopback Host; Gorchestra rewrites the Origin to that upstream address.

### Routes

Every route points to an existing service with a port:

```yaml
routes:
  - path: /api
    service: api
    strip_prefix: true
  - path: /
    service: web
```

Matching is path-boundary aware and uses the longest matching prefix. For example, `/api` matches `/api` and `/api/users`, but not `/apix`, and it wins over `/`. With `strip_prefix: true`, Gorchestra removes the matched prefix before forwarding the request.

### Process Environment

Gorchestra supplies a small baseline environment (`PATH`, home/user/shell, locale, and temporary-directory variables), explicit names from `inherit_env`, values from the service's `env` map, and these reserved runtime variables:

| Variable | Meaning |
| --- | --- |
| `GORCHESTRA_HOST`, `HOST` | Host/interface on which the service should listen. |
| `GORCHESTRA_PORT`, `PORT` | Assigned or fixed service port. |
| `GORCHESTRA_SERVICE_NAME` | Current recipe service name. |
| `GORCHESTRA_SESSION_ID` | Owning Gorchestra session ID. |
| `GORCHESTRA_WORKSPACE` | Absolute session workspace path. |

Reserved variables cannot be overridden or included in `inherit_env`. Recipe interpolation supports the braced reserved forms, such as `${GORCHESTRA_PORT}`, in command arguments and `env` values. Gorchestra does not perform arbitrary shell or parent-environment expansion.

Inherited values are resolved only when the process starts and are not written into the durable recipe snapshot. Literal `env` values are part of that snapshot, so do not store secrets in `host.yaml`; keep secrets outside the workspace and opt in to only the specific variable names a service needs.

## CLI

All commands accept `--session`, `--server`, and `--timeout`. Their defaults are `GORCHESTRA_SESSION_ID`, `GORCHESTRA_API_URL` (or `http://127.0.0.1:8080`), and 60 seconds.

```sh
# Parse and validate the current workspace recipe without starting it.
gorchestra host validate --session "$SESSION_ID"

# Inspect recipe, runtime, service, port, URL, and log-cursor state.
gorchestra host status --session "$SESSION_ID"

# Start, stop, or apply the latest recipe with a full stack restart.
gorchestra host start --session "$SESSION_ID"
gorchestra host restart --session "$SESSION_ID"
gorchestra host stop --session "$SESSION_ID"

# Return after the API accepts an asynchronous lifecycle request.
gorchestra host restart --session "$SESSION_ID" --wait=false

# Probe service readiness and print the stable preview URL.
gorchestra host check --session "$SESSION_ID"
gorchestra host url --session "$SESSION_ID"

# Read retained logs, filter one service, or continue with SSE streaming.
gorchestra host logs --session "$SESSION_ID" --limit 500
gorchestra host logs --session "$SESSION_ID" --service api --follow
gorchestra host logs --session "$SESSION_ID" --after-seq 1200
```

`start`, `stop`, and `restart` wait for their requested terminal state by default. Logs are bounded in memory and may be truncated; lifecycle snapshots and events are durable, but process output is not retained across a Gorchestra restart.

## Lifecycle and Failure Model

- Starting a preview is an explicit action. The recipe is trusted local code and may run any executable available to the Gorchestra user.
- A preview belongs to its session, remains running between agent turns, and has one stable URL for that session.
- Editing `host.yaml` while a stack is active marks the loaded configuration stale. Use `restart` to stop the stack and apply the new recipe.
- Archiving the session, changing its workspace, stopping Gorchestra, or shutting down the host manager stops the complete stack.
- Gorchestra persists the recipe and last lifecycle state, but it deliberately restores an active preview as `stopped` after Gorchestra boots. It never starts development processes automatically after boot.
- If any service exits unexpectedly, readiness fails, or startup fails, Gorchestra marks the runtime failed and stops the other services. Version 1 does not retry failed services.
- A fixed preview URL can remain known while its stack is stopped; requests receive an unavailable response until the user starts it again.

## Foreground Processes and Docker Compose

Gorchestra needs to own the long-running process so it can observe exits, collect logs, and stop the entire stack. Commands should stay in the foreground:

- Do not append `&`, use `nohup`, launch a daemon, or use `docker compose up -d`.
- Prefer a direct argv array over a shell script.
- When a shell is necessary, make its final action `exec` so the development server receives termination signals: `command: [bash, -lc, "prepare && exec bun run dev"]`.
- Make wrappers forward `SIGTERM` and exit when their child exits.

Docker Compose can be represented as one Gorchestra service when Compose owns several containers. Keep `docker compose up` attached and publish the assigned loopback port. For example:

```yaml
# .gorchestra/host.yaml
version: 1
name: compose-app
services:
  - name: app
    command: [docker, compose, up, --abort-on-container-exit]
    cwd: .
    port: auto
    readiness:
      type: http
      path: /healthz
      timeout: 90s
routes:
  - path: /
    service: app
```

```yaml
# compose.yaml
services:
  app:
    build: .
    ports:
      - "127.0.0.1:${PORT}:3000"
```

Compose receives `PORT` from the supervised process environment. Avoid a detached Compose stack: Gorchestra cannot reliably attribute its exit or logs, and an abrupt supervisor timeout could leave detached containers behind.

## Preview URL and Reverse-Proxy Setup

`--preview-url-template` (or `GORCHESTRA_PREVIEW_URL_TEMPLATE`) controls the stable URL reported and matched by Gorchestra. It must contain `{slug}`.

```sh
# Local wildcard localhost URL; this is the default shape.
gorchestra --preview-url-template 'http://{slug}.localhost:8080'

# Tailnet wildcard DNS URL.
GORCHESTRA_PREVIEW_URL_TEMPLATE='http://{slug}.dev.gennari.industries' gorchestra
```

The generated session slug is a DNS label ending in `-gorchestra`, which lets a single outer reverse-proxy rule forward every preview host to Gorchestra. Gorchestra then selects the session by Host and applies the recipe's path routes.

On Joey's tailnet development proxy, the suffix route is:

```sh
devproxy add-suffix gorchestra-previews -gorchestra 127.0.0.1:18080 \
  "Gorchestra hosted previews"
devproxy validate
devproxy reload
devproxy check-suffix gorchestra-previews sample-gorchestra \
  --path /.well-known/gorchestra-preview-health
devproxy check-suffix gorchestra-previews sample-gorchestra --tailnet \
  --path /.well-known/gorchestra-preview-health
```

`add-suffix` updates and renders the proxy registry but does not activate the new rule until `devproxy reload`. The reload updates Caddy in place; it does not restart Gorchestra.

For other ingress proxies, preserve the original Host header and forward matching preview hosts to the Gorchestra HTTP listener. Keep the listener and wildcard DNS private unless the previews themselves implement appropriate access control.

## Security Notes

- A valid recipe is executable code. Only start recipes from workspaces you trust.
- Preview routes do not add application authentication. Tailnet reachability limits the network audience, but it is not a substitute for app-level authorization on sensitive tools.
- Do not commit secrets to `host.yaml`. Literal recipe content is persisted with the session.
- Inherit the minimum environment needed by each stack. Environment access is opt-in beyond the small baseline.
- Bind development servers to the supplied host and port. Do not expose their raw listener on all network interfaces unless that is intentional.
- Review fixed ports and Docker-published ports for collisions with other local services.
