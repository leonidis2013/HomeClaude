# HomeClaude

A bridge between Claude and your Home Assistant, for building and troubleshooting, not for everyday control. It runs as its own Docker container, logs in to Home Assistant through Home Assistant's **own REST and WebSocket APIs** with a long-lived access token, and gives Claude a Model Context Protocol (MCP) endpoint. Nothing is installed in Home Assistant: no HACS, no custom integration, no add-on. Same look and settings layout as LiveCompanion and LiveMic.

- **Reads everything you need to troubleshoot:** an overview (version, unavailable entities, failed integrations, open repairs, log counts), entity details with the automations that use them, state history, logbook, the error log, integrations, repairs, automation and script configs, **automation and script traces** (why something did or did not run), services, devices and areas. It can test templates and run the config check.
- **Changes are off until you switch them on**, one by one: edit automations and scripts (and reload YAML), call services, delete, restart.
- **Blocked domains** (default `lock`, `alarm_control_panel`, `cover`): Claude can read them, but HomeClaude refuses any service call in those domains or aimed at their entities, and refuses to save automations or scripts whose actions would do that. These checks run in HomeClaude, so they hold whatever Claude asks for.
- **Backups before every change.** Before Claude changes or deletes an automation or script, the old version is saved. **Restore** puts it back from the Backups page.
- **Activity list** of every request Claude made, with errors, and changes marked.
- **Off switch** for Claude access on the dashboard, an access token you can replace any time, and an optional control PIN for the page.

## Run it

Docker / Docker Compose:

```
docker compose up -d
```

TrueNAS SCALE: Apps > Discover Apps > Custom App > **Install via YAML**, paste `truenas-app.yaml`, set the dataset path, and give uid 1000 write access to it. It uses the `latest` image with `pull_policy: always`, so it gets the newest version whenever the app restarts. Images are built for amd64 and arm64 by the GitHub workflow (`ghcr.io/leonidis2013/homeclaude`).

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

### claude.ai, Claude Desktop and the phone app

These connect from Anthropic's servers, not from your device, so HomeClaude must be reachable from the internet over **https**, for example with a Cloudflare Tunnel or your reverse proxy pointing at the container. Enter that address under Settings > Connect Claude > Public address. Then on claude.ai: **Customize > Connectors > + Add > Add custom connector**, paste the URL (`https://your-address/mcp`), choose **No sign in**, and add the request header `Authorization: Bearer <token>`. The same connector then works in Claude Desktop and the phone app. If an app has no place for headers, `https://your-address/mcp/<token>` also works.

Exposing it to the internet means the token is all that protects it: keep the permissions as narrow as you need, and use **New token** if it ever leaks.

### Try it

> Use HomeClaude to give me an overview of my Home Assistant.

> My freezer alert didn't fire last night. Find out why.

## What Claude cannot do here

- **YAML-only configuration.** Automations without an `id`, packages, `configuration.yaml`, template sensors and so on are not reachable through Home Assistant's API. Claude can read their traces, logs and the config check, and tell you what to change in which file. For hands-on YAML work, pair this with the official **File editor** or **Samba share** add-on and keep your `config` folder in a Git repository.
- **Helpers, dashboards, users, integrations setup, Supervisor and add-ons** are not covered in this version.
- Scenes and scripts that already exist are run as they are: if a script unlocks a door, `script.turn_on` runs it. Blocking checks what Claude sends and what it saves, not what existing scripts do.

## Security: please read

- The access token gives whoever holds it what Permissions allows. It is stored encrypted (AES-256-GCM, key in `/data/secret.key`), and so is the Home Assistant token.
- There is **no login on the page** by default. Anyone who can open it can change permissions and see the access token. Keep it on a trusted network, or set a **control PIN** (Settings > Settings > Control); with a PIN, every change and showing the token need it.
- Requests to `/mcp` that come from a web page (with a foreign `Origin`) are refused, so another site in your browser cannot use it.
- The Home Assistant user you made for Claude can be disabled in Home Assistant at any time, which cuts HomeClaude off completely.

## How it talks to Claude

`POST /mcp` with JSON-RPC, answered as plain JSON (no event stream, no sessions). It supports the current stateless MCP revision (2026-07-28, `server/discover`) and the older `initialize` handshake (2024-11-05 to 2025-11-25), so newer and older Claude apps both connect. Tools that change things are only listed when they are switched on.

## Testing status

`npm test` runs 12 tests: the blocking rules, the MCP protocol, every tool against a pretend Home Assistant (including backups, pruning, refusals and the restart check), the real Home Assistant client over HTTP and WebSocket against a fake Home Assistant server (including a refused token and an unreachable host), and the whole server over HTTP (token, Origin check, off switch, PIN, saving and restoring an automation, new token). Connecting with the official MCP Python SDK client works in both the 2026-07-28 and the older handshake mode. The page was checked in a browser in demo mode, on desktop and phone sizes.

**Not tested against a real Home Assistant.** The API calls follow Home Assistant's documented REST and WebSocket APIs, but a real instance, with its own versions and data, could not be used where this was written. Expect some first-run fixes; please report what you find.

## Versions

`major.minor.patch` in `package.json`; the GitHub workflow tests, then builds and publishes the image tagged `latest` and with that version on every push to `main`.
