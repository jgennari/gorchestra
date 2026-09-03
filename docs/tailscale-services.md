# Gorchestra Tailscale Services

Joey's persistent human-test stack has two private HTTPS entry points. They share one Go backend and SQLite database, but intentionally serve different frontend modes:

| Use | URL | Local upstream |
|---|---|---|
| Daily/built frontend | `https://gorchestra.coin-triceratops.ts.net` | `http://127.0.0.1:18080` |
| Development/Vite HMR | `https://gorchestra-dev.coin-triceratops.ts.net` | `http://127.0.0.1:15173`, with `/api/*` sent to `http://127.0.0.1:18080` |

Both names are Tailscale Services and are only reachable from authorized devices in the `coin-triceratops.ts.net` tailnet. They are not public Funnel endpoints.

YourAPI remains independent and public at `https://joeys-mbp.coin-triceratops.ts.net/mcp`. Its Tailscale Funnel owns the Mac node's port 443 and proxies to `127.0.0.1:8766`. The Gorchestra sidecar does not change or share that node configuration.

## Why a sidecar

Tailscale requires Service hosts to use a tag-based identity. Joey's Mac is a normal user-owned Tailscale node, and tagging it would replace its user identity with tag-based access semantics. The sidecar embeds a second Tailscale node with `tsnet`, so the Mac keeps its existing identity, access, Funnel, and MagicDNS name.

The sidecar source is an isolated Go module in `tools/tailscale-sidecar`. Keeping it separate prevents Tailscale's networking dependencies from entering Gorchestra's main `go.mod` or release binary.

## Tailnet configuration

The tailnet must contain:

- Host identity tag: `tag:gorchestra-services`
- Service: `svc:gorchestra`, endpoint `tcp:443`
- Service: `svc:gorchestra-dev`, endpoint `tcp:443`
- An access grant allowing only `jgennari@gmail.com` to reach both services on TCP 443
- Automatic approval for advertisements from the dedicated tagged sidecar

The intended policy additions are:

```jsonc
{
  "tagOwners": {
    "tag:gorchestra-services": ["jgennari@gmail.com"]
  },
  "autoApprovers": {
    "services": {
      "svc:gorchestra": ["tag:gorchestra-services"],
      "svc:gorchestra-dev": ["tag:gorchestra-services"]
    }
  },
  "grants": [
    {
      "src": ["jgennari@gmail.com"],
      "dst": ["svc:gorchestra", "svc:gorchestra-dev"],
      "ip": ["443"]
    }
  ]
}
```

Merge these entries into the existing policy rather than replacing existing
`tagOwners`, `autoApprovers`, or `grants` collections.

The sidecar advertises both services and terminates HTTPS using Tailscale-provisioned certificates. Its identity state is persistent; no reusable auth key is stored in the repository or LaunchAgent.

On first start, inspect the logs for a one-time Tailscale authentication URL. Authenticate the new node as `tag:gorchestra-services`. With the policy above, both service advertisements are approved automatically. Confirm that each service shows one online host in the Tailscale Services admin page.

## Local installation and operation

Install or upgrade the binary and LaunchAgent from the repository root:

```bash
bun run tailscale:sidecar:install
```

The installer builds the isolated module, copies the binary, writes the LaunchAgent, and starts or restarts it. Runtime locations:

| Item | Path |
|---|---|
| Binary | `~/Library/Application Support/Gorchestra/bin/gorchestra-tailscale-sidecar` |
| Tailscale identity state | `~/Library/Application Support/Gorchestra/tailscale-sidecar` |
| LaunchAgent | `~/Library/LaunchAgents/com.joey.gorchestra-tailscale-sidecar.plist` |
| Standard log | `~/Library/Logs/Gorchestra/tailscale-sidecar.log` |
| Error log | `~/Library/Logs/Gorchestra/tailscale-sidecar.err.log` |

Common commands:

