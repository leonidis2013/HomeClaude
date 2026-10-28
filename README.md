# HomeClaude

A bridge between Claude and your Home Assistant, for building and troubleshooting, not for everyday control. It runs as its own Docker container, logs in to Home Assistant through Home Assistant's **own REST and WebSocket APIs** with a long-lived access token, and gives Claude a Model Context Protocol (MCP) endpoint. Nothing is installed in Home Assistant: no HACS, no custom integration, no add-on. Same look and settings layout as LiveCompanion and LiveMic.

- **Reads everything you need to troubleshoot:** an overview (version, unavailable entities, failed integrations, open repairs, log counts), entity details with the automations that use them, state history, logbook, the error log, integrations, repairs, automation and script configs, dashboards, **automation and script traces** (why something did or did not run), services, devices and areas. It can test templates and run the config check.
- **One set of permission levels**, all on the Permissions page: **Look only** (read everything), **Help build** (also create and change automations, scripts and dashboards, reload YAML), **Hands on** (also run services), **Full** (also delete and restart; only on your network). Claude on your network gets a level, each connection from outside gets its own level, and one "highest level from outside" limit sits over all of them. Starts at Look only.
- **Blocked domains** (default `lock`, `alarm_control_panel`, `cover`): Claude can read them, but HomeClaude refuses any service call in those domains or aimed at their entities, and refuses to save automations, scripts or dashboard buttons whose actions would do that (a card that only shows a lock or garage door is fine). These checks run in HomeClaude, so they hold whatever Claude asks for.
- **Keep or revert.** Each change Claude makes to an automation, script or dashboard goes live at once, is backed up, and waits on the dashboard as a card showing exactly what changed (before and after, in YAML) with **Keep** and **Revert**. If Claude changes the same thing again before you answer, Revert still goes back to the version before its first change; reverting a new automation deletes it, reverting a deletion brings it back. Optionally, an unanswered change is reverted (or kept) automatically after 15 minutes to 24 hours. Claude is told about the review, and sees what you reverted. Set it up under Permissions; history is in Activity.
- **Labels and categories.** Claude can list labels and categories, find entities by label, create or rename labels and categories, and put labels on (or take them off) entities, devices and areas, and file automations, scripts, scenes and helpers into categories. Needs Help build; each change goes through keep or revert like any other. Deleting labels or categories is left to you in Home Assistant.
- **Dashboards.** Claude can list your dashboards with an outline of their views, read one dashboard or one view of it, change one view at a time (replace, add, move or remove a view) or a whole dashboard, create dashboards and change their title, icon and sidebar settings, and (at Full) delete them. Overview included: if Home Assistant still builds it by itself, Claude asks before taking control of it, and Revert hands it back. Dashboards kept in YAML can be read but not changed. Needs Help build; each change is backed up and goes through keep or revert.
- **ESPHome device configs.** With the ESPHome Device Builder app in Home Assistant, Claude can list your ESPHome devices, read a device's YAML, validate it, and (at Help build) change it. HomeClaude reaches the Device Builder's own MCP endpoint through Home Assistant's ingress, the same way Home Assistant's web page opens the app, so no port has to be opened; a standalone Device Builder without a password can be given by address instead (Settings > Home Assistant > ESPHome). Every save is backed up, validated (an invalid file is put back unless Claude is told to keep it), refused if the file changed since Claude read it or if it would make Home Assistant act on a blocked domain, and goes through keep or revert. Passwords and keys written inline in a file are hidden from Claude and put back on save; `secrets.yaml` is never read or written (Claude sees only its names). **HomeClaude never compiles or installs firmware**: you install from the Device Builder, so a bad flash cannot come from here.
- **Backups before every change.** Before Claude changes or deletes an automation, script, dashboard or ESPHome config, the old version is saved (for a dashboard, its settings too, so a deleted one comes back whole). **Restore** puts it back from the Backups page.
- **Activity list** of every request Claude made, with errors, and changes marked.
- **System health:** the dashboard checks that HomeClaude can actually save (it writes, reads back and deletes a test file, with a time limit, so a hung or read-only network share is caught), free space, whether `/data` is really on a volume, and the container's memory and load. Problems show on the dashboard, in the header and in the setup guide, in plain words.
- **Off switch** for Claude access on the dashboard, an access token you can replace any time, and an optional control PIN for the page.

