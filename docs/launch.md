# Threave launch plan

## Positioning

**Promise:** Bring your coding agents together. Threave is a self-hosted place to split work across agents, models, and thinking depths; follow the activity live; collect durable results; and continue from desktop or phone.

**Audience:** Developers already using more than one coding agent, or wanting to delegate parallel tasks without losing track of the work. Lead with a real workflow and its outcome, not the control protocol.

**Proof:** A parent session delegates three different tasks, each child appears in context, each run streams tools and progress, and the parent retrieves a report. Show the same session on a phone through a private Tailscale connection. State clearly that the service runs on the user's machine and does not offer cloud sync.

**Avoid:** Claims of autonomous team management, hosted collaboration, public remote access, or a universal model matrix. Supported options depend on the installed provider CLIs. The website intentionally explains the workflow without mentioning the CLI; the README provides the technical interface for agents and developers.

## Launch assets

- `site/`: homepage, install page, and private mobile guide. Host on Cloudflare Pages at `threave.io`; add `www` redirect after the domain is registered.
- `README.md`: product overview, evidence, install paths, delegation example, mobile setup, and Gorchestra upgrade compatibility.
- A 45–60 second screen recording: start a parent, delegate research/build/verification to different providers or models, show live tool activity and reports, then reconnect on a phone. Use a real run and blur private workspace details.
- Three short clips from the same recording: parallel delegation, durable report, and mobile reconnect. Reuse consistent captions and the site mark.

## Launch sequence

1. Confirm `threave.io` availability, first-year and renewal prices, and the Cloudflare registration terms. Register one year with auto-renewal choice made deliberately; keep billing and registrant information private.
2. Create the `threave-io` GitHub organization (the exact `threave` handle is taken). Transfer `jgennari/gorchestra` as `threave-io/threave` and `jgennari/homebrew-tap` as `threave-io/homebrew-tap`. Keep GitHub's redirects, and update the local remote and release token access.
3. Commit and push the rename, run Go and frontend checks, stage the embedded frontend, and validate a local Threave binary against a separate test database. Verify an existing Gorchestra database and service config still load.
4. Create a Git-integrated Cloudflare Pages project for `site/`, with production branch `main`, root `site`, and no build command. Attach `threave.io` and `www.threave.io`, then verify HTTPS, redirects, the sitemap, and install links. The existing `threave-preview.pages.dev` direct-upload project is only a preview; Direct Upload projects cannot later switch to Git integration.
5. Tag `v0.12.0` through Prepare Release, verify GitHub release archives and checksums, and confirm the Homebrew tap update and `brew install threave-io/tap/threave`. Promote the embedded app frontend only after current runs have drained.
6. Publish the release/demo, then post a short workflow-led announcement to appropriate developer channels (for example Show HN and the project's GitHub Discussions). Respond to concrete questions with docs or fixes. Do not make the site public announcement until the install path works.

## Suggested announcement

**Title:** Show HN: Threave — weave multiple coding agents into one durable workspace

**Body:** I built Threave to coordinate the coding agents I already use. A project can branch into focused sessions across Codex, Claude, OpenCode, and Pi, with model and thinking settings chosen for each task. I can watch tools and progress live, pull back exact reports, and pick up the same sessions on my phone through a private Tailscale connection. It runs on my own machine; there is no hosted account or cloud sync. The project is open source, and I'd value feedback from people who routinely have more than one agent working at once. [Demo] [Install] [GitHub]

## First two weeks

- Track visits to `/get/`, install-guide clicks, release downloads, Homebrew installs where available, and GitHub issues. Do not add third-party analytics without a clear privacy decision; Cloudflare's aggregate Pages analytics may be enough initially.
- Watch first-install friction, provider configuration, child-report discoverability, and mobile onboarding. Turn repeated questions into documentation updates.
- Keep the old binary, environment variables, data paths, and recipe path compatible through at least one release cycle. Avoid retiring those aliases until upgrade behavior is observed.