```bash
bun run tailscale:sidecar
bun run tailscale:sidecar:logs
bun run tailscale:sidecar:restart
bun run tailscale:sidecar:stop
bun run tailscale:sidecar:start
```

The sidecar is independent of the human-test LaunchAgent. Restarting it does not restart Gorchestra or interrupt active agent runs. If either local upstream is down, the corresponding HTTPS endpoint returns `502` while the sidecar remains connected.

## Proxy behavior

The production service preserves the external Host header and forwards all requests to the Go backend.

The development service sends `/api` and `/api/*` directly to the Go backend while sending all other paths to Vite. The Vite upstream Host is rewritten to `127.0.0.1:15173`, which lets the currently running dev server accept the new external hostname without a restart. External forwarding headers remain set to the public HTTPS origin.

This split also keeps API streaming and console WebSockets away from Vite's proxy. Vite HMR continues through the frontend proxy.

## Frontend caching

The two origins are deliberately separate:

- The built URL is a secure context, can register the service worker, and serves hashed embedded assets with production cache headers.
- The dev URL is also a secure context, but Vite still serves development modules with HMR and `no-cache` behavior. The service worker declines to cache a Vite app shell.

Browser storage, service-worker registrations, and push subscriptions are origin-scoped, so the two URLs maintain independent client state.

## Promoting the built frontend

Frontend source changes appear immediately at the development URL through Vite
HMR. They do not update the built-frontend URL until explicitly promoted:

```bash
bun run prod:refresh
```

The command builds Vite, stages `web/dist` into `internal/webassets/dist`, and
signals the persistent backend's existing source watcher. If any Gorchestra
session is running, the watcher defers its rebuild until all active sessions
finish; the command never force-restarts the human stack. When no session is
active, it waits for the rebuilt backend and verifies that the production
Tailscale Service serves the exact staged `index.html`.

Agents should run this command only when the user explicitly asks to promote or
reload production. Normal frontend implementation and verification should use
the development URL and require no reload command.

## Validation

```bash
bun run dev:human:status
bun run tailscale:sidecar
curl -fsS https://gorchestra.coin-triceratops.ts.net/api/health
curl -fsS https://gorchestra-dev.coin-triceratops.ts.net/api/health
tailscale funnel status --json
```

The final command must continue to show `joeys-mbp.coin-triceratops.ts.net:443` proxying to `http://127.0.0.1:8766` with Funnel enabled.

On Joey's Mac, the local NextDNS daemon listens on `127.0.0.1:53`. It currently
answers the new Service names with `NXDOMAIN` before Tailscale can synthesize
their VIP records, even though Tailscale DNS itself resolves them correctly.
Until that local split-DNS conflict is corrected, validate each Service against
the VIP returned by `tailscale dns query`:

```bash
tailscale dns query gorchestra.coin-triceratops.ts.net
curl --resolve gorchestra.coin-triceratops.ts.net:443:100.70.22.215 \
  https://gorchestra.coin-triceratops.ts.net/api/health

tailscale dns query gorchestra-dev.coin-triceratops.ts.net
curl --resolve gorchestra-dev.coin-triceratops.ts.net:443:100.88.81.25 \
  https://gorchestra-dev.coin-triceratops.ts.net/api/health
```

The `tailscale:sidecar` status command performs the same Tailscale-DNS fallback,
so an otherwise healthy Service is not reported as offline solely because the
macOS resolver has not learned the record yet.

## Rollback

Stop the sidecar with `bun run tailscale:sidecar:stop`. In the Tailscale Services admin page, drain or remove the two `gorchestra-services-host` advertisements before deleting either service definition. Do not run `tailscale serve reset` on the Mac's primary node; that would affect the unrelated YourAPI Funnel configuration.

The legacy `http://gorchestra.dev.gennari.industries` route can remain during migration and can be checked with `devproxy check gorchestra`. Remove it only after clients have moved to the two HTTPS service names.
