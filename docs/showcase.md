# Screenshot showcase

The showcase is a local, synthetic Threave installation for product screenshots. It contains seven fictional chats across Codex, Claude, and OpenCode: five root sessions, plus two child sessions under **Harbor UI**. Harbor UI and Lantern API have multi-turn histories with tool calls, file changes, and passing test output. Session names, messages, workspace files, usage, and run times are generated for the demo; they do not come from a real agent run.

For a blog or marketing agent, this is the complete instruction:

```text
In the Threave repository, read docs/showcase.md and run bun run showcase:photos.
Use the synthetic screenshots in .tmp/showcase/screenshots/. The capture command
starts the local showcase and shuts it down when finished. Do not capture the
human-test Threave service or any personal sessions.
```

`bun run showcase:photos` captures the overview, Harbor UI desktop and mobile, Lantern API, and a short parent/child product tour into ignored `.tmp/showcase/screenshots/`. It uses a fresh headless browser context and stops its temporary server in a `finally` block. The reviewed Harbor UI captures and MP4 under `site/assets/` are copies for the public site and README. If Playwright reports a missing browser, run `cd web && bunx playwright install chromium` once.

For custom framing, start the temporary site with `bun run showcase`, open **http://127.0.0.1:15273** in a browser, capture what you need, then stop the command with Ctrl-C. The Go API uses `127.0.0.1:18180`. To rebuild the fictional data while the site is stopped:

```sh
bun run showcase:reset
```

The seed code is in `cmd/showcase-seed/main.go`. The database and binary live under ignored `.tmp/showcase/`. The only browsable workspace is `/tmp/threave-showcase-workspace`; the server's home directory is `/tmp/threave-showcase-home`. Both are marked as synthetic, and reset refuses to remove an unmarked directory. The launcher passes no provider credentials and points provider binaries at an unavailable executable, so the seeded histories can be viewed but cannot launch real agents. Both servers bind only to localhost. The standard human-test stack, its database, and tailnet routes are untouched.

Good starting points for screenshots:

- **Overview:** a week of synthetic activity across three providers.
- **Harbor UI:** a parent chat with two indented child sessions, tool output, and a final integration pass.
- **Lantern API:** a two-turn backend task with source inspection, tests, and a follow-up question.
- **Trail Map** or **Field Notes:** smaller project and local-work examples.

Use the showcase URL in a fresh browser profile or private window if you want clean local notification and theme preferences. Before publishing a capture, check any browser chrome outside the page for personal tabs or account details.
