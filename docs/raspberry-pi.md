# Running UniContext on a Raspberry Pi

A Pi on the home network keeps UniContext running when the PC is off or asleep. Tested on a
Raspberry Pi 5 (4 GB), Raspberry Pi OS bookworm (arm64), Node.js 22.

## What differs from a desktop

- **Secrets**: the Pi has no unlocked Secret Service when nobody is signed in at its desktop, so
  secrets go to `<data dir>/secrets.json` (mode 0600, protected by the account like an SSH key).
  UniContext uses that file whenever it exists, or when `UNICONTEXT_SECRET_STORE=file` is set.
  `unicontext doctor` shows which store is in use.
- **Browser**: Chrome and Edge are not built for Linux on ARM. After the `chrome` / `msedge`
  channels fail, UniContext launches `/usr/bin/chromium` or `/usr/bin/chromium-browser`
  (`sudo apt install chromium-browser`). `browser.executablePath` still overrides it.
- **Signing in**: `unicontext login <source>` opens a browser window: run it from the PC (below),
  or in a terminal on the Pi's desktop (Raspberry Pi Connect or VNC), not over plain SSH.
- **OCR** of scanned PDFs uses Windows OCR and is skipped on Linux.
- **Desktop notifications** go to the Pi's own desktop; use the webhook sink to reach a phone.

## Setup

```
git clone https://github.com/satomasahiro2005/unicontext ~/unicontext
cd ~/unicontext && pnpm install --frozen-lockfile && pnpm build
node apps/cli/dist/bin.js doctor
node apps/cli/dist/bin.js service install        # systemd user unit, restarts on failure
loginctl enable-linger "$USER"                   # keep it running without a login session
```

Data lives in `~/.local/share/unicontext`, the config in `~/.config/unicontext/config.yaml`.
To keep other work on the Pi (a 3D-printer host, for example) responsive, lower the daemon's
priority with a drop-in, `~/.config/systemd/user/unicontextd.service.d/pi.conf`:

```
[Service]
Environment=UNICONTEXT_SECRET_STORE=file
Nice=10
```

For the remote endpoint, run the same Cloudflare tunnel on the Pi (`cloudflared tunnel run
--token-file …` as a system service) and stop it on the PC: two connectors for one tunnel share
the traffic, and the one without a daemon answers 502.

## Using it from the PC

Set `UNICONTEXT_REMOTE` to the Pi's ssh destination on the PC and every `unicontext` command runs
on the Pi (`unicontext guest add`, `ai set-key`, `secrets set`, `status`, …), prompts included:

```
setx UNICONTEXT_REMOTE oppi@raspberrypi.local
```

The Pi needs a `unicontext` command on its PATH for non-interactive ssh, e.g. `/usr/local/bin/unicontext`
running `exec node ~/unicontext/apps/cli/dist/bin.js "$@"` (or set `UNICONTEXT_REMOTE_COMMAND`).
`login` is the exception: the browser opens on the PC, and afterwards the cookies of the browser
profiles the sign-in wrote to and the source's changed secrets are handed to the Pi (hidden
`import-login` command), which then syncs the source. `--dev`, `--data-dir` and `--config` keep a
command on the PC.

## Moving from a PC

Stop the PC's daemon first, then copy the data directory without the browser profiles (cookies
are encrypted per machine): the database (take it with SQLite's backup API, not a file copy of a
live database), `blobs`, `files`, `cache` minus `*/browser-profile`, `remote/` (keeps the OAuth
grants, so ChatGPT and claude.ai stay connected) and `notifications.jsonl`. Put the PC's secrets
into `secrets.json`, then either sign in again on the Pi or move the session cookies with
Playwright (`context.cookies()` on the PC profile, `context.addCookies()` into a fresh Pi profile).
Point local MCP clients at the Pi, e.g. `ssh pi@raspberrypi.local node ~/unicontext/apps/cli/dist/bin.js mcp`.
