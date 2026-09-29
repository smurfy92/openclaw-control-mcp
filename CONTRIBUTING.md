# Contributing

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

There is no linter configured. CI (`.github/workflows/ci.yml`) runs typecheck, tests and build on Node 22 and 24.

Never point tests or local runs at a real OpenClaw gateway unless you mean to: `OPENCLAW_MOCK=1` and the in-process fake gateway (`tests/helpers/fake-gateway.ts`) cover the test suite.

## Release

A release is published by `.github/workflows/publish.yml`, triggered by pushing a `v*.*.*` tag. One job does, in order:

1. `npm ci`, `npm run typecheck`, `npm test`, `npm run build`;
2. checks that the tag equals `package.json` `version`;
3. checks that `server.json` matches `package.json`: `name` == `mcpName`, `version` and `packages[0].version` == `version`, `packages[0].identifier` == `name`;
4. installs `mcp-publisher` (pinned version + sha256) and runs `mcp-publisher validate server.json` (read-only call to the registry);
5. `npm publish --provenance --access public` (npm Trusted Publishing, OIDC, no token);
6. only if step 5 succeeded: `mcp-publisher login github-oidc` then `mcp-publisher publish server.json` (MCP Registry, OIDC, no secret).

Neither publish needs a repository secret. The workflow has `id-token: write`; npm trusts the `publish.yml` workflow of this repo, and the MCP Registry grants the `io.github.<repository_owner>/*` namespace to a GitHub Actions OIDC token, which covers `io.github.smurfy92/openclaw-control-mcp`.

### Steps

1. Branch `release/X.Y.Z` from `main`.
2. Bump the version in **three** places, to the same value:
   - `package.json` `version` (and `package-lock.json`, via `npm version X.Y.Z --no-git-tag-version`);
   - `server.json` `version`;
   - `server.json` `packages[0].version`.
3. Move the `[Unreleased]` entries of `CHANGELOG.md` under `## [X.Y.Z] — YYYY-MM-DD`.
4. Open a PR, wait for CI, merge.
5. From an up-to-date `main`: `git tag vX.Y.Z && git push origin vX.Y.Z`.
6. Check the `publish` run, then both registries:
   ```bash
   npm view openclaw-control-mcp version
   curl -s 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.smurfy92/openclaw-control-mcp' \
     | jq -r '.servers[] | .server.version + "  latest=" + (._meta."io.modelcontextprotocol.registry/official".isLatest | tostring)'
   ```

### Bumping mcp-publisher

The pin lives in the `Install mcp-publisher` step (`MCP_PUBLISHER_VERSION`, `MCP_PUBLISHER_SHA256`). Take the sha256 of `mcp-publisher_linux_amd64.tar.gz` from `registry_<version>_checksums.txt` on the [release page](https://github.com/modelcontextprotocol/registry/releases). A login failing with `invalid audience` means the pinned binary is too old for the current registry deployment: bump it.

### Catching up the MCP Registry by hand

The workflow does not re-run for a tag that is already on npm (re-running it would fail at `npm publish`). If the npm publish went through but the registry step did not (or for versions released before the step existed — the registry stayed at 0.6.0 up to 0.8.2), publish `server.json` from the tagged commit with the interactive GitHub login. Example for **0.8.2** on macOS arm64 (for Intel, use `mcp-publisher_darwin_amd64.tar.gz`, sha256 `88126981225e7714fcc6b7a10cdba4a80ae5901e9740a8c06d0d5195c8bc294c`):

```bash
cd openclaw-control-mcp
git fetch --tags && git switch --detach v0.8.2

curl -fsSL -o /tmp/mcp-publisher.tar.gz \
  https://github.com/modelcontextprotocol/registry/releases/download/v1.8.1/mcp-publisher_darwin_arm64.tar.gz
echo "e45e520892460732a4bdf37255576415d4a53ec171f8b913faf15bb1aef7cb77  /tmp/mcp-publisher.tar.gz" | shasum -a 256 -c -
tar -xzf /tmp/mcp-publisher.tar.gz -C /tmp mcp-publisher

/tmp/mcp-publisher validate server.json
/tmp/mcp-publisher login github      # device flow: open github.com/login/device, enter the code, as smurfy92
/tmp/mcp-publisher publish server.json
/tmp/mcp-publisher logout

git switch main
```

The registry only accepts a version whose npm package exists and whose published `package.json` carries `"mcpName": "io.github.smurfy92/openclaw-control-mcp"` (true for 0.8.2). Publishing a version that is already in the registry is refused, so running this twice is harmless.
