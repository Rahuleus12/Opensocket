# Connecting to your daemon

OpenSocket's transport is **your infrastructure** (a deliberate project
decision): the daemon is a plain HTTP + WebSocket server with token auth.
Reachability — LAN, Tailscale, SSH, or a hosted box — is whatever you already
run. This page is the recipe collection; no VPN code ships with the project.

In every setup the flow is the same:

1. Start `opensocketd` on the always-on host.
2. It prints a **pairing code** (6 words, single-use, 10 min) to the console.
3. On the phone/browser, open the UI and choose **Pair** (or POST `/api/pair`)
   — you get a per-device token that you can revoke from any paired device.
4. The client talks HTTP + WebSocket (`/ws`, `GET /sse/<id>` fallback).

Auth notes that apply everywhere:

- Tokens are per device, stored hashed, revocable (`GET /api/device`,
  `POST /api/device/:id/revoke`).
- `DAEMON_TOKEN` (a shared secret) still works as the dev-only quick start —
  do not use it across untrusted networks.
- WebSocket auth is the first message (`{"type":"hello","payload":{"token":…}}`),
  so tokens never appear in URLs or server logs.
- Optional second signal: if a reverse proxy injects identity headers (e.g.
  Tailscale WhoIS), set `OPENSOCKET_IDENTITY_HEADERS=tailscale-user-login`
  and, if you want enforcement, `OPENSOCKET_IDENTITY_ENFORCE=1`.

---

## 1. LAN (quick, same trust domain)

```sh
opensocketd   # binds 127.0.0.1 by default; to expose on LAN:
PORT=8097 HOST=0.0.0.0 node apps/daemon/src/index.ts
```

Then on the phone: `http://<host-lan-ip>:8097` → pair with the console code.

**Warnings:** plain HTTP means the (already random, high-entropy) device token
crosses the wire unencrypted. Fine at home; do not do this on coffee-shop Wi-Fi.
Pairing codes are short-lived and single-use, so a sniffer cannot replay them.

## 2. Tailscale (recommended)

Install Tailscale on host + phone, then front the daemon with `tailscale serve`
(gets you TLS + WhoIS identity for free):

```sh
# on the host (daemon listening on 127.0.0.1:8097)
tailscale serve --bg --https=443 http://127.0.0.1:8097
```

On the phone: `https://<host>.<tailnet>.ts.net` → pair.

Optional hardening — bind the device to the tailnet identity:

```sh
OPENSOCKET_IDENTITY_HEADERS=tailscale-user-login \
OPENSOCKET_IDENTITY_ENFORCE=1 \
node apps/daemon/src/index.ts
```

`tailscale serve` forwards `Tailscale-User-Login` (the requester's email) once
you enable it in the serve config; the daemon records it at pair time and
cross-checks it on later requests. Identity is a second signal — the device
token remains required either way.

## 3. SSH tunnel (zero new infrastructure)

From the laptop:

```sh
ssh -N -L 8097:127.0.0.1:8097 user@host
# then open http://localhost:8097 locally
```

From a phone over SSH is clunky; use it for laptops or as the zero-client
escape hatch. Bonus: every session also renders a plain-text log —
`ssh host -- tail -f ~/.opensocket/sessions/<id>/session.log`-style access
works with no client at all once `session.log` generation lands (PLAN §4.6).

## 4. Hosted VPS + TLS reverse proxy

For "my always-on machine is rented" — run the daemon behind Caddy or nginx
with a real certificate. The daemon itself never does TLS.

**Caddy** (automatic certs):

```caddyfile
socket.example.com {
    reverse_proxy 127.0.0.1:8097
}
```

**nginx** (certbot certs, WebSocket-aware):

```nginx
server {
    server_name socket.example.com;
    listen 443 ssl;
    ssl_certificate     /etc/letsencrypt/live/socket.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/socket.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8097;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;                 # long-lived SSE/WS
        proxy_buffering off;                      # stream events immediately
    }
}
```

Run the daemon under systemd so it survives reboots:
see [`opensocketd.service`](./opensocketd.service) in this directory.

```sh
sudo cp opensocketd.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now opensocketd
journalctl -u opensocketd -f        # pairing codes land here
```

## Ports & environment

| Var | Default | Notes |
|---|---|---|
| `PORT` | 8097 | daemon listen port |
| `DAEMON_TOKEN` | _(unset)_ | shared dev secret (skip: use pairing) |
| `OPENSOCKET_DATA` | `~/.opensocket` | JSONL sessions + devices.json |
| `OPENSOCKET_IDENTITY_HEADERS` | _(unset)_ | proxy identity headers to record |
| `OPENSOCKET_IDENTITY_ENFORCE` | `0` | require identity match on requests |

## Security checklist

- [ ] Pair on first boot; revoke the code path by rotating if a device is lost
      (`POST /api/device/:id/revoke` from any surviving device).
- [ ] Prefer TLS fronting (Tailscale serve or a reverse proxy) on any network
      you don't fully control.
- [ ] Keep `DAEMON_TOKEN` unset in production-ish setups so every client is a
      listed, revocable device.
- [ ] Model keys (`OPENROUTER_API_KEY` etc.) live in `.env` on the host and
      never cross the wire (R5); clients only ever see opaque model ids.
