# Mission Control — the dashboard

A local web dashboard that **mirrors the state of a multi-agent operations folder** (squads, missions,
reports, events) and gives one operator a place to decide. It is a navigable pixel office (top-down,
procedural canvas) plus panels. The interface text is **in Spanish**.

## Run it

```bash
pip install -r requirements.txt        # from the repo root
python3 org/dashboard/app.py           # → http://localhost:8787
```

It listens only on `127.0.0.1`. Environment variables (all optional, see `.env.example`):
`DASHBOARD_PORT`, `DASHBOARD_USER_ID`, `DASHBOARD_OPERATOR_NAME`, `DASHBOARD_ALLOWED_HOSTS`, `PUPPET_ROOT`.

## What it reads

| Source | Used for |
|---|---|
| `org/dashboard/squads.json` | the squads: name, division, regime, seats (3 example squads ship with the repo) |
| `missions/{inbox,processing,completed}/*.md` | missions (YAML front-matter) and their computed status |
| `.claude/agents/*.md`, `.mcp.json`, `org/belts/*.md` | agents and the tool catalog (armory) |
| `org/events/events.jsonl`, `org/state/agents.json` | events and agent state |
| `reports/usage.log`, `reports/security.log`, `reports/outbox/` | activity feed, alerts, outgoing reports |
| `org/founder/`, `org/artifacts/`, `org/system/` | the Despacho (see `org/system/DESPACHO.md`) |

If a file is missing or does not parse, the dashboard shows `sin datos` and carries on; it never
crashes on partial state.

## What it writes (exhaustive)

The dashboard never edits or deletes existing files. It only:

1. `POST /api/intake` — creates a **new** mission draft in `missions/inbox/` (a message starting with
   `mision:` / `misión:` / `/mision`; anything else is chat with no effect).
2. `POST /api/command` — creates a **new** command draft in `missions/inbox/commands/`. Something of
   your own has to read and apply those drafts; nothing in this repo does.
3. `POST /api/firealarm` (needs the alarm token) — creates `org/PAUSED` if it does not exist, appends a
   `pausa_org` event and writes a new alert in `reports/outbox/`. There is no un-pause endpoint:
   delete `org/PAUSED` by hand. Your own orchestrator has to honor that file.
4. Startup — creates `org/dashboard/.alarm-token` (mode 0600) only if it does not exist. It is git-ignored.
5. Appends to `reports/security.log` on rejected requests (403 / rate limit).
6. `POST /api/despacho/marcar` — appends a read/decided mark to `org/founder/despacho-marcas.jsonl`.

## The views

Office (pixel canvas with the squads as desks) · War room · Armory (agent tools) · Library ·
Pipeline (kanban) · Channel (feed + mission composer) · Squads · Status · and the **Despacho**
(the ✉ desk in the COMMAND room).

## Security model

- Listens on `127.0.0.1` only, and **rejects any request whose `Host` header is not loopback**
  (protects the GET endpoints from DNS-rebinding). Add hosts with `DASHBOARD_ALLOWED_HOSTS`.
- Every POST requires `Content-Type: application/json` and an absent or loopback `Origin`.
- Rate limits on `/api/command`, `/api/firealarm` and the Despacho marks.
- Reading documents (`/api/doc`) is restricted to `.md` files under an allow-list of folders.

## Tests

```bash
python3 -m pytest org/dashboard/tests
```

The tests build a temporary tree with real fixture files; they never touch a live org.

## Known limits

- A mission whose front-matter does not parse appears as `⚠ sin datos`; the dashboard does not fix it.
- The drawing loop pauses when the office view is not active or the tab is hidden; data keeps polling.