## Run it

Docker / Docker Compose:

```
docker compose up -d
```

TrueNAS SCALE: Apps > Discover Apps > Custom App > **Install via YAML**, paste `truenas-app.yaml`. Its data goes in a volume TrueNAS manages (`homeclaude-data`), like LiveMic's, so there is no dataset or permission to set up. To keep it on a dataset of yours instead, map that path to `/data` and give uid 1000 write access. It uses the `latest` image with `pull_policy: always`, so it gets the newest version whenever the app restarts. Images are built for amd64 and arm64 by the GitHub workflow (`ghcr.io/leonidis2013/homeclaude`).

Without Docker: `node server.js` (Node 22+, no npm packages). `node server.js --demo` runs against a pretend Home Assistant, with the access token `demo`.

Settings, the encrypted tokens, the activity list and backups live in `/data` (the volume).

## Set up

The first time you open HomeClaude, a **setup guide** walks you through it one step at a time, with every step and its status down the left side: make a user and token in Home Assistant, connect (it tells you what went wrong if it cannot, and checks the user is an administrator), choose what Claude may change (Look only, Help build or Hands on), an optional PIN, and connecting Claude (it turns green by itself when Claude's first request arrives). You can open it again from Settings > Settings > Setup guide. The same steps by hand:

1. **Make a user for Claude in Home Assistant.** Settings > People > Users > Add user, for example "Claude", with **Administrator** on (logs, traces, integrations and automation configs are only open to administrators). Everything Claude does then shows in the logbook under that name.
2. **Make a token.** Log in as that user, open its profile > **Security** > Long-lived access tokens > **Create token**, and copy it.
3. **Open HomeClaude** at `http://<this machine>:8080` (9085 on TrueNAS). Under Settings > Home Assistant enter the address, using the **IP address** (for example `http://192.168.1.10:8123`; `.local` names usually do not resolve inside a container), paste the token, and **Save**. The status turns green.
4. **Connect Claude** (button on the dashboard, or Settings > Connect Claude).

### Claude Code on a computer on your network

Run the command HomeClaude shows, once:

```
claude mcp add --transport http homeclaude http://192.168.1.20:9085/mcp --header "Authorization: Bearer <token>"
```

### claude.ai, Claude Desktop and the phone app: exposed mode

These connect from Anthropic's servers, not from your device, so HomeClaude has to be reachable from the internet. That is **exposed mode** (the **Security** tab (shield button in the top bar)):

1. Set a **control PIN** (required in exposed mode).
2. Point a reverse proxy with an https certificate, for example a **Cloudflare Tunnel** or Nginx Proxy Manager, at HomeClaude's **public port**: container port 8081, published as **9086** in `truenas-app.yaml`. Never forward the settings port (9085).
3. Enter the public address (for example `https://homeclaude.yourdomain.com`), switch to **Exposed**, and press **Test**. HomeClaude calls its own public address and checks that it reaches the public port, that the settings page and its API are not reachable from outside, that Claude can find the sign-in, and that `/mcp` refuses unsigned requests.
4. On claude.ai: **Customize > Connectors > + Add > Add custom connector**, paste `https://homeclaude.yourdomain.com/mcp`, leave Authentication on its default sign-in, **Add**, then **Connect**.
5. A HomeClaude sign-in page opens with a code like `K7Q-2XM`. The same code appears in a banner on HomeClaude's page at home. Check that they match, choose what this connection may do (Look only, Help build, Hands on), and **Approve**. Away from home, type the code from your authenticator app on the sign-in page instead (once set up in the Security tab). The connector then works in Claude Desktop and the phone app too.

### Try it

> Use HomeClaude to give me an overview of my Home Assistant.

> My freezer alert didn't fire last night. Find out why.

> Add a Garage view to my Home dashboard with the freezer temperature and the garage door.

> Make my RO water ESPHome node reset its daily flow total at midnight.

## What Claude cannot do here

- **YAML-only configuration.** Automations without an `id`, packages, `configuration.yaml`, template sensors and so on are not reachable through Home Assistant's API. Claude can read their traces, logs and the config check, and tell you what to change in which file. For hands-on YAML work, pair this with the official **File editor** or **Samba share** add-on and keep your `config` folder in a Git repository.
- **ESPHome firmware.** Compiling and installing (flashing) stay in the ESPHome Device Builder, as do new devices (made with its wizard) and `secrets.yaml`. The ESPHome tools need a Device Builder with its MCP endpoint (`/api/mcp`, in current versions of the app).
- **Helpers, users, integrations setup, Supervisor and add-ons** are not covered in this version, nor are dashboard resources (custom cards are installed in Home Assistant).
- Scenes and scripts that already exist are run as they are: if a script unlocks a door, `script.turn_on` runs it. Blocking checks what Claude sends and what it saves, not what existing scripts do.

## Security

### Local only (default)
- HomeClaude answers only on your network. The public port (8081) serves nothing.
- Claude Code on your network uses the access token (`Authorization: Bearer`, or `/mcp/<token>`).
- There is **no login on the page** unless you set a **control PIN** (Settings > Settings > Control). With a PIN, every change and showing the token need it. Five wrong PINs lock that address out for 10 minutes.

### Exposed
- **Two doors.** The settings page and its API stay on the private port. In exposed mode that port refuses anything that came through a proxy (`X-Forwarded-For`, `Forwarded`, `CF-Connecting-IP` and similar) and anything from outside the private address ranges, so even a proxy pointed at the wrong port cannot open it. The public port serves only Claude's sign-in and `/mcp`; everything else is 404.
- **Sign-in with approval at home, no password on the internet.** OAuth 2.1 with PKCE (S256 only): protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591) and client ID metadata documents (how claude.ai identifies itself). Nothing connects until you approve the matching code on the page at home, so there is nothing on the public side to guess.
- **Approve from anywhere with an authenticator code (optional).** Set it up in the Security tab by scanning a QR code with any authenticator app (Google or Microsoft Authenticator, 1Password, Authy, the iPhone Passwords app; standard TOTP: SHA-1, 6 digits, 30 s). Claude's sign-in page then also accepts the 6-digit code, up to the permission level you allow (Help build by default). Each code works once; 5 wrong tries cancel that request; 5 wrong codes in an hour pause code approvals for the hour; 20 in a day switch them off until you switch them back on at home, so nobody gets more than 20 guesses. The secret is stored encrypted.
- **Access time per connection.** When you approve, choose how long the connection may be used: 1 hour, 8 hours, 1 day, 7 days, 30 days or no limit (preselected from a default you set). Each connection shows a live countdown and can be extended or revoked; when the time runs out, Claude has to sign in and be approved again. The 10-minute window for answering a sign-in request counts down live on the dashboard and on Claude's sign-in page.
- **Per-connection levels**, chosen on approval and changeable later on the Permissions page. A connection from outside never goes above the outside limit, and **Full (deleting and restarting) never works from outside**.
- **Short-lived, rotating tokens.** Access tokens last an hour; refresh tokens rotate on every use and expire after 30 days unused. Re-using an old refresh token, or a sign-in code twice, revokes that connection at once (theft detection). Only SHA-256 hashes of tokens are stored. Revoke any connection, or all, from the **Security** tab (shield button in the top bar).
- **The plain access token does not work from outside** unless you turn that on, and then only with the permission level you pick. Tokens in the address (`/mcp/<token>`) never work on the public port.
- **Abuse limits.** 10 failed attempts lock an address out for 30 minutes; widespread failures pause sign-in from outside for 10 minutes; app registrations, sign-in requests and pending approvals are rate-limited; each connection is limited to 120 requests a minute.
- **https only.** The public port refuses requests the proxy did not mark `X-Forwarded-Proto: https`, and requests for any host name other than your public address. Responses carry HSTS.
- **Strict headers** everywhere: a Content-Security-Policy that only runs HomeClaude's own scripts (by hash), no framing, no referrer, `nosniff`. Requests to `/mcp` from a web page with a foreign `Origin` are refused.
- **Security events** (sign-in requests, approvals, revocations, lockouts, refused requests, mode changes) are listed in the **Security** tab (shield button in the top bar).

