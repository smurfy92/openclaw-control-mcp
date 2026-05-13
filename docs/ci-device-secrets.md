# Provisioning a CI device for `drift-watch`

The `drift-watch` workflow needs to authenticate to the gateway like any
other client, but it has no on-disk store. To avoid the bootstrap pair flow
on every run, four secrets are injected via env vars and the wrapper reads
them with priority over the store.

| Secret | What it is | Where it comes from |
|---|---|---|
| `OPENCLAW_GATEWAY_URL` | WebSocket URL the runner uses to reach the gateway | `ws://127.0.0.1:<port>/v1/ws` when the runner is colocated, else the public WSS URL |
| `OPENCLAW_GATEWAY_TOKEN` | Operator-level gateway token | Same value you use locally — find it in your gateway admin panel |
| `OPENCLAW_DEVICE_PRIVATE_KEY` | base64url-encoded Ed25519 32-byte seed of a **pre-paired** device | Extracted from a local keychain bundle, OR a fresh device you create just for CI |
| `OPENCLAW_DEVICE_TOKEN` | Device token the gateway issued after that device paired | Same source as above |

## Option A — extract from an existing local install (quickest)

Reuses the device you already paired on your workstation. Acceptable when
the CI runner is a single-purpose probe (e.g. drift-watch). For larger
fleets, prefer Option B.

### macOS (keychain bundle)

The bundle item is keyed as service `openclaw-control-mcp:secrets-bundle`
(namespaced prefix) with the account set to the current unix user — NOT
service `openclaw-control-mcp` with account `secrets-bundle`. Two common
pitfalls:

- swapping the `-s` / `-a` args returns "specified item could not be found"
- the bundle is only written by 0.6.1+; if you came from an older version,
  trigger any tool call once first so the lazy migration writes the bundle

```bash
USER=$(whoami)
BUNDLE=$(security find-generic-password -a "$USER" -s "openclaw-control-mcp:secrets-bundle" -w)
GW_ID=$(cat ~/.config/openclaw-control-mcp/store.json | jq -r '.tokens | keys[0]')

DEVICE_PRIVATE_KEY=$(echo "$BUNDLE" | jq -r '.device.privateKey')
DEVICE_TOKEN=$(echo "$BUNDLE" | jq -r --arg gw "$GW_ID" '.tokens[$gw]')
GATEWAY_TOKEN=$(echo "$BUNDLE" | jq -r '.configs.default.gatewayToken')

# sanity check — these must all print non-empty strings
[ -n "$DEVICE_PRIVATE_KEY" ] && echo "device key: OK ($(echo "$DEVICE_PRIVATE_KEY" | wc -c) chars)"
[ -n "$DEVICE_TOKEN" ] && echo "device token: OK"
[ -n "$GATEWAY_TOKEN" ] && echo "gateway token: OK"

REPO=smurfy92/openclaw-control-mcp
gh secret set OPENCLAW_DEVICE_PRIVATE_KEY --body "$DEVICE_PRIVATE_KEY" --repo "$REPO"
gh secret set OPENCLAW_DEVICE_TOKEN --body "$DEVICE_TOKEN" --repo "$REPO"
gh secret set OPENCLAW_GATEWAY_TOKEN --body "$GATEWAY_TOKEN" --repo "$REPO"
gh secret set OPENCLAW_GATEWAY_URL --body "ws://127.0.0.1:<port>/v1/ws" --repo "$REPO"
```

### Linux (libsecret bundle)

```bash
BUNDLE=$(secret-tool lookup service openclaw-control-mcp account secrets-bundle)
# … same jq extraction + gh secret set sequence as above
```

## Option B — provision a dedicated CI device

Cleaner separation: a CI failure can't trash your local workspace, and you
can rotate the CI device independently. Two paths to a paired device, both
end-state-equivalent:

1. **Via a local install you throw away after extraction**

   ```bash
   # in a fresh tmpdir on your workstation
   OPENCLAW_CONTROL_HOME=$(mktemp -d) OPENCLAW_USE_KEYCHAIN=0 \
     npx -y openclaw-control-mcp --health
   # follow the prompts to pair (the gateway admin panel will show the request)
   # then read the device + token out of $OPENCLAW_CONTROL_HOME/store.json
   ```

2. **Directly from the gateway control panel**, if your gateway exposes a
   "create paired device" admin endpoint. Output should give you a
   `privateKey` + `deviceToken` pair you can drop straight into the GitHub
   secrets.

Once you have the values:

```bash
REPO=smurfy92/openclaw-control-mcp
gh secret set OPENCLAW_DEVICE_PRIVATE_KEY --body "<private-key>" --repo "$REPO"
gh secret set OPENCLAW_DEVICE_TOKEN --body "<device-token>" --repo "$REPO"
```

## Verifying the secrets are wired

After `gh secret set …`, trigger the workflow manually:

```bash
gh workflow run drift-watch.yml
sleep 30 && gh run list --workflow=drift-watch.yml --limit 1
```

A green run means env-only auth works. A run that fails with
`GatewayError: pairing required` means the device isn't paired on the
gateway side — re-check the pair flow. A run that fails with
`unauthorized` means the gateway token doesn't match.

## Rotation

The device secrets are long-lived but rotatable:

```bash
# generate a new device locally (see Option B), then:
gh secret set OPENCLAW_DEVICE_PRIVATE_KEY --body "<new-private-key>" --repo "$REPO"
gh secret set OPENCLAW_DEVICE_TOKEN --body "<new-device-token>" --repo "$REPO"

# revoke the old device on the gateway side via the control panel.
```

No need to redeploy the workflow — the next run picks up the new values.
