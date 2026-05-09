# Migrating `linkedin-outreach` from `li_at` cookie scraping to Proxycurl

**Status:** Ready to deploy. Waiting on Proxycurl credit purchase.
**Drafted:** 2026-05-09 against gateway 2026.4.12 + skill `linkedin-outreach`.

## Why

The current skill scrapes LinkedIn via the `li_at` session cookie. The cookie expires unpredictably (anywhere from days to weeks; faster under any of: IP change, OS sleep/wake, manual logout from another device, or LinkedIn's anti-bot heuristics on volume). Each expiration breaks the bot silently — User sends a request, the agent grinds for 20+ minutes, fails, and the user only notices when nothing comes back.

Proxycurl wraps the LinkedIn data layer in a maintained REST API (`https://nubela.co/proxycurl/api/v2/linkedin?url=…`). Cookie management, IP rotation, captcha handling are theirs. Cost: ~$0.01-0.05/profile, ~$50-100/month at User's volume.

## Architecture cible

```
                       ┌─────────────────┐
                       │  Discord user   │
                       │  (User)       │
                       └────────┬────────┘
                                ▼
                  ┌──────────────────────────────┐
                  │  Gateway agent `main`        │
                  │  + skill linkedin-outreach   │
                  └──────────┬───────────────────┘
                             │ reads config.tools.linkedin-outreach.proxycurlApiKey
                             │ (optional fallback: secrets.LINKEDIN_LI_AT)
                             ▼
                  ┌──────────────────────────────┐
                  │   PRIMARY (when key set):    │
                  │   Proxycurl REST API         │
                  │   nubela.co/proxycurl/api/v2 │
                  └──────────────────────────────┘
                             │
                             │ if key absent or 5xx
                             ▼
                  ┌──────────────────────────────┐
                  │   FALLBACK:                  │
                  │   cookie scraping (current)  │
                  │   www.linkedin.com           │
                  └──────────────────────────────┘
```

The skill becomes **dual-source**: try Proxycurl first; on missing key or upstream failure, fall back to the cookie path. This lets us:

- Deploy the migration **before** purchasing Proxycurl credits — the bot keeps working on cookies until the key is set.
- Roll back instantly: clear `tools.linkedin-outreach.proxycurlApiKey` from config and the skill auto-reverts.
- Compare Proxycurl vs cookie outputs side-by-side during validation before fully cutting over.

## Storing the API key (post-MCP 0.5.x)

Use the new `openclaw_secrets_set` tool. From Claude Code chat:

```jsonc
{
  "name": "openclaw_secrets_set",
  "arguments": {
    "name": "proxycurlApiKey",
    "value": "<paste Proxycurl API key here>",
    "scope": "tools.linkedin-outreach"
  }
}
```

This calls `config.patch` under the hood with `mergePath: "tools.linkedin-outreach.proxycurlApiKey"` — the value lands at `config.tools.linkedin-outreach.proxycurlApiKey` in the gateway config.

To verify:

```jsonc
{
  "name": "openclaw_config_get",
  "arguments": { "path": "tools.linkedin-outreach" }
}
```

To revert (e.g. when credits run out):

```jsonc
{
  "name": "openclaw_config_patch",
  "arguments": {
    "mergePath": "tools.linkedin-outreach.proxycurlApiKey",
    "mergeValue": null
  }
}
```

The skill detects the absent key on next run and falls back to the cookie path automatically.

## Skill changes (gateway-side, in `/data/.openclaw/agents/main/skills/linkedin-outreach/`)

The skill is a markdown file with embedded tool calls. Replace the cookie-fetch tool call with a Proxycurl-first dispatcher:

### Before (current `linkedin-outreach.md` excerpt — pseudo)

```yaml
tools:
  - name: fetch_linkedin_profile
    description: Fetch a profile via cookie-authenticated scrape.
    args:
      url: string
    impl: |
      cookie = secrets.LINKEDIN_LI_AT
      response = http.get(url, headers={ "Cookie": "li_at=" + cookie })
      return parse_html(response.body)
```

### After (dispatcher with fallback)

```yaml
tools:
  - name: fetch_linkedin_profile
    description: |
      Fetch a profile. Tries Proxycurl first (zero-maintenance, ~$0.02 per call);
      falls back to cookie scraping when the API key is unset or Proxycurl returns
      5xx / rate-limited. Returns the same shape regardless of source so the rest
      of the skill doesn't care which path was used.
    args:
      url: string
    impl: |
      api_key = config.get("tools.linkedin-outreach.proxycurlApiKey")
      if api_key:
        try:
          r = http.get(
            "https://nubela.co/proxycurl/api/v2/linkedin",
            params={ "url": url, "use_cache": "if-recent" },
            headers={ "Authorization": "Bearer " + api_key },
            timeout=30,
          )
          if r.status == 200:
            return normalize_proxycurl(r.json)
          # Fall through to cookie path on 4xx (rate limit, bad key) or 5xx
        except TimeoutError:
          pass

      # Fallback: cookie-based scrape
      cookie = secrets.LINKEDIN_LI_AT
      if not cookie:
        raise SkillError(
          "Cannot fetch profile — no Proxycurl API key set AND no LINKEDIN_LI_AT cookie. "
          "Either: (1) purchase Proxycurl credits and set tools.linkedin-outreach.proxycurlApiKey, "
          "or (2) refresh the LinkedIn cookie via openclaw_config_patch."
        )
      response = http.get(url, headers={ "Cookie": "li_at=" + cookie })
      return parse_html(response.body)

  - name: normalize_proxycurl
    description: Map Proxycurl's response shape to the same fields the cookie-path returns.
    args:
      raw: object  # the JSON from /proxycurl/api/v2/linkedin
    impl: |
      return {
        "name": raw["full_name"],
        "headline": raw["headline"],
        "company": raw.get("experiences", [{}])[0].get("company"),
        "title": raw.get("experiences", [{}])[0].get("title"),
        "location": raw.get("city") or raw.get("country_full_name"),
        "summary": raw.get("summary"),
        "posts": raw.get("activities", [])[:10],  # last 10 posts
        "_source": "proxycurl",
      }
```

The cookie-path output should be normalized to the **same shape** so the rest of the skill (email drafting, personalization, send) is source-agnostic.

## Skill prompt changes

Add an explicit hint in the skill prompt so the agent surfaces source provenance:

```diff
  Each draft email should include:
+ - At the bottom of the agent's reasoning trace (not in the email itself):
+   "Source: <Proxycurl | LinkedIn-cookie>" so we can audit which path generated it.
```

This makes it possible to grep session previews after the fact and confirm which source was used per profile.

## Cost monitoring

After cutover, add a daily check:

```jsonc
// Schedule a daily 09:00 cron that pings Proxycurl /credits-balance
{
  "name": "openclaw_cron_add_daily",
  "arguments": {
    "name": "proxycurl-credit-watch",
    "hour": 9,
    "tz": "Europe/Paris",
    "message": "Check Proxycurl credit balance and send a Discord summary to #reports if < 200 credits remaining.",
    "channel": "discord",
    "to": "<channel-id-redacted>",
    "deliveryMode": "announce",
    "timeoutSeconds": 60
  }
}
```

The skill checks `https://nubela.co/proxycurl/api/credit-balance` (free) and announces a low-credit warning before service is disrupted.

## Rollout plan

1. **Now (no credits)** — Deploy the dispatcher version of `linkedin-outreach`. Without the API key configured, it falls back to cookie scraping every call (zero behaviour change for users).
2. **Day of credit purchase** — `openclaw_secrets_set({ name: "proxycurlApiKey", value: "...", scope: "tools.linkedin-outreach" })`. From the next agent run on, Proxycurl is primary.
3. **Validation week** — monitor session previews for `Source: proxycurl` vs `Source: LinkedIn-cookie` ratio. Should be ~100% Proxycurl. Spot-check 5 profiles to compare outputs.
4. **Steady state** — `proxycurl-credit-watch` cron runs daily. If credits run out, manual `config.patch` removes the key, fallback resumes automatically.

## What to verify before declaring "done"

- [ ] `openclaw_config_get({ path: "tools.linkedin-outreach" })` shows `proxycurlApiKey` is set.
- [ ] A test outreach run completes successfully end-to-end with a real LinkedIn URL.
- [ ] The agent's session preview includes `Source: proxycurl` at the bottom.
- [ ] `openclaw_logs_tail({ component: "skill:linkedin-outreach", level: "ERROR" })` returns 0 hits over a full week.
- [ ] Cost on `https://nubela.co/dashboard/billing` matches the expected `~$X / month` ballpark.
- [ ] Falling back to cookie path tested: temporarily clear the API key, run an outreach, verify it still works on cookie.

## Out of scope (for a later iteration)

- **Proxycurl sub-features** (company profile, posts deep-dive, contact search) — can be added incrementally once the core profile fetch is stable.
- **Multi-tenant Proxycurl billing** if multiple OpenClaw users share this key — Proxycurl supports sub-accounts but this isn't a concern for a single-tenant Example Org deploy.
- **Cookie auto-refresh daemon** — only useful if you go back to cookie-only. Not deploying alongside Proxycurl since they solve overlapping problems.