### Encryption at rest
- The Home Assistant token and the access token are encrypted with AES-256-GCM.
- By default the key is in `/data/secret.key`. To keep it off the volume, set `HOMECLAUDE_MASTER_KEY` in the app's environment (see `truenas-app.yaml`). HomeClaude derives the key with scrypt, re-encrypts the tokens and deletes `secret.key`; a copy of the volume alone is then useless. If the variable is later wrong or missing, the page says so and you enter the Home Assistant token again.
- The Home Assistant user you made for Claude can be disabled in Home Assistant at any time, which cuts HomeClaude off completely.

## How it talks to Claude

`POST /mcp` with JSON-RPC, answered as plain JSON (no event stream, no sessions). It supports the current stateless MCP revision (2026-07-28, `server/discover`) and the older `initialize` handshake (2024-11-05 to 2025-11-25), so newer and older Claude apps both connect. Tools that change things are only listed when they are switched on.

**When you change a level while Claude is connected:** the tool list says to fetch it again after 5 seconds, so apps that honour that pick up the change by themselves. Apps that keep the list they loaded get a short note at the top of their next HomeClaude answer, once per change, naming what is now allowed or no longer allowed and saying to reconnect the HomeClaude connector (or start a new chat). Removed tools are refused at once either way. See ROADMAP.md for live notifications.

