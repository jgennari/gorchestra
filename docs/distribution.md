# Distribution

Gorchestra has two planned distribution paths: GitHub release downloads and a
Homebrew tap.

## GitHub Releases

Publishing a tag that looks like `v0.1.0` runs `.github/workflows/release.yml`.
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

The starter formula lives at `packaging/homebrew/gorchestra.rb.template`.
For the first tap release:

1. Create a `jgennari/homebrew-tap` repository.
2. Copy the template to `Formula/gorchestra.rb`.
3. Replace `{{VERSION}}` with the release version without the leading `v`.
4. Replace `{{SOURCE_SHA256}}` with the SHA-256 of the GitHub source archive:

   ```sh
   curl -L https://github.com/jgennari/gorchestra/archive/refs/tags/v0.1.0.tar.gz | shasum -a 256
   ```

5. Run `brew audit --strict --online gorchestra` and `brew test gorchestra`
   from the tap checkout.

The formula builds from source with Go and uses the embedded frontend assets
committed in this repository. It does not require Bun during installation.

Later, the release workflow can update the tap automatically after a successful
release, and macOS artifacts can be signed and notarized.
