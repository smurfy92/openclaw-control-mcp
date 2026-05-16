# VHS script for the README demo GIF.
#
# Generate with:
#   brew install vhs
#   vhs scripts/demo.tape
# Output: demo.gif (in repo root). Move to docs/ and reference in README.
#
# The demo uses --mock so it runs without a live gateway. Keep the recording
# under 35s — long demos burn attention on a GitHub README.

Output demo.gif

Set FontSize 14
Set Width 1100
Set Height 620
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms
Set Shell "bash"

Type "# 1. Register the server with Claude Code"
Sleep 800ms
Enter
Type "claude mcp add openclaw-control -- npx -y openclaw-control-mcp"
Sleep 600ms
Enter
Sleep 1500ms

Type "# 2. Quick sanity check against a mock gateway (no pairing needed)"
Sleep 800ms
Enter
Type "OPENCLAW_MOCK=1 npx -y openclaw-control-mcp --health | jq '{gateway, paired, scopes, version}'"
Sleep 600ms
Enter
Sleep 3000ms

Type "# 3. From Claude Code, the assistant can now operate the gateway:"
Sleep 800ms
Enter
Type '#    > "List my crons and show which ones are overdue"'
Sleep 600ms
Enter
Type "#    > \"Tail session agent:main:cron:42 for 30s and summarise the assistant turn\""
Sleep 600ms
Enter
Type "#    > \"Rotate the proxycurl API key — read it from 1Password\""
Sleep 800ms
Enter
Sleep 2500ms

Type "# 134 typed tools — the full OpenClaw control plane from chat."
Sleep 3000ms
