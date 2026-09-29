# DESPACHO — the operator's desk in the dashboard

The *Despacho* ("desk" in Spanish) is the place in the dashboard where the operator handles what
needs a human: decisions to make, reports to read and what has already been decided. You open it by
clicking the ✉ desk in the COMMAND room of the office view. This file defines the contract: **what
makes something show up there**. The desk only reads live files of the org; nothing is wired by hand.

## Central rule

**Nobody "publishes to the Despacho". The org writes its normal files and the Despacho detects them.**
If something addressed to the operator does not show up, the file does not meet its contract — fix
the file, not the dashboard.

> The interface and the markers below are in Spanish (the current UI language): the heading is
> literally `## PUNTOS CLAVE` ("key points") and the decision line starts with `Decisión que se te
> pide:` ("decision asked of you").

## Zone PARA DECIDIR — everything waiting for a decision

| Live source | It appears when | What the operator does |
|---|---|---|
| `org/system/mandates/drafts/PNNN-*.md` | the draft has NOT been emitted (no `.emitted` suffix) | opens the draft and emits or vetoes it (the dashboard only lists it) |
| Docs with a `## PUNTOS CLAVE` block | the line "Decisión que se te pide:" is not "ninguna…" | whatever the block says |
| `org/founder/{decisiones,preguntas}/*.md` | `estado: abierto` | answers from the reader |
| `reports/outbox/*.{md,txt}` (root) | a brief not yet sent, whose ACCIÓN is not "ninguna — FYI" | the brief's ACCIÓN field |
| `missions/{inbox,processing}/*.md` | `status_calc: blocked-on-founder` (`espera_founder`) | answers the item that blocks it |

Empty state: "nada espera tu decisión hoy".

## Zone PARA LEER — reports with nothing pending

- `*.md` docs under `org/artifacts/` (recursive), `org/system/` and `reports/` (top level)
  **that contain a `## PUNTOS CLAVE` block** whose decision line says "ninguna…". Bullets are shown
  inline; the full doc opens in the reader (`/api/doc`).
- FYI briefs in transit (outbox root, ACCIÓN = "ninguna — FYI").
- `org/founder/briefs/*.md` with `estado: abierto`.

## Zone DECIDIDO — history of what was decided

- Entries of `org/DECISIONS.md` if the file exists (format `- date · who · decision · why`).
- Answered founder items (`estado: respondido`).
- The desk's own stamps (see Marks).

## Marks (read / decided) — the only state the desk owns

`org/founder/despacho-marcas.jsonl`, append-only, one JSON line per mark:
`{"ts": "<ISO>", "id": "<item id>", "marca": "leido"|"decidido", "ref": "<short free text>"}`

- Written by `POST /api/despacho/marcar` (same CSRF / rate-limit rules as the rest of the dashboard).
- The effective state of an item is its LAST mark; no mark = unread.
- A doc's `id` is its path relative to the repo; a draft's is its file name; a founder item's is its
  frontmatter `id`.

## Resource library

`GET /api/despacho/biblioteca` extracts every link (markdown and bare URLs) from `org/artifacts/**`,
`org/system/*.md`, `org/belts/*.md` and `catalog/**/*.md`, grouped by document, with the context
line. It has no state of its own: it is derived from the real docs.

## Endpoints (`org/dashboard/app.py`)

- `GET /api/despacho` — the three zones plus counts. It never crashes: partial state → "sin datos (...)".
- `GET /api/despacho/biblioteca` — resources per document.
- `POST /api/despacho/marcar` — append a mark (rejects ids that are not a current item).

## Behavior details

- **Default urgency** when the block or brief declares none: decide → "esta semana" (outbox alerts
  named `alerta-*` → "hoy"); read → "cuando puedas". Urgency orders the PARA DECIDIR pile.
- **Strict heading, lenient decision line**: the heading must be `##`/`###` + "PUNTOS CLAVE"
  (optionally followed by a parenthesis), case-insensitive. A heading with a suffix does not count,
  so docs that merely *talk about* the block do not show up as items. The decision line is lenient
  (with or without `**bold**`, even as a bullet), so a formatting slip cannot hide a pending decision.
- **Marking requires an existing id**, so future decisions cannot be pre-suppressed.
- **Caps** (anti-flooding): 60 resources per doc · 40 docs · top-10 domains · 80 DECIDIDO entries.

## Honest limits

1. The PUNTOS CLAVE scan is a **text convention**, not a registry: a doc without the block does not
   appear. That is deliberate — the contract is the interface.
2. The change stream (SSE) detects changes by the aggregated mtime of the watched directories; the
   cost grows with the number of artifacts (fine for a local, single-user dashboard).
3. `reports/outbox/` root is transient by design: a brief can appear and disappear within seconds when
   something (for example the optional Telegram bridge) picks it up.
4. The squad/mission attribution in the library is a heuristic (the doc header); a doc without a
   header is attributed to "org".
