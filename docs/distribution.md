# Distribution

Gorchestra has two distribution paths: GitHub release downloads and the
`jgennari/homebrew-tap` Homebrew tap.

## GitHub Releases

Publishing a tag that looks like `v0.1.2` runs `.github/workflows/release.yml`.
The workflow builds the frontend, stages the embedded assets, runs backend
tests, cross-compiles release binaries, packages them as tarballs, writes
`SHA256SUMS`, and publishes everything to a GitHub release.

Because the Homebrew source formula builds without Bun, release tags must point
to commits where `internal/webassets/dist` is current. The workflow checks this
after rebuilding the frontend and fails if embedded assets are out of date.

Release archives are named:

```txt
gorchestra_<version>_<os>_<arch>.tar.gz
gorchestra_<version>_windows_<arch>.zip
```

Initial targets:

- `darwin/arm64`
- `darwin/amd64`
- `linux/arm64`
- `linux/amd64`
- `windows/arm64`
- `windows/amd64`

Build the same release archives locally:

```sh
cd web
bun install --frozen-lockfile
bun run build

cd ..
bun run build:stage
go test ./...
VERSION=0.1.0 bun run release:archives
```

The generated tarballs and `SHA256SUMS` are written to `dist/`.

## Homebrew

The published formula lives in `jgennari/homebrew-tap`:

```sh
brew install jgennari/tap/gorchestra
brew test jgennari/tap/gorchestra
brew audit --strict --online jgennari/tap/gorchestra
```

The starter formula template lives at `packaging/homebrew/gorchestra.rb.template`.
The release workflow updates the tap automatically after a successful tagged
release using the `HOMEBREW_TAP_TOKEN` Actions secret.

For a manual tap update:

1. Copy or update the template in `Formula/gorchestra.rb`.
2. Replace `{{VERSION}}` with the release version without the leading `v`.
3. Replace `{{SOURCE_SHA256}}` with the SHA-256 of the GitHub source archive:

   ```sh
   VERSION=0.1.2
   curl -L "https://github.com/jgennari/gorchestra/archive/refs/tags/v${VERSION}.tar.gz" | shasum -a 256
   ```

4. Commit and push the tap.
5. Run `brew update`, `brew test jgennari/tap/gorchestra`, and
   `brew audit --strict --online jgennari/tap/gorchestra`.

The formula builds from source with Go and uses the embedded frontend assets
committed in this repository. It does not require Bun during installation.

Later, macOS artifacts can be signed and notarized.