## Testing status

`npm test` runs 33 tests: labels and categories (and reverting them), the once-only note after a level change, permission levels (including moving older settings over), keep or revert (edits, creations, deletions, repeated edits, the no-answer timer), access time (expiry, extension), authenticator codes (RFC 6238 values, drift, replay) and approving with them end to end (limits, pause, encryption), the network and lockout rules, the master key move, OAuth (approval, PKCE, one-time codes, refresh rotation, theft detection, client metadata documents), exposed mode end to end (private port refuses proxied requests, public port hides the settings, https and host checks, lockouts, PIN lockout), the health checks (storage, mounts, memory), the blocking rules, the MCP protocol, every tool against a pretend Home Assistant (including backups, pruning, refusals and the restart check), the real Home Assistant client over HTTP and WebSocket against a fake Home Assistant server (including a refused token and an unreachable host), the whole server over HTTP (token, Origin check, off switch, PIN, saving and restoring an automation, new token), and ESPHome: hidden inline keys put back exactly, blocked actions, file names (no secrets.yaml, no folders), read-before-save, validation with put-back, keep or revert and restore, and reaching a pretend Device Builder through a fake Home Assistant ingress (including a new session when the Supervisor ends one). The official MCP Python SDK client connects in both the 2026-07-28 and the older handshake mode, including the full OAuth sign-in with approval at home, and gets only the tools its connection allows. The page was checked in a browser in demo mode, on desktop and phone sizes.

**ESPHome** follows the Device Builder's documented MCP endpoint and Home Assistant's ingress WebSocket commands as of October 2026, but has not been run against a real Device Builder yet.

**Not tested against a real Home Assistant.** The API calls follow Home Assistant's documented REST and WebSocket APIs, but a real instance, with its own versions and data, could not be used where this was written. Expect some first-run fixes; please report what you find.

## Versions

`major.minor.patch` in `package.json`; the GitHub workflow tests, then builds and publishes the image tagged `latest` and with that version on every push to `main`.
