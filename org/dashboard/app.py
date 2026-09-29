#!/usr/bin/env python3
"""Puppet AI — MISSION CONTROL v3 (oficina viva, ver README.md).

Dashboard local del org. Lee missions/, reports/, org/ y squads.json; JAMÁS edita,
pisa ni borra archivos existentes. Escrituras EXHAUSTIVAS (SPEC §0.2):
  (a) POST /api/intake   → archivo NUEVO en missions/inbox/ (contrato v2 intacto)
  (b) POST /api/command  → archivo NUEVO en missions/inbox/commands/
  (c-e) POST /api/firealarm OK → org/PAUSED (si no existe) + 1 línea pausa_org en
        org/events/events.jsonl + archivo NUEVO reports/outbox/alerta-pausa-<ts>.txt
  (f) arranque → org/dashboard/.alarm-token SOLO si no existe (chmod 600)
  (g) append a reports/security.log en 403/rate-limit de firealarm y command
  (h) POST /api/despacho/marcar → append 1 línea a org/founder/despacho-marcas.jsonl
      (marcas leído/decidido del Despacho — contrato org/system/DESPACHO.md)

Regla de oro: ningún endpoint crashea por estado parcial del org — dato inexistente
→ "sin datos" literal, jamás inventar. SCHEDULER-V2 no existe → latencia_media e
intentos son SIEMPRE null.

Anti-CSRF (§0.6): los POST exigen Content-Type application/json Y Origin ausente o
localhost/127.0.0.1. El user_id sellado identifica el CANAL del draft, NO es prueba
de origen (cualquier proceso local puede llamar al server; el canal dice "vino por
el dashboard local", nada más).

ROOT: env PUPPET_ROOT (tests/smoke) o derivado de __file__ como v2.
Correr:  python3 org/dashboard/app.py   →   http://localhost:8787
Dependencias: fastapi + uvicorn + pyyaml (stdlib para el resto).
"""

import asyncio
import json
import math
import os
import re
import secrets
import time
import unicodedata
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import uvicorn
import yaml
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

HERE = Path(__file__).resolve().parent          # org/dashboard (código)
_env_root = os.environ.get("PUPPET_ROOT", "").strip()
ROOT = Path(_env_root).resolve() if _env_root else HERE.parent.parent

MISSIONS_DIR = ROOT / "missions"
REPORTS_DIR = ROOT / "reports"
STATIC_DIR = ROOT / "org" / "dashboard" / "static"
SQUADS_JSON = ROOT / "org" / "dashboard" / "squads.json"
AGENTS_DIR = ROOT / ".claude" / "agents"
FOUNDER_DIR = ROOT / "org" / "founder"
EVENTS_PATH = ROOT / "org" / "events" / "events.jsonl"
STATE_AGENTES = ROOT / "org" / "state" / "agents.json"
PAUSED_PATH = ROOT / "org" / "PAUSED"
MCP_JSON = ROOT / ".mcp.json"
BELTS_DIR = ROOT / "org" / "belts"
ARTIFACTS_DIR = ROOT / "org" / "artifacts"
COMMANDS_DIR = MISSIONS_DIR / "inbox" / "commands"
OUTBOX_DIR = REPORTS_DIR / "outbox"
SECURITY_LOG = REPORTS_DIR / "security.log"
USAGE_LOG = REPORTS_DIR / "usage.log"
TOKEN_PATH = ROOT / "org" / "dashboard" / ".alarm-token"
CARPETAS = ("inbox", "processing", "completed")
FOUNDER_SUBDIRS = ("briefs", "preguntas", "decisiones")
# despacho del founder (contrato org/system/DESPACHO.md)
SYSTEM_DIR = ROOT / "org" / "system"
DRAFTS_DIR = SYSTEM_DIR / "mandates" / "drafts"
DECISIONS_PATH = ROOT / "org" / "DECISIONS.md"
CATALOG_DIR = ROOT / "catalog"
DESPACHO_MARCAS = FOUNDER_DIR / "despacho-marcas.jsonl"

USER_ID = os.environ.get("DASHBOARD_USER_ID", "operator")
OPERATOR_NAME = os.environ.get("DASHBOARD_OPERATOR_NAME", "Operator")


def _es_operador(quien) -> bool:
    """¿Esta entrada del libro de decisiones es del operador? (para destacarla en el front)"""
    q = str(quien or "").strip().lower()
    return bool(q) and q in {OPERATOR_NAME.lower(), USER_ID.lower(), "operator"}

# Tabla alias→tier — ÚNICA fuente (SPEC §3); desconocido → oss + flag "(alias)"
ALIAS_TIER = {
    "fable": "fable", "opus": "opus", "sonnet": "sonnet",
    "specialist": "oss", "premium": "oss",
    "constructor-code": "oss", "explorer-reason": "oss",
}

NOMBRE_RE = re.compile(r"^[a-zA-Z0-9._-]+$")
FOUNDER_ID_RE = re.compile(r"^[a-z0-9-]+$")
# prefijos permitidos de /api/doc (SPEC §3) — sobre la ruta YA resuelta bajo ROOT
# (org/system/ y catalog/ sumados por el Despacho: docs founder-facing y belts)
DOC_PREFIJOS = ("org/artifacts/", "org/founder/", "reports/", "org/belts/", "missions/",
                "org/system/", "catalog/")

app = FastAPI(title="Puppet AI — Mission Control", docs_url=None, redoc_url=None, openapi_url=None)
# check_dir=False: el árbol puede no tener static aún (fixture vacío) — no crashear
app.mount("/static", StaticFiles(directory=str(STATIC_DIR), check_dir=False), name="static")


# ---------- validación del header Host (anti DNS-rebinding) ----------
# El server escucha solo en 127.0.0.1, pero un sitio web malicioso puede hacer que su dominio
# resuelva a 127.0.0.1 y leer desde el navegador las respuestas GET (docs, founder, state).
# Ese ataque llega con Host = <dominio del atacante>; se rechaza TODO request cuyo Host no sea
# loopback. Hosts extra (p.ej. un túnel propio): DASHBOARD_ALLOWED_HOSTS="a.example,b.example".
_HOSTS_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def _hosts_permitidos() -> set:
    extra = {h.strip().lower() for h in os.environ.get("DASHBOARD_ALLOWED_HOSTS", "").split(",") if h.strip()}
    return _HOSTS_LOOPBACK | extra


@app.middleware("http")
async def validar_host(request: Request, call_next):
    raw = (request.headers.get("host") or "").strip().lower()
    try:
        hostname = urlparse("//" + raw).hostname or ""
    except ValueError:
        hostname = ""
    if hostname not in _hosts_permitidos():
        append_security("HOST_RECHAZADO", f"host={raw[:120]} path={request.url.path[:80]}")
        return JSONResponse({"ok": False, "hint": "Host no permitido (solo localhost)"}, status_code=403)
    return await call_next(request)


# ---------- helpers defensivos (nunca lanzan) ----------

def leer_texto(path: Path):
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def mtime_de(path: Path) -> float:
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def agregado_nivel1(d: Path):
    """(max mtime, n) de TODOS los archivos directos de un dir (sin recursión).
    Para vigilar system/, reports/ y outbox/ sin pagar el rglob de sus subdirs."""
    total, n = 0.0, 0
    if d.is_dir():
        try:
            for p in d.iterdir():
                if p.is_file():
                    total = max(total, mtime_de(p))
                    n += 1
        except OSError:
            pass
    return (total, n)


def ts_transicion(path: Path) -> float:
    """ts del evento de transición: max(mtime, ctime). `mv` preserva mtime pero
    actualiza ctime, así el feed sí ve en vivo el move inbox→processing→completed."""
    try:
        st = path.stat()
        return max(st.st_mtime, st.st_ctime)
    except OSError:
        return 0.0


def frontmatter(path: Path):
    """(dict | None, body). None si el YAML falta o no parsea. Nunca lanza."""
    text = leer_texto(path)
    if text is None:
        return None, ""
    m = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.S)
    if not m:
        return None, text
    body = text[m.end():]
    try:
        data = yaml.safe_load(m.group(1))
    except Exception:
        # no solo YAMLError: PyYAML lanza ValueError crudo con fechas fuera de rango
        return None, body
    return (data if isinstance(data, dict) else None), body


def parse_ts_iso(s):
    try:
        return datetime.fromisoformat(str(s).strip().replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def short_id(mid: str) -> str:
    mid = str(mid)
    m = re.search(r"-(m\d{3})-", f"-{mid}-")
    if m:
        return m.group(1).upper()
    parts = mid.split("-")
    return parts[3] if len(parts) >= 4 else mid


def titulo_de(body: str, fm: dict) -> str:
    for line in (body or "").splitlines():
        s = line.strip().lstrip("#").strip()
        if s:
            return s[:120]
    spec = str((fm or {}).get("spec") or "")
    return spec[:120] or "(sin título)"


def norm(s) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(s or "").lower())


def squad_match(sq: dict, valor) -> bool:
    """¿`valor` (campo squad de una misión, o nombre de agente) pertenece a este squad?"""
    v = norm(valor)
    if not v:
        return False
    tokens = set(re.split(r"[^a-z0-9]+", str(valor or "").lower())) - {""}
    for cand in [sq.get("slug", "")] + list(sq.get("aliases") or []):
        c = norm(cand)
        if not c:
            continue
        if v == c or str(cand).lower() in tokens or (len(c) >= 6 and c in v):
            return True
    return False


def lista_str(valor):
    """Normaliza un campo YAML a lista de strings (acepta escalar o lista)."""
    if valor is None:
        return []
    if not isinstance(valor, list):
        valor = [valor]
    return [str(x) for x in valor if x is not None and str(x).strip()]


def append_linea(path: Path, linea: str):
    """Append atómico por convención §2.2: UNA línea completa en UN write() con \\n."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if not linea.endswith("\n"):
            linea += "\n"
        with open(path, "a", encoding="utf-8") as f:
            f.write(linea)
    except OSError:
        pass


def append_security(tag: str, detalle: str):
    append_linea(SECURITY_LOG, f"{now_iso()}\t{tag}\t{detalle}")


def append_evento(ev: dict):
    ev = {"ts": now_iso(), **ev}
    append_linea(EVENTS_PATH, json.dumps(ev, ensure_ascii=False))


def leer_eventos():
    """events.jsonl parseado; ignora la última línea si no termina en \\n (§2.2)."""
    text = leer_texto(EVENTS_PATH)
    if not text:
        return []
    if not text.endswith("\n"):
        text = text[:text.rfind("\n") + 1] if "\n" in text else ""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(ev, dict):
            out.append(ev)
    return out


def tier_de_alias(alias):
    """(tier, alias_desconocido) según la tabla única. None → (None, False)."""
    if not alias:
        return None, False
    a = str(alias).strip().lower()
    if a in ALIAS_TIER:
        return ALIAS_TIER[a], False
    return "oss", True  # desconocido → oss con flag "(alias)"


def asegurar_alarm_token():
    """Escritura (f): genera .alarm-token SOLO si no existe (chmod 600)."""
    try:
        if not TOKEN_PATH.exists():
            TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
            TOKEN_PATH.write_text(secrets.token_urlsafe(32), encoding="utf-8")
            TOKEN_PATH.chmod(0o600)
    except OSError:
        pass


asegurar_alarm_token()


# ---------- carga de datos (solo lectura) ----------

def cargar_squads_static():
    text = leer_texto(SQUADS_JSON)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, list):
        return None
    return [x for x in data if isinstance(x, dict)]


def squad_de(nombre, squads):
    for sq in squads or []:
        if squad_match(sq, nombre):
            return sq.get("slug")
    return None


def _fm_regex_agente(path: Path):
    """Fallback regex (regex simple sobre el frontmatter): los frontmatter de agentes
    traen ': ' sin comillas en description y PyYAML los rechaza entero — acá no se
    pierde el agente por eso."""
    text = leer_texto(path) or ""
    m = re.match(r"^---\n(.*?)\n---", text, re.S)
    if not m:
        return None
    fm = m.group(1)

    def listfield(name):
        mm = re.search(rf"^{name}:\s*\[(.*?)\]", fm, re.M | re.S)
        return [x.strip() for x in mm.group(1).split(",") if x.strip()] if mm else []

    def scalar(name):
        mm = re.search(rf"^{name}:\s*([^\n#]+)", fm, re.M)
        return mm.group(1).strip() if mm else None

    return {"name": scalar("name"), "tools": listfield("tools"), "skills": listfield("skills"),
            "model_gateway": scalar("model_gateway"), "model_native": scalar("model_native")}


def cargar_agentes_md():
    """{nombre: {tools, skills, model_gateway, model_native}} de .claude/agents/*.md."""
    out = {}
    if not AGENTS_DIR.is_dir():
        return out
    for p in sorted(AGENTS_DIR.glob("*.md")):
        fm, _ = frontmatter(p)
        if not isinstance(fm, dict):
            rx = _fm_regex_agente(p)
            if rx is None:
                continue
            out[str(rx["name"] or p.stem)] = {
                "tools": rx["tools"], "skills": rx["skills"],
                "model_gateway": rx["model_gateway"], "model_native": rx["model_native"],
            }
            continue
        nombre = str(fm.get("name") or p.stem)
        out[nombre] = {
            "tools": lista_str(fm.get("tools")),
            "skills": lista_str(fm.get("skills")),
            "model_gateway": fm.get("model_gateway"),
            "model_native": fm.get("model_native"),
        }
    return out


def cargar_estado_agentes():
    """org/state/agents.json (lo escribe tu orquestador; acá solo lectura)."""
    text = leer_texto(STATE_AGENTES)
    if text is None:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return data if isinstance(data, dict) else {}


def cargar_founder_items():
    """Items de org/founder/{briefs,preguntas,decisiones}/*.md (defensivo)."""
    items = []
    for sub in FOUNDER_SUBDIRS:
        d = FOUNDER_DIR / sub
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.md")):
            fm, body = frontmatter(p)
            fm = fm or {}
            items.append({
                "id": str(fm.get("id") or p.stem),
                "tipo": fm.get("tipo") or sub.rstrip("s"),
                "squad": fm.get("squad"),
                "mision": str(fm.get("mision")) if fm.get("mision") else None,
                "ts": str(fm.get("ts")) if fm.get("ts") else None,
                "titulo": str(fm.get("titulo") or titulo_de(body, fm)),
                "estado": fm.get("estado") or "sin datos",
                "default": fm.get("default"),
                "doc": str(fm.get("doc")) if fm.get("doc") else None,
                "carpeta": sub,
                "mtime": mtime_de(p),
            })
    return items


def buscar_founder_item(item_id):
    """(path, fm, body) del item founder, o (None, None, None)."""
    for sub in FOUNDER_SUBDIRS:
        p = FOUNDER_DIR / sub / f"{item_id}.md"
        if p.is_file():
            fm, body = frontmatter(p)
            return p, (fm or {}), body
    return None, None, None


def _en_ciclo(start, graph):
    """True si `start` se alcanza a sí misma vía depends_on (auto-dep o ciclo)."""
    visited = set()
    stack = list(graph.get(start, []))
    while stack:
        n = stack.pop()
        if n == start:
            return True
        if n in visited:
            continue
        visited.add(n)
        stack.extend(graph.get(n, []))
    return False


def cargar_misiones():
    """Misiones de las 3 carpetas con status_calc según la TABLA NORMATIVA §2.6.
    Conserva todos los campos del contrato v2 y agrega agentes/espera_founder."""
    crudas = []
    for carpeta in CARPETAS:
        d = MISSIONS_DIR / carpeta
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.md")):
            fm, body = frontmatter(p)
            crudas.append((carpeta, p, fm, body))

    all_ids, completed_ids = set(), set()
    for carpeta, p, fm, _ in crudas:
        mid = str((fm or {}).get("id") or p.stem)
        all_ids.add(mid)
        if carpeta == "completed":
            completed_ids.add(mid)

    # grafo solo con edges hacia ids que EXISTEN (inexistente = roto, no edge)
    graph = {}
    for carpeta, p, fm, _ in crudas:
        mid = str((fm or {}).get("id") or p.stem)
        deps = lista_str((fm or {}).get("depends_on"))
        graph[mid] = [d for d in deps if d in all_ids]

    misiones = []
    for carpeta, p, fm, body in crudas:
        mtime = mtime_de(p)
        if fm is None:
            misiones.append({
                "id": p.stem, "id_corto": short_id(p.stem), "squad": None,
                "tipo": None, "lane": None, "depends_on": [], "espera_a": [],
                "status": None,
                "status_calc": "completed" if carpeta == "completed"
                               else ("processing" if carpeta == "processing" else "sin-datos"),
                "artifact": None, "titulo": p.name, "spec": "",
                "carpeta": carpeta, "mtime": mtime, "ts_evento": ts_transicion(p),
                "agente": None, "agentes": [], "espera_founder": None, "en_ciclo": False,
                "error": "sin datos (front-matter ausente o no parsea)",
            })
            continue
        mid = str(fm.get("id") or p.stem)
        deps = lista_str(fm.get("depends_on"))
        espera = [x for x in deps if x not in completed_ids]
        espera_founder = str(fm.get("espera_founder")) if fm.get("espera_founder") else None
        en_ciclo = _en_ciclo(mid, graph)

        # TABLA NORMATIVA §2.6 — condiciones EN ORDEN
        if carpeta == "completed":
            status_calc = "completed"
        else:
            item_path = None
            item_fm = {}
            if espera_founder:
                item_path, item_fm, _ = buscar_founder_item(espera_founder)
            if espera_founder and item_path is None:
                status_calc = "founder-roto"
            elif espera_founder and (item_fm or {}).get("estado") == "abierto":
                status_calc = "blocked-on-founder"      # aplica en inbox Y processing
            elif carpeta == "processing":
                status_calc = "processing"
            elif any(d not in all_ids for d in deps):
                status_calc = "roto"
            elif en_ciclo:
                status_calc = "ciclo"
            elif espera:
                status_calc = "blocked"
            else:
                status_calc = "ready"

        misiones.append({
            "id": mid, "id_corto": short_id(mid),
            "squad": str(fm.get("squad")) if fm.get("squad") else None,
            "tipo": fm.get("tipo"), "lane": fm.get("lane"),
            "depends_on": deps, "espera_a": espera,
            "status": fm.get("status"), "status_calc": status_calc,
            "artifact": fm.get("artifact"),
            "titulo": titulo_de(body, fm),
            "spec": str(fm.get("spec") or "")[:300],
            "carpeta": carpeta, "mtime": mtime, "ts_evento": ts_transicion(p),
            "agente": fm.get("agente"),
            "agentes": lista_str(fm.get("agentes")),
            "espera_founder": espera_founder,
            "en_ciclo": en_ciclo,
            "error": None,
        })
    return misiones


def eventos_feed():
    """Feed cronológico v2: reportes + actividad + alertas + misiones (intacto)."""
    evs = []
    squads = cargar_squads_static() or []

    sent = REPORTS_DIR / "outbox" / "sent"
    if sent.is_dir():
        for p in sorted(sent.iterdir()):
            if not p.is_file() or p.name.startswith("."):
                continue
            txt = leer_texto(p) or ""
            primera = next((ln.strip() for ln in txt.splitlines() if ln.strip()), "")
            texto = f"{p.stem}: {primera[:160]}" if primera else p.stem
            evs.append({"ts": mtime_de(p), "tipo": "reporte", "squad": None, "texto": texto})

    ulog = leer_texto(USAGE_LOG)
    if ulog:
        for line in ulog.splitlines():
            parts = [x for x in line.split("\t") if x]
            if not parts:
                continue
            ts = parse_ts_iso(parts[0])
            if ts is None:
                continue
            agente = parts[1] if len(parts) > 1 else "?"
            alias = parts[2] if len(parts) > 2 else "?"
            tokens = " ".join(parts[3:]) or "tokens s/d"
            evs.append({"ts": ts, "tipo": "actividad", "squad": squad_de(agente, squads),
                        "texto": f"{agente} corrió {alias} ({tokens})"})

    slog = leer_texto(SECURITY_LOG)
    if slog:
        for line in slog.splitlines():
            parts = [x for x in line.split("\t") if x]
            if not parts:
                continue
            ts = parse_ts_iso(parts[0])
            if ts is None:
                continue
            evs.append({"ts": ts, "tipo": "alerta", "squad": "security",
                        "texto": " · ".join(parts[1:])[:200] or "evento de seguridad"})

    nombres = {"inbox": "entró a inbox", "processing": "en processing", "completed": "completada"}
    for m in cargar_misiones():
        texto = f"misión {m['id_corto']} {nombres.get(m['carpeta'], m['carpeta'])} · {m['titulo'][:80]}"
        evs.append({"ts": m.get("ts_evento") or m["mtime"], "tipo": "mision",
                    "squad": squad_de(m.get("squad"), squads), "texto": texto,
                    "mision": m["id"], "carpeta": m["carpeta"]})

    evs.sort(key=lambda e: e["ts"])
    return evs


# ---------- CSRF + rate-limit (SPEC §0.6 + §3) ----------

RATE_MAX = {"command": (30, 60.0), "firealarm": (5, 60.0), "despacho": (120, 60.0)}
RATE_BUCKETS = {k: deque() for k in RATE_MAX}


def chequear_csrf(request: Request, endpoint: str):
    """None si pasa; JSONResponse 403 (+security.log) si no. El user_id sellado
    identifica el canal, NO es prueba de origen — este header-check es el control."""
    ct = (request.headers.get("content-type") or "").lower()
    if not ct.startswith("application/json"):
        append_security("CSRF_RECHAZADO", f"endpoint={endpoint} content-type={ct or '(vacio)'}")
        return JSONResponse({"ok": False, "hint": "se exige Content-Type: application/json"}, status_code=403)
    origin = request.headers.get("origin")
    if origin:
        try:
            host = urlparse(origin).hostname or ""
        except ValueError:
            host = ""
        if host not in ("localhost", "127.0.0.1"):
            append_security("CSRF_RECHAZADO", f"endpoint={endpoint} origin={origin[:120]}")
            return JSONResponse({"ok": False, "hint": "Origin no permitido (solo localhost)"}, status_code=403)
    return None


def rate_excedido(clave: str, endpoint: str):
    """None si pasa; JSONResponse 429 (+security.log) si excede la ventana."""
    n_max, ventana = RATE_MAX[clave]
    dq = RATE_BUCKETS[clave]
    ahora = time.monotonic()
    while dq and ahora - dq[0] > ventana:
        dq.popleft()
    if len(dq) >= n_max:
        append_security("RATE_LIMIT", f"endpoint={endpoint} max={n_max}/min")
        return JSONResponse({"ok": False, "hint": f"rate-limit: máx {n_max}/min"}, status_code=429)
    dq.append(ahora)
    return None

# ---------- endpoints v2 (contratos intactos) ----------

@app.get("/api/squads")
def api_squads():
    estaticos = cargar_squads_static()
    if estaticos is None:
        return {"squads": [], "total": 0,
                "error": "sin datos (org/dashboard/squads.json ausente o no parsea)"}
    procesando = [m for m in cargar_misiones() if m["carpeta"] == "processing"]
    out = []
    for sq in estaticos:
        if not isinstance(sq, dict):
            continue
        mias = [m for m in procesando if squad_match(sq, m.get("squad"))]
        item = dict(sq)
        item["estado"] = "working" if mias else sq.get("regimen", "frio")
        item["misiones_processing"] = [m["id"] for m in mias]
        item["mision_activa"] = ({"id": mias[0]["id"], "id_corto": mias[0]["id_corto"],
                                  "titulo": mias[0]["titulo"]} if mias else None)
        out.append(item)
    return {"squads": out, "total": len(out), "error": None}


@app.get("/api/missions")
def api_missions():
    misiones = cargar_misiones()
    error = None if MISSIONS_DIR.is_dir() else "sin datos (missions/ no existe)"
    return {"missions": misiones, "total": len(misiones), "error": error}


@app.get("/api/feed")
def api_feed(since: str = "0"):
    try:
        since_f = float(since)
    except (ValueError, TypeError):
        since_f = 0.0
    if not math.isfinite(since_f):
        since_f = 0.0
    corte = since_f - 1.0 if since_f > 0 else since_f
    evs = [e for e in eventos_feed() if e["ts"] > corte]
    evs = evs[:200]
    for e in evs:
        try:
            e["iso"] = datetime.fromtimestamp(e["ts"]).isoformat(timespec="seconds")
        except (OSError, OverflowError, ValueError):
            e["iso"] = ""
    return {"eventos": evs, "total": len(evs),
            "ultimo_ts": evs[-1]["ts"] if evs else since_f}


@app.get("/")
def index():
    f = STATIC_DIR / "index.html"
    if f.is_file():
        return FileResponse(f)
    return JSONResponse({"error": "sin datos (static/index.html ausente)"})


# ---------- /api/agents — el join (SPEC §3) ----------

def _stats_usage_por_agente():
    """usage.log → {agente: {runs, tokens_in, tokens_out, ultima_actividad}}."""
    out = {}
    ulog = leer_texto(USAGE_LOG)
    if not ulog:
        return out
    for line in ulog.splitlines():
        parts = [x for x in line.split("\t") if x]
        if len(parts) < 2:
            continue
        ts = parse_ts_iso(parts[0])
        if ts is None:
            continue
        ag = parts[1]
        st = out.setdefault(ag, {"runs": 0, "tokens_in": 0, "tokens_out": 0, "_ts": 0.0})
        st["runs"] += 1
        for tok in parts[3:]:
            m = re.match(r"^(in|out)=(\d+)$", tok.strip())
            if m:
                st["tokens_" + m.group(1)] += int(m.group(2))
        st["_ts"] = max(st["_ts"], ts)
    for st in out.values():
        try:
            st["ultima_actividad"] = datetime.fromtimestamp(st.pop("_ts")).isoformat(timespec="seconds")
        except (OSError, OverflowError, ValueError):
            st["ultima_actividad"] = None
    return out


def _agente_en_mision(nombre, m):
    return m.get("agente") == nombre or nombre in (m.get("agentes") or [])


def construir_agentes():
    """Join: squads.json(agente:) ⋈ frontmatter ⋈ usage.log ⋈ missions ⋈
    org/state/agents.json ⋈ events. Defensivo por pieza ("sin datos" = null)."""
    squads = cargar_squads_static() or []
    fms = cargar_agentes_md()
    estado_json = cargar_estado_agentes()
    usage = _stats_usage_por_agente()
    misiones = cargar_misiones()
    eventos = leer_eventos()
    procesando = [m for m in misiones if m["carpeta"] == "processing"]
    completadas = [m for m in misiones if m["carpeta"] == "completed"]

    verdictos = {}
    for ev in eventos:
        if ev.get("tipo") == "review_verdict" and ev.get("agente"):
            v = verdictos.setdefault(str(ev["agente"]), {"aprobados": 0, "rechazados": 0})
            if ev.get("verdict") == "aprobado":
                v["aprobados"] += 1
            elif ev.get("verdict") == "rechazado":
                v["rechazados"] += 1

    agentes = []
    for sq in squads:
        slug = sq.get("slug")
        for asiento in (sq.get("asientos") or []):
            if not isinstance(asiento, dict):
                continue
            nombre = asiento.get("agente")
            if not nombre:
                continue  # Supervisor / asiento sin archivo real → null (lo valida ORG)
            nombre = str(nombre)
            fm = fms.get(nombre)
            compartido = bool(asiento.get("compartido")) or nombre in ("squad-lead", "reviewer")
            st = estado_json.get(nombre) if isinstance(estado_json.get(nombre), dict) else {}
            model_override = st.get("model_override")
            estado_agente = st.get("estado") or "activo"

            alias_efectivo = model_override or (fm or {}).get("model_native") or (fm or {}).get("model_gateway")
            tier, alias_desconocido = tier_de_alias(alias_efectivo)
            if tier is None:
                tier = asiento.get("tier") or "sin datos"

            # compartidos: stats org-wide (mismo agente real en varios asientos)
            u = usage.get(nombre, {})
            n_comp = sum(1 for m in completadas if _agente_en_mision(nombre, m))
            v = verdictos.get(nombre, {"aprobados": 0, "rechazados": 0})
            total_v = v["aprobados"] + v["rechazados"]
            xp = 10 * n_comp + 5 * v["aprobados"]
            mision_act = next((m for m in procesando if _agente_en_mision(nombre, m)), None)

            agentes.append({
                "agente": nombre,
                "squad": slug,
                "rol": asiento.get("rol"),
                "compartido": compartido,
                "tier": tier,
                "tier_alias_desconocido": alias_desconocido,  # front: flag "(alias)"
                "modelo": alias_efectivo or asiento.get("modelo") or "sin datos",
                "model_override": model_override,
                "estado_agente": estado_agente,
                "tools": (fm or {}).get("tools") if fm else None,
                "skills": (fm or {}).get("skills") if fm else None,
                "mision_actual": ({"id": mision_act["id"], "id_corto": mision_act["id_corto"],
                                   "titulo": mision_act["titulo"], "squad": mision_act["squad"]}
                                  if mision_act else None),
                "stats": {
                    "runs": u.get("runs", 0),
                    "tokens_in": u.get("tokens_in", 0),
                    "tokens_out": u.get("tokens_out", 0),
                    "ultima_actividad": u.get("ultima_actividad"),
                    "completadas": n_comp,
                    "aprobados": v["aprobados"],
                    "rechazados": v["rechazados"],
                    "tasa_aprobacion": (v["aprobados"] / total_v) if total_v else None,
                    "xp": xp,
                    "nivel": 1 + math.floor(math.sqrt(xp / 10)),
                    "latencia_media": None,  # SIEMPRE null: SCHEDULER-V2 no existe
                    "intentos": None,        # SIEMPRE null: SCHEDULER-V2 no existe
                },
            })
    return agentes


@app.get("/api/agents")
def api_agents():
    agentes = construir_agentes()
    error = None
    if cargar_squads_static() is None:
        error = "sin datos (org/dashboard/squads.json ausente o no parsea)"
    elif not agentes:
        error = "sin datos (ningún asiento con campo agente: en squads.json)"
    return {"agentes": agentes, "total": len(agentes), "error": error}


# ---------- /api/armory — catálogo canónico (catálogo derivado de .mcp.json, agentes y belts) ----------

SENSIBLES_EXACT = {"Bash", "Write", "Edit", "NotebookEdit"}
# MCPs de escritura conocidos (por nombre normalizado) — heurística honesta
MCP_ESCRITURA = {"github", "slack", "gmail", "googledrive", "googlecalendar",
                 "canva", "cloudinary", "figma", "ms365", "microsoft365"}


def _norm_mcp(s: str) -> str:
    s = str(s)
    for pref in ("mcp__claude_ai_", "mcp__"):
        if s.startswith(pref):
            s = s[len(pref):]
            break
    return norm(s)


def _es_sensible(item_id: str, clase: str) -> bool:
    if item_id in SENSIBLES_EXACT:
        return True
    if clase == "mcp" and _norm_mcp(item_id) in MCP_ESCRITURA:
        return True
    return False


def _sprite_hint(item_id: str, clase: str) -> str:
    if clase == "skill":
        return "libro"
    if clase == "belt-mcp":
        return "caja"
    if clase == "mcp":
        return "orbe"
    return {"Bash": "terminal", "Write": "pluma", "Edit": "pluma",
            "Read": "lupa", "Grep": "lupa", "Glob": "lupa"}.get(item_id, "martillo")


def construir_armory():
    """Algoritmo SPEC §3 (catálogo canónico):
    1) unión de tools:/skills: de .claude/agents/*.md (id canónico = string EXACTO);
    2) servers de .mcp.json → mcp__X, dedupe contra (1) y contra alias mcp__claude_ai_*;
    3) org/belts/*.md best-effort → clase belt-mcp informativa (no equipable salvo match)."""
    fms = cargar_agentes_md()
    squads = cargar_squads_static() or []

    # squad "dueño" de cada agente vía asientos (compartido → None)
    squad_por_agente = {}
    for sq in squads:
        for asiento in (sq.get("asientos") or []):
            if isinstance(asiento, dict) and asiento.get("agente"):
                nombre = str(asiento["agente"])
                if nombre in ("squad-lead", "reviewer"):
                    squad_por_agente[nombre] = None
                elif nombre not in squad_por_agente:
                    squad_por_agente[nombre] = sq.get("slug")

    items = {}  # id canónico → item

    # (1) frontmatters
    for nombre, fm in fms.items():
        sq = squad_por_agente.get(nombre, squad_de(nombre, squads))
        for tid in fm["tools"]:
            clase = "mcp" if tid.startswith("mcp__") else "tool"
            it = items.setdefault(tid, {
                "id": tid, "nombre": tid.replace("mcp__claude_ai_", "").replace("mcp__", ""),
                "clase": clase, "origen": "frontmatter", "aliases": [],
                "equipable": True, "sensible": _es_sensible(tid, clase),
                "sprite_hint": _sprite_hint(tid, clase), "equipado_por": []})
            it["equipado_por"].append({"agente": nombre, "squad": sq})
        for sid in fm["skills"]:
            # skills NO equipables: equipar_tool solo edita tools: (regla del catálogo)
            it = items.setdefault(sid, {
                "id": sid, "nombre": sid, "clase": "skill", "origen": "frontmatter",
                "aliases": [], "equipable": False, "sensible": False,
                "sprite_hint": _sprite_hint(sid, "skill"), "equipado_por": []})
            it["equipado_por"].append({"agente": nombre, "squad": sq})

    # (2) .mcp.json — dedupe por id exacto y por alias conocido mcp__claude_ai_*
    norm_a_id = {_norm_mcp(i): i for i in items if items[i]["clase"] == "mcp"}
    servers = []
    text = leer_texto(MCP_JSON)
    if text:
        try:
            data = json.loads(text)
            servers = sorted((data.get("mcpServers") or {}).keys())
        except (json.JSONDecodeError, AttributeError):
            servers = []
    for srv in servers:
        canon = f"mcp__{srv}"
        existente = items.get(canon) or items.get(norm_a_id.get(norm(srv), ""))
        if existente:
            if canon != existente["id"] and canon not in existente["aliases"]:
                existente["aliases"].append(canon)  # mismo item, alias conocido
            if ".mcp.json" not in existente["origen"]:
                existente["origen"] += "+.mcp.json"
        else:
            items[canon] = {
                "id": canon, "nombre": srv, "clase": "mcp", "origen": ".mcp.json",
                "aliases": [], "equipable": True, "sensible": _es_sensible(canon, "mcp"),
                "sprite_hint": _sprite_hint(canon, "mcp"), "equipado_por": []}
            norm_a_id[_norm_mcp(canon)] = canon

    # (3) belts — parse best-effort: tokens `backtick` en TODO el texto, filtro
    # @scope o 'mcp' en el nombre (filtro del catálogo)
    belts = []
    if BELTS_DIR.is_dir():
        for p in sorted(BELTS_DIR.glob("*.md")):
            text = leer_texto(p) or ""
            ids_belt = []
            for tok in re.findall(r"`([A-Za-z0-9@/_.\-]+)`", text):
                if not (tok.startswith("@") or "mcp" in tok.lower()) or tok in ids_belt:
                    continue
                ids_belt.append(tok)
                if tok in items or norm(tok) in norm_a_id or _norm_mcp(tok) in norm_a_id:
                    continue  # ya está en (1)/(2): ahí sí es equipable
                items.setdefault(tok, {
                    "id": tok, "nombre": tok, "clase": "belt-mcp",
                    "origen": f"org/belts/{p.name}", "aliases": [],
                    "equipable": False, "sensible": False,
                    "sprite_hint": _sprite_hint(tok, "belt-mcp"), "equipado_por": []})
            belts.append({"belt": p.stem, "path": f"org/belts/{p.name}", "items": ids_belt})

    return sorted(items.values(), key=lambda x: (x["clase"], x["id"].lower())), belts


@app.get("/api/armory")
def api_armory():
    its, belts = construir_armory()
    error = None
    if not its:
        error = "sin datos (.claude/agents/ y .mcp.json ausentes o vacíos)"
    return {"items": its, "belts": belts, "total": len(its), "error": error}


# ---------- /api/dag — tablero de guerra (tabla §2.6 + camino crítico) ----------

# coherencia frontmatter↔carpeta para usar status: como fuente primaria (SPEC §2.6)
STATUS_COHERENTES = {
    "inbox": {"ready", "blocked", "roto", "ciclo", "blocked-on-founder", "founder-roto"},
    "processing": {"processing", "blocked-on-founder", "founder-roto"},
    "completed": {"completed"},
}


def _camino_critico(misiones):
    """Cadena más larga de nodos NO completed sobre el subgrafo SIN nodos en ciclo.
    DP topológico iterativo (Kahn) — NUNCA cuelga; empate → menor id."""
    por_id = {m["id"]: m for m in misiones if not m.get("en_ciclo")}
    validos = {mid for mid, m in por_id.items() if m["carpeta"] != "completed"}
    # edges dep→mision restringidos al subgrafo válido (acíclico por construcción:
    # todo nodo de un ciclo quedó excluido arriba)
    salientes = {mid: [] for mid in validos}
    grado_in = {mid: 0 for mid in validos}
    for mid in validos:
        for dep in por_id[mid]["depends_on"]:
            if dep in validos:
                salientes[dep].append(mid)
                grado_in[mid] += 1
    cola = sorted([m for m in validos if grado_in[m] == 0])
    largo = {m: 1 for m in validos}
    prev = {m: None for m in validos}
    orden = []
    while cola:
        n = cola.pop(0)
        orden.append(n)
        for s in sorted(salientes[n]):
            if largo[n] + 1 > largo[s] or (largo[n] + 1 == largo[s] and (prev[s] is None or n < prev[s])):
                largo[s] = largo[n] + 1
                prev[s] = n
            grado_in[s] -= 1
            if grado_in[s] == 0:
                cola.append(s)
                cola.sort()
    if len(orden) != len(validos):
        # ciclo residual imposible por construcción; defensa extra: no colgar jamás
        return []
    if not validos:
        return []
    mejor = min(validos, key=lambda m: (-largo[m], m))
    camino = []
    while mejor is not None:
        camino.append(mejor)
        mejor = prev[mejor]
    return list(reversed(camino))


@app.get("/api/dag")
def api_dag():
    misiones = cargar_misiones()
    ids = {m["id"] for m in misiones}
    nodos = []
    for m in misiones:
        # fuente primaria: status: del frontmatter si existe y es coherente con la carpeta
        st = m.get("status")
        coherente = isinstance(st, str) and st in STATUS_COHERENTES.get(m["carpeta"], set())
        nodos.append({
            "id": m["id"], "id_corto": m["id_corto"], "squad": m["squad"],
            "titulo": m["titulo"], "carpeta": m["carpeta"],
            "status_calc": st if coherente else m["status_calc"],
            "depends_on": m["depends_on"], "espera_founder": m["espera_founder"],
            "en_ciclo": m["en_ciclo"], "mtime": m["mtime"],
        })
    aristas = []
    for m in misiones:
        for dep in m["depends_on"]:
            if dep in ids:
                aristas.append([dep, m["id"]])  # a depende de de; flecha de→a
    error = None if MISSIONS_DIR.is_dir() else "sin datos (missions/ no existe)"
    return {"nodos": nodos, "aristas": aristas,
            "camino_critico": _camino_critico(misiones), "error": error}

# ---------- founder / library / doc / agent-log (guards de path, SPEC §3) ----------

def _doc_resuelto(path_rel):
    """Guard ÚNICO de /api/doc: sufijo .md + realpath dentro de ROOT + prefijo
    permitido (sobre la ruta YA resuelta). Devuelve Path o None."""
    s = str(path_rel or "").strip().lstrip("/")
    if not s or ".." in s.split("/") or not s.endswith(".md"):
        return None
    try:
        candidato = (ROOT / s).resolve()
        raiz = ROOT.resolve()
        rel = candidato.relative_to(raiz)  # ValueError si escapa de ROOT
    except (OSError, ValueError):
        return None
    rel_s = rel.as_posix()
    if not rel_s.endswith(".md") or not any(rel_s.startswith(p) for p in DOC_PREFIJOS):
        return None
    return candidato if candidato.is_file() else None


@app.get("/api/founder")
def api_founder():
    items = cargar_founder_items()
    error = None if FOUNDER_DIR.is_dir() else "sin datos (org/founder/ no existe)"
    conteos = {}
    for it in items:
        if it.get("estado") == "abierto":
            conteos[it["tipo"]] = conteos.get(it["tipo"], 0) + 1
    chats = {}
    chats_dir = FOUNDER_DIR / "chats"
    if chats_dir.is_dir():
        for p in sorted(chats_dir.glob("*.jsonl")):
            text = leer_texto(p) or ""
            if text and not text.endswith("\n"):  # §2.2: ignorar línea sin \n final
                text = text[:text.rfind("\n") + 1] if "\n" in text else ""
            msjs = []
            for line in text.splitlines():
                try:
                    d = json.loads(line)
                except (json.JSONDecodeError, ValueError):
                    continue
                if isinstance(d, dict):
                    msjs.append({"ts": d.get("ts"), "de": d.get("de"),
                                 "texto": str(d.get("texto") or "")[:1000]})
            chats[p.stem] = msjs[-50:]
    items.sort(key=lambda x: x.get("mtime") or 0, reverse=True)
    return {"items": items, "total": len(items), "conteos": conteos,
            "chats": chats, "error": error}


@app.get("/api/founder/item")
def api_founder_item(id: str = ""):
    iid = str(id or "").strip()
    if not FOUNDER_ID_RE.match(iid):
        return JSONResponse({"error": "id inválido (debe matchear ^[a-z0-9-]+$)"}, status_code=403)
    path, fm, body = buscar_founder_item(iid)
    if path is None:
        return {"item": None, "doc_body": None, "nota": None,
                "error": f"sin datos (item {iid} inexistente en org/founder/)"}
    # guard extra: realpath del archivo dentro de ROOT/org/founder
    try:
        path.resolve().relative_to((FOUNDER_DIR).resolve())
    except (OSError, ValueError):
        return JSONResponse({"error": "ruta fuera de org/founder/"}, status_code=403)
    doc_body, nota = None, None
    doc_rel = str(fm.get("doc") or "").strip()
    if doc_rel:
        doc_path = _doc_resuelto(doc_rel)  # MISMO guard que /api/doc
        if doc_path is not None:
            doc_body = leer_texto(doc_path)
        else:
            nota = f"doc '{doc_rel[:120]}' no pasa el guard de /api/doc — no se lee"
    return {"item": {
        "id": str(fm.get("id") or iid), "tipo": fm.get("tipo"),
        "squad": fm.get("squad"), "mision": str(fm.get("mision")) if fm.get("mision") else None,
        "ts": str(fm.get("ts")) if fm.get("ts") else None,
        "titulo": str(fm.get("titulo") or ""), "estado": fm.get("estado") or "sin datos",
        "default": fm.get("default"), "doc": doc_rel or None, "body": body,
    }, "doc_body": doc_body, "nota": nota, "error": None}


@app.get("/api/library")
def api_library(q: str = ""):
    q_norm = str(q or "").strip().lower()
    rutas = []
    if ARTIFACTS_DIR.is_dir():
        rutas += sorted(ARTIFACTS_DIR.rglob("*.md"))
    briefs = FOUNDER_DIR / "briefs"
    if briefs.is_dir():
        rutas += sorted(briefs.glob("*.md"))
    if REPORTS_DIR.is_dir():
        rutas += sorted(REPORTS_DIR.glob("*.md"))  # sin .log: solo *.md
    docs = []
    for p in rutas:
        if len(docs) >= 100:
            break
        if p.suffix != ".md":
            continue
        text = leer_texto(p) or ""
        try:
            rel = p.resolve().relative_to(ROOT.resolve()).as_posix()
        except (OSError, ValueError):
            continue
        if q_norm and q_norm not in p.name.lower() and q_norm not in text.lower():
            continue
        snippet = ""
        if q_norm:
            i = text.lower().find(q_norm)
            if i >= 0:
                snippet = text[max(0, i - 60):i + 140].replace("\n", " ").strip()
        if not snippet:
            snippet = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")[:200]
        titulo = next((ln.strip().lstrip("#").strip() for ln in text.splitlines() if ln.strip()), p.name)
        docs.append({"path": rel, "titulo": titulo[:120], "snippet": snippet[:200],
                     "mtime": mtime_de(p)})
    error = None if docs else ("sin datos (sin resultados)" if q_norm else "sin datos (sin documentos)")
    return {"items": docs, "total": len(docs), "q": q, "error": error}


@app.get("/api/doc")
def api_doc(path: str = ""):
    p = _doc_resuelto(path)
    if p is None:
        return JSONResponse({"error": "ruta no permitida (solo .md bajo org/artifacts/, "
                                      "org/founder/, reports/, org/belts/, missions/)"},
                            status_code=403)
    rel = p.resolve().relative_to(ROOT.resolve()).as_posix()
    return {"path": rel, "body": leer_texto(p), "error": None}


def _catalogo_nombres_agentes():
    nombres = set(cargar_agentes_md().keys())
    for sq in (cargar_squads_static() or []):
        for asiento in (sq.get("asientos") or []):
            if isinstance(asiento, dict) and asiento.get("agente"):
                nombres.add(str(asiento["agente"]))
    return nombres


@app.get("/api/agent-log")
def api_agent_log(agente: str = ""):
    nombre = str(agente or "").strip()
    if not NOMBRE_RE.match(nombre) or nombre not in _catalogo_nombres_agentes():
        return JSONResponse({"error": "agente inválido (fuera del catálogo)"}, status_code=403)
    lineas = []
    ulog = leer_texto(USAGE_LOG)
    if ulog:
        for line in ulog.splitlines():
            parts = [x for x in line.split("\t") if x]
            if len(parts) > 1 and parts[1] == nombre:
                lineas.append(line)
    eventos = [ev for ev in leer_eventos() if ev.get("agente") == nombre][-40:]
    mision_act, body_act = None, None
    for m in cargar_misiones():
        if m["carpeta"] == "processing" and _agente_en_mision(nombre, m):
            mision_act = {"id": m["id"], "id_corto": m["id_corto"], "titulo": m["titulo"]}
            for carpeta in CARPETAS:
                for p in (MISSIONS_DIR / carpeta).glob("*.md") if (MISSIONS_DIR / carpeta).is_dir() else []:
                    fm, body = frontmatter(p)
                    if str((fm or {}).get("id") or p.stem) == m["id"]:
                        body_act = body[:4000]
                        break
            break
    return {"agente": nombre, "usage": lineas[-40:], "eventos": eventos,
            "mision_actual": mision_act, "mision_body": body_act,
            "error": None if (lineas or eventos or mision_act) else "sin datos (sin actividad registrada)"}


# ---------- /api/metrics — series etiquetadas honestas ----------

@app.get("/api/metrics")
def api_metrics():
    squads = cargar_squads_static() or []
    ahora = time.time()
    corte_24h = ahora - 24 * 3600
    corte_7d = ahora - 7 * 24 * 3600

    def bucket(ts):
        return int(ts // 1800 * 1800)  # buckets de 30 min

    actividad_gateway = {}
    ulog = leer_texto(USAGE_LOG)
    if ulog:
        for line in ulog.splitlines():
            parts = [x for x in line.split("\t") if x]
            if len(parts) < 2:
                continue
            ts = parse_ts_iso(parts[0])
            if ts is None or ts < corte_24h:
                continue
            sq = squad_de(parts[1], squads) or "sin-squad"
            serie = actividad_gateway.setdefault(sq, {})
            serie[bucket(ts)] = serie.get(bucket(ts), 0) + 1

    misiones = cargar_misiones()
    actividad_misiones = {}
    ult_mision_squad = {}
    for m in misiones:
        sq = squad_de(m.get("squad"), squads) or "sin-squad"
        ts = m.get("ts_evento") or m["mtime"]
        ult_mision_squad[sq] = max(ult_mision_squad.get(sq, 0.0), ts)
        if ts >= corte_24h:
            serie = actividad_misiones.setdefault(sq, {})
            serie[bucket(ts)] = serie.get(bucket(ts), 0) + 1

    rechazos = {}
    for ev in leer_eventos():
        if ev.get("tipo") != "review_verdict" or ev.get("verdict") != "rechazado":
            continue
        ts = parse_ts_iso(ev.get("ts"))
        if ts is None or ts < corte_7d:
            continue
        sq = str(ev.get("squad") or "sin-squad")
        rechazos[sq] = rechazos.get(sq, 0) + 1

    ult_usage_squad = {}
    if ulog:
        for line in ulog.splitlines():
            parts = [x for x in line.split("\t") if x]
            if len(parts) < 2:
                continue
            ts = parse_ts_iso(parts[0])
            if ts is None:
                continue
            sq = squad_de(parts[1], squads) or "sin-squad"
            ult_usage_squad[sq] = max(ult_usage_squad.get(sq, 0.0), ts)

    idle_horas = {}
    for sq in [s.get("slug") for s in squads if s.get("slug")]:
        ult = max(ult_usage_squad.get(sq, 0.0), ult_mision_squad.get(sq, 0.0))
        idle_horas[sq] = round((ahora - ult) / 3600, 1) if ult > 0 else None

    def como_serie(d):
        return {sq: [{"t": t, "n": n} for t, n in sorted(serie.items())]
                for sq, serie in d.items()}

    inbox_dir = MISSIONS_DIR / "inbox"
    return {
        "actividad_gateway": como_serie(actividad_gateway),
        "actividad_misiones": como_serie(actividad_misiones),
        "rechazos": rechazos,
        "inbox_actual": len([m for m in misiones if m["carpeta"] == "inbox"]) if inbox_dir.is_dir() else 0,
        "idle_horas": idle_horas,
        "nota": "actividad_gateway NO registra la lane tools (Agent tool)",
        "error": None,
    }


# ---------- /api/state — pausa + agentes + digest ----------

@app.get("/api/state")
def api_state():
    paused = None
    if PAUSED_PATH.is_file():
        text = leer_texto(PAUSED_PATH) or ""
        try:
            paused = json.loads(text)
        except json.JSONDecodeError:
            paused = {"ts": None, "motivo": "sin datos (PAUSED no parsea)", "por": None}
    misiones = cargar_misiones()
    hoy = datetime.now().strftime("%Y-%m-%d")
    completadas_hoy = 0
    for m in misiones:
        if m["carpeta"] != "completed":
            continue
        try:
            dia = datetime.fromtimestamp(m.get("ts_evento") or m["mtime"]).strftime("%Y-%m-%d")
        except (OSError, OverflowError, ValueError):
            continue
        if dia == hoy:
            completadas_hoy += 1
    abiertos = [it for it in cargar_founder_items() if it.get("estado") == "abierto"]
    abiertos.sort(key=lambda x: x.get("mtime") or 0, reverse=True)
    return {
        "paused": paused,
        "agentes": cargar_estado_agentes(),
        "digest": {
            "completadas_hoy": completadas_hoy,
            "processing": len([m for m in misiones if m["carpeta"] == "processing"]),
            "esperan_founder": len([m for m in misiones if m["status_calc"] == "blocked-on-founder"]),
            "top_briefs": [{"id": it["id"], "tipo": it["tipo"], "titulo": it["titulo"]}
                           for it in abiertos[:3]],
        },
        "error": None,
    }

# ---------- /api/stream — SSE por conexión (hello inmediato + tail + heartbeat) ----------

def _snapshot_watch():
    """mtimes agregados de las fuentes vigiladas (clave → fingerprint)."""
    def agregado(d: Path):
        total, n = 0.0, 0
        if d.is_dir():
            try:
                for p in d.rglob("*"):
                    if p.is_file():
                        total = max(total, mtime_de(p))
                        n += 1
            except OSError:
                pass
        return (total, n)
    return {
        "missions": agregado(MISSIONS_DIR),
        "founder": agregado(FOUNDER_DIR),
        "agents_state": mtime_de(STATE_AGENTES),
        "paused": (PAUSED_PATH.is_file(), mtime_de(PAUSED_PATH)),
        "usage": mtime_de(USAGE_LOG),
        "security": mtime_de(SECURITY_LOG),
        # fuentes del Despacho (DESPACHO.md): drafts, DECISIONS, outbox raíz,
        # artifacts/system/reports (docs PUNTOS CLAVE) y las marcas leído/decidido
        # (founder y missions ya disparan solas; el front mapea esas claves a
        # "despacho" también — ver clavesDe en data.js)
        "despacho": (agregado(DRAFTS_DIR), mtime_de(DECISIONS_PATH),
                     agregado(ARTIFACTS_DIR), agregado_nivel1(SYSTEM_DIR),
                     agregado_nivel1(REPORTS_DIR), agregado_nivel1(OUTBOX_DIR),
                     mtime_de(DESPACHO_MARCAS)),
    }


def _tail_eventos(offset: int):
    """Líneas COMPLETAS nuevas de events.jsonl desde offset (bytes). Ignora la
    cola sin \n final (§2.2). Devuelve (eventos, offset_nuevo)."""
    try:
        size = EVENTS_PATH.stat().st_size
    except OSError:
        return [], 0
    if size < offset:
        offset = 0  # archivo recreado/truncado: releer
    if size == offset:
        return [], offset
    try:
        with open(EVENTS_PATH, "rb") as f:
            f.seek(offset)
            raw = f.read(size - offset)
    except OSError:
        return [], offset
    corte = raw.rfind(b"\n")
    if corte < 0:
        return [], offset
    completas, consumido = raw[:corte + 1], corte + 1
    evs = []
    for line in completas.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(ev, dict):
            evs.append(ev)
    return evs, offset + consumido


def _sse(obj) -> str:
    return "data: " + json.dumps(obj, ensure_ascii=False) + "\n\n"


@app.get("/api/stream")
async def api_stream(request: Request):
    async def gen():
        # estado POR CONEXIÓN: mtimes y offset propios (SPEC §3)
        mtimes = _snapshot_watch()
        try:
            offset = EVENTS_PATH.stat().st_size
        except OSError:
            offset = 0
        yield _sse({"tipo": "hello"})  # PRIMER mensaje, inmediato
        ultimo_hb = time.monotonic()
        while True:
            if await request.is_disconnected():
                break
            await asyncio.sleep(1.0)
            nuevo = _snapshot_watch()
            que = [k for k in nuevo if nuevo[k] != mtimes.get(k)]
            if que:
                mtimes = nuevo
                yield _sse({"tipo": "refresh", "que": que})
            evs, offset = _tail_eventos(offset)
            for ev in evs:
                yield _sse({"tipo": "org_event", "evento": ev})
            if time.monotonic() - ultimo_hb >= 15.0:
                ultimo_hb = time.monotonic()
                yield ": heartbeat\n\n"  # comentario SSE: keep-alive, EventSource lo ignora
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------- POST /api/command — drafts de comando (escritura (b)) ----------

# shape mínimo por tipo: (requeridos, opcionales). Campos de NOMBRE validados
# con ^[a-zA-Z0-9._-]+$; modelo_nuevo ∈ tabla de tiers; textos con tope.
TIPOS_COMANDO = {
    "reasignar_modelo": (("agente", "squad", "modelo_nuevo"), ()),
    "nudge": (("agente", "squad", "mensaje"), ()),
    "pausar_agente": (("agente", "squad"), ("motivo",)),
    "reanudar_agente": (("agente", "squad"), ("motivo",)),
    "equipar_tool": (("agente", "tool"), ()),
    "desequipar_tool": (("agente", "tool"), ()),
    "asignar_mision": (("mision", "squad"), ()),
    "responder_decision": (("item", "opcion"), ("comentario",)),
    "responder_pregunta": (("item", "respuesta"), ()),
    "feedback_brief": (("item", "feedback"), ()),
    "mensaje_lead": (("squad", "texto"), ()),
    "reanudar_org": ((), ()),
}
CAMPOS_NOMBRE = {"agente", "squad", "item", "mision", "tool"}
TOPES_TEXTO = {"mensaje": 500, "texto": 1000}


def _validar_payload(tipo: str, payload: dict):
    """None si pasa; string con el motivo si no (shape mínimo §2.1)."""
    req, opc = TIPOS_COMANDO[tipo]
    permitidos = set(req) | set(opc)
    for k in payload:
        if k not in permitidos:
            return f"campo inesperado: {k}"
    for k in req:
        if not str(payload.get(k) or "").strip():
            return f"falta campo requerido: {k}"
    for k, v in payload.items():
        if not isinstance(v, str):
            return f"campo {k} debe ser string"
        if k in CAMPOS_NOMBRE and not NOMBRE_RE.match(v):
            return f"nombre inválido en {k} (debe matchear ^[a-zA-Z0-9._-]+$)"
        tope = TOPES_TEXTO.get(k, 2000)
        if len(v) > tope:
            return f"campo {k} excede {tope} caracteres"
    if tipo == "reasignar_modelo" and payload.get("modelo_nuevo", "").lower() not in ALIAS_TIER:
        return f"modelo_nuevo fuera de la tabla de tiers ({', '.join(sorted(ALIAS_TIER))})"
    return None


@app.post("/api/command")
async def api_command(request: Request):
    err = chequear_csrf(request, "/api/command")
    if err:
        return err
    rl = rate_excedido("command", "/api/command")
    if rl:
        return rl
    try:
        payload_raw = json.loads(await request.body())
    except (json.JSONDecodeError, ValueError):
        return JSONResponse({"ok": False, "id": None, "hint": "body JSON inválido"}, status_code=400)
    if not isinstance(payload_raw, dict):
        return JSONResponse({"ok": False, "id": None, "hint": "body debe ser objeto JSON"}, status_code=400)
    tipo = str(payload_raw.get("tipo") or "").strip()
    payload = payload_raw.get("payload")
    if tipo not in TIPOS_COMANDO:
        return JSONResponse({"ok": False, "id": None,
                             "hint": f"tipo fuera de catálogo ({', '.join(sorted(TIPOS_COMANDO))})"},
                            status_code=400)
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "id": None, "hint": "payload debe ser objeto"}, status_code=400)
    motivo = _validar_payload(tipo, payload)
    if motivo:
        return JSONResponse({"ok": False, "id": None, "hint": motivo}, status_code=400)
    ts = datetime.now(timezone.utc)
    cid = f"cmd-{ts.strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}-{tipo}"
    draft = {"id": cid, "ts": ts.strftime("%Y-%m-%dT%H:%M:%SZ"), "origen": "dashboard",
             "user_id": USER_ID,  # sellado por el server: identifica el canal, NO el origen
             "tipo": tipo, "payload": payload, "status": "draft"}
    try:
        COMMANDS_DIR.mkdir(parents=True, exist_ok=True)
        destino = COMMANDS_DIR / f"{cid}.json"
        while destino.exists():  # archivo NUEVO siempre: jamás pisar
            cid = f"cmd-{ts.strftime('%Y%m%dT%H%M%SZ')}-{secrets.token_hex(2)}-{tipo}"
            draft["id"] = cid
            destino = COMMANDS_DIR / f"{cid}.json"
        destino.write_text(json.dumps(draft, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    except OSError as e:
        return JSONResponse({"ok": False, "id": None, "hint": f"no se pudo escribir el draft: {e}"},
                            status_code=500)
    return {"ok": True, "id": cid, "hint": f"draft {cid} creado — lo ejecuta el Supervisor"}


# ---------- POST /api/firealarm — pausa global (escrituras (c)(d)(e)) ----------

@app.post("/api/firealarm")
async def api_firealarm(request: Request):
    err = chequear_csrf(request, "/api/firealarm")
    if err:
        return err
    rl = rate_excedido("firealarm", "/api/firealarm")
    if rl:
        return rl
    try:
        payload = json.loads(await request.body())
    except (json.JSONDecodeError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "hint": "body JSON inválido"}, status_code=400)
    if payload.get("confirmar") is not True:
        return JSONResponse({"ok": False, "hint": "falta confirmar:true"}, status_code=400)
    token = str(payload.get("token") or "")
    asegurar_alarm_token()  # si falta, se regenera (y el provisto no matchea)
    guardado = (leer_texto(TOKEN_PATH) or "").strip()
    if not guardado or not token or not secrets.compare_digest(token, guardado):
        append_security("FIREALARM_TOKEN_INVALIDO", "token incorrecto o ausente")
        return JSONResponse({"ok": False, "hint": "token inválido"}, status_code=403)
    ts = now_iso()
    try:
        if not PAUSED_PATH.exists():  # (c) crear SOLO si no existe — jamás pisar
            PAUSED_PATH.parent.mkdir(parents=True, exist_ok=True)
            PAUSED_PATH.write_text(json.dumps(
                {"ts": ts, "motivo": "alarma de incendio desde el dashboard", "por": USER_ID},
                ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    except OSError as e:
        return JSONResponse({"ok": False, "hint": f"no se pudo crear org/PAUSED: {e}"}, status_code=500)
    # (d) 1 línea pausa_org al event log
    append_evento({"tipo": "pausa_org", "detalle": "alarma de incendio desde el dashboard",
                   "por": USER_ID})
    # (e) alerta NUEVA en outbox (el bridge la manda a Telegram)
    try:
        OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
        base = f"alerta-pausa-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
        destino = OUTBOX_DIR / f"{base}.txt"
        n = 1
        while destino.exists():
            n += 1
            destino = OUTBOX_DIR / f"{base}-{n}.txt"
        destino.write_text(
            f"🚨 ORG PAUSADO — alarma de incendio desde el dashboard ({ts}).\n"
            f"El archivo org/PAUSED indica a tu orquestador que no lance nuevos agentes.\n"
            f"Para reanudar: borra org/PAUSED a mano (el dashboard no tiene endpoint de des-pausa).\n",
            encoding="utf-8")
    except OSError:
        pass  # la pausa ya rige; la alerta es best-effort
    # NO hay endpoint de des-pausa: para reanudar se borra org/PAUSED a mano
    return {"ok": True, "paused": {"ts": ts, "por": USER_ID}}


# ---------- composer del canal (contrato v2 del intake Telegram — escritura (a)) ----------

MISSION_TRIGGERS = ("mision:", "misión:", "/mision")  # mismos triggers que el bridge


def _slugify(s: str) -> str:
    """Mismo algoritmo que org/telegram_bridge.py (replicado, no importado)."""
    s = unicodedata.normalize("NFKD", str(s).lower()).encode("ascii", "ignore").decode()
    s = "".join(c if (c.isascii() and c.isalnum()) or c in " -" else "" for c in s)
    return "-".join(s.split())[:32].strip("-") or "orden"


@app.post("/api/intake")
async def api_intake(request: Request):
    """Crea un draft de misión NUEVO en missions/inbox/ (origen: dashboard).
    Solo con trigger explícito 'mision:' — igual que el chat de Telegram.
    Jamás edita ni pisa un archivo existente. CSRF §0.6 aplica también acá."""
    err = chequear_csrf(request, "/api/intake")
    if err:
        return err
    try:
        payload = json.loads(await request.body())
    except (json.JSONDecodeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    texto = str((payload or {}).get("texto") or "").strip()[:1000]
    t = texto.lstrip().lower()
    if not any(t.startswith(p) for p in MISSION_TRIGGERS):
        return {"ok": False, "id": None,
                "hint": "charla sin efectos — para crear una misión comienza con «mision: <qué hay que hacer>» (igual que en Telegram)"}
    orden = texto.lstrip()
    for p in MISSION_TRIGGERS:
        if orden.lower().startswith(p):
            orden = orden[len(p):].strip()
            break
    if not orden:
        return {"ok": False, "id": None, "hint": "misión vacía: «mision: <qué hay que hacer>»"}
    inbox = MISSIONS_DIR / "inbox"
    try:
        inbox.mkdir(parents=True, exist_ok=True)
        ahora = datetime.now(timezone.utc)
        hoy_utc = ahora.strftime("%Y-%m-%d")
        slug = _slugify(orden)
        n = len(list(inbox.glob(f"{hoy_utc}-*.md"))) + 1
        while (inbox / f"{hoy_utc}-{n:04d}-{slug}.md").exists():  # nunca pisar nada
            n += 1
        mid = f"{hoy_utc}-{n:04d}-{slug}"
        cuerpo = (f"---\nid: {mid}\nsquad: TBD            # lo decide el Supervisor\n"
                  f"tipo: TBD             # fast-lane | ceremonia (lo decide el Supervisor)\n"
                  f"spec: {json.dumps(orden, ensure_ascii=False)}\n"
                  f"done: TBD             # criterio de cierre (lo define el Supervisor)\n"
                  f"estado: inbox\norigen: dashboard\ncreada: {ahora.strftime('%Y-%m-%dT%H:%M:%SZ')}\n---\n"
                  f"Orden cruda del fundador (composer del dashboard; solo transporta):\n{orden}\n")
        (inbox / f"{mid}.md").write_text(cuerpo, encoding="utf-8")
        return {"ok": True, "id": mid, "hint": f"misión recibida: {mid}"}
    except OSError as e:
        return {"ok": False, "id": None, "hint": f"no se pudo escribir el draft: {e}"}


# ---------- despacho del founder (contrato org/system/DESPACHO.md) ----------
# Tres zonas: PARA DECIDIR / PARA LEER / DECIDIDO + biblioteca de recursos.
# Regla central: nadie "publica al Despacho" — el org escribe sus archivos
# normales y esta sección los DETECTA. Todo defensivo: nunca lanza.

# el id jamás toca el filesystem (solo se appendea al jsonl y se compara contra
# ids de items); se rechazan controles y se exige que el id EXISTA en las bandejas
DESPACHO_ID_RE = re.compile(r"^[^\x00-\x1f\x7f]{1,200}$")
MARCAS_VALIDAS = ("leido", "decidido")
# heading EXACTO (+ paréntesis opcional): "## PUNTOS CLAVE — contrato..." de los
# docs de sistema NO debe contar como bloque (lección del review adversarial)
_PC_HEAD_RE = re.compile(r"^#{2,3}\s*PUNTOS CLAVE\s*(?:\([^)]*\))?\s*$", re.I)
# bold opcional: una decisión real escrita sin ** no debe caer en FYI silencioso
_PC_DECISION_RE = re.compile(r"\*{0,2}Decisi[oó]n que se te pide:?\*{0,2}:?\s*(.+)", re.I)
_PC_URGENCIA_RE = re.compile(r"\*\*Urgencia:?\*\*:?\s*(.+)", re.I)
URGENCIAS = ("hoy", "esta semana", "cuando puedas")
_URL_MD_RE = re.compile(r"\[([^\]]*)\]\((https?://[^\s)]+)\)")
_URL_SUELTA_RE = re.compile(r"(?<![(\[])(https?://[^\s)\]>'\"`]+)")


def leer_marcas():
    """org/founder/despacho-marcas.jsonl → dict id → {marca, ts, ref}.
    Última marca gana (append-only §2.2: se ignora una cola sin \\n)."""
    text = leer_texto(DESPACHO_MARCAS)
    if not text:
        return {}
    if not text.endswith("\n"):
        text = text[:text.rfind("\n") + 1] if "\n" in text else ""
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        if isinstance(d, dict) and d.get("id") and d.get("marca") in MARCAS_VALIDAS:
            out[str(d["id"])] = {"marca": d["marca"], "ts": d.get("ts"),
                                 "ref": str(d.get("ref") or "")[:300] or None}
    return out


def _rel_de(p: Path):
    try:
        return p.resolve().relative_to(ROOT.resolve()).as_posix()
    except (OSError, ValueError):
        return None


def parse_puntos_clave(text: str):
    """Bloque '## PUNTOS CLAVE' del contrato de org/system/DESPACHO.md.
    → (puntos, decision, urgencia) o (None, None, None) si no hay bloque útil.
    Ignora contenido dentro de code-fences ``` (un contrato que EJEMPLIFICA el
    bloque no debe aparecer como item — p.ej. DESPACHO.md)."""
    lines = (text or "").splitlines()
    en_fence, inicio = False, None
    for i, ln in enumerate(lines):
        if ln.strip().startswith("```"):
            en_fence = not en_fence
            continue
        if not en_fence and _PC_HEAD_RE.match(ln.strip()):
            inicio = i + 1
            break
    if inicio is None:
        return None, None, None
    puntos, decision, urgencia = [], None, None
    en_fence = False
    for ln in lines[inicio:]:
        s = ln.strip()
        if s.startswith("```"):
            en_fence = not en_fence
            continue
        if en_fence:
            continue
        if re.match(r"^#{1,6}\s", s) or s == "---":
            break
        # la decisión se reconoce ANTES que los bullets: una decisión escrita
        # como "- **Decisión que se te pide:** ..." NO debe tragarse como punto
        m = _PC_DECISION_RE.search(s)
        if m and decision is None:
            decision = m.group(1).strip()
            continue
        m = _PC_URGENCIA_RE.search(s)
        if m and urgencia is None:
            urgencia = m.group(1).strip().lower()
            continue
        if s.startswith("- "):
            puntos.append(s[2:].strip())
    if not puntos and decision is None:
        return None, None, None  # heading sin contenido real: no es founder-facing
    if urgencia not in URGENCIAS:
        urgencia = None
    return puntos[:5], decision, urgencia


def _estado_de(marcas: dict, iid: str) -> str:
    m = marcas.get(iid)
    return m["marca"] if m else "sin-leer"


def _es_fyi(decision) -> bool:
    """¿La línea de decisión dice 'ninguna…'? Pela bold/comillas antes de mirar."""
    if not decision:
        return True
    limpio = re.sub(r"^[\s*_\"'«»]+", "", str(decision).lower())
    return limpio.startswith("ninguna")


def _items_docs(marcas: dict):
    """Docs con bloque PUNTOS CLAVE: org/artifacts/** + org/system/*.md + reports/*.md."""
    rutas = []
    if ARTIFACTS_DIR.is_dir():
        rutas += sorted(ARTIFACTS_DIR.rglob("*.md"))
    if SYSTEM_DIR.is_dir():
        rutas += sorted(SYSTEM_DIR.glob("*.md"))
    if REPORTS_DIR.is_dir():
        rutas += sorted(REPORTS_DIR.glob("*.md"))
    items = []
    for p in rutas:
        text = leer_texto(p)
        if not text or "PUNTOS CLAVE" not in text:
            continue  # barato antes de parsear
        puntos, decision, urgencia = parse_puntos_clave(text)
        if puntos is None and decision is None:
            continue
        rel = _rel_de(p)
        if rel is None:
            continue
        titulo = next((ln.strip().lstrip("#").strip()
                       for ln in text.splitlines() if ln.strip()), p.name)
        pide = bool(decision) and not _es_fyi(decision)
        items.append({
            "id": rel, "fuente": "doc", "titulo": titulo[:140], "path": rel,
            "puntos": puntos or [], "decision_pedida": decision,
            "accion": decision if pide else None,
            "urgencia": urgencia or ("esta semana" if pide else "cuando puedas"),
            "origen": rel.rsplit("/", 1)[0], "mtime": mtime_de(p),
            "estado": _estado_de(marcas, rel),
            "zona": "decidir" if pide else "leer",
        })
    return items


def _items_drafts(marcas: dict):
    """Drafts de mandato AÚN no emitidos (sin sufijo .emitted) → PARA DECIDIR."""
    items = []
    if not DRAFTS_DIR.is_dir():
        return items
    for p in sorted(DRAFTS_DIR.glob("*.md")):
        if not re.match(r"^P\d+", p.stem):
            continue  # convención PNNN-slug — basura no gana un emit
        fm, body = frontmatter(p)
        fm = fm or {}
        pnum = p.stem.split("-")[0] if "-" in p.stem else p.stem
        rel = _rel_de(p)
        spec = str(fm.get("spec") or "").strip()
        puntos = [x for x in [
            " · ".join(filter(None, [
                f"squad: {fm.get('squad')}" if fm.get("squad") else None,
                f"pieza: {fm.get('pieza')}" if fm.get("pieza") else None,
                f"origen: {fm.get('origen')}" if fm.get("origen") else None])),
            (spec[:220] + "…") if len(spec) > 220 else spec,
        ] if x]
        items.append({
            "id": p.name, "fuente": "draft", "titulo": p.stem, "path": rel,
            "puntos": puntos, "decision_pedida": "aprobar (emitir a la cola) o vetar",
            "accion": (f"abre {rel}: emítelo a la cola de misiones o vétalo "
                       f"(el dashboard solo lo muestra; {pnum})"),
            "urgencia": "esta semana", "origen": str(fm.get("origen") or "mandato"),
            "mtime": mtime_de(p), "estado": _estado_de(marcas, p.name),
            "zona": "decidir",
        })
    return items


def _items_founder(marcas: dict):
    """Items del founder-protocol abiertos: decision/pregunta → DECIDIR · brief → LEER."""
    items = []
    for it in cargar_founder_items():
        if it.get("estado") != "abierto":
            continue
        tipo = str(it.get("tipo") or "")
        pide = tipo in ("decision", "pregunta")
        items.append({
            "id": str(it.get("id") or ""), "fuente": "founder",
            "titulo": str(it.get("titulo") or it.get("id") or "?")[:140],
            "path": None, "founder_id": str(it.get("id") or ""),
            "puntos": [x for x in [
                f"{tipo} de @{it.get('squad')}" if it.get("squad") else tipo,
                f"default si no respondés: {it.get('default')}" if it.get("default") else None,
            ] if x],
            "decision_pedida": "responder desde el lector (crea draft)" if pide else None,
            "accion": "abre el item y responde — crea un draft que aplica el Supervisor" if pide else None,
            "urgencia": "esta semana" if pide else "cuando puedas",
            "origen": f"org/founder/{tipo}", "mtime": it.get("mtime") or 0,
            "estado": _estado_de(marcas, str(it.get("id") or "")),
            "zona": "decidir" if pide else "leer",
        })
    return items


def _items_outbox(marcas: dict):
    """Briefs en la RAÍZ del outbox (aún no enviados a Telegram). Transitorios
    por diseño: el bridge los mueve a sent/ al enviarlos (DESPACHO.md §límites)."""
    items = []
    if not OUTBOX_DIR.is_dir():
        return items
    try:
        candidatos = sorted([p for p in OUTBOX_DIR.iterdir()
                             if p.is_file() and p.suffix in (".md", ".txt")])
    except OSError:
        return items
    for p in candidatos:
        text = leer_texto(p) or ""
        que = re.search(r"^QU[ÉE]:\s*(.+)$", text, re.M)
        accion = re.search(r"^ACCI[ÓO]N:\s*(.+)$", text, re.M)
        urg = re.search(r"^URGENCIA:\s*(.+)$", text, re.M)
        accion_txt = accion.group(1).strip() if accion else None
        pide = bool(accion_txt) and not _es_fyi(accion_txt)
        titulo = (que.group(1).strip() if que
                  else next((ln.strip() for ln in text.splitlines() if ln.strip()), p.name))
        urg_txt = (urg.group(1).strip().lower().split(".")[0].strip() if urg else "")
        urgencia = next((u for u in URGENCIAS if urg_txt.startswith(u)), None)
        puntos = [ln.strip() for ln in text.splitlines() if ln.strip()][:4]
        iid = f"outbox/{p.name}"
        items.append({
            "id": iid, "fuente": "outbox", "titulo": titulo[:140],
            "path": _rel_de(p) if p.suffix == ".md" else None,
            "puntos": puntos, "decision_pedida": accion_txt if pide else None,
            "accion": accion_txt if pide else None,
            "urgencia": urgencia or ("hoy" if p.name.startswith("alerta") else "esta semana"),
            "origen": "reports/outbox (en tránsito a Telegram)", "mtime": mtime_de(p),
            "estado": _estado_de(marcas, iid),
            "zona": "decidir" if pide else "leer",
        })
    return items


def _items_blocked(marcas: dict):
    """Misiones blocked-on-founder: el org está FRENADO esperándote → DECIDIR."""
    items = []
    for m in cargar_misiones():
        if m.get("status_calc") != "blocked-on-founder":
            continue
        espera = m.get("espera_founder") or m.get("espera_a")
        items.append({
            "id": str(m.get("id") or ""), "fuente": "mision",
            "titulo": f"misión frenada: {m.get('titulo') or m.get('id')}"[:140],
            "path": None, "founder_id": str(espera) if espera else None,
            "puntos": [x for x in [
                f"id: {m.get('id')}",
                f"espera el item: {espera}" if espera else "espera un item founder",
            ] if x],
            "decision_pedida": "responder el item que la bloquea",
            "accion": (f"abre el item '{espera}' y responde" if espera
                       else "abre la bandeja founder y responde el item"),
            "urgencia": "hoy", "origen": "missions (pipeline)",
            "mtime": 0, "estado": _estado_de(marcas, str(m.get("id") or "")),
            "zona": "decidir",
        })
    return items


def _decidido(marcas: dict):
    """Histórico: DECISIONS.md (entradas con fecha) + items founder respondidos
    + sellos DECIDIDO del propio Despacho. Más reciente primero."""
    entradas = []
    text = leer_texto(DECISIONS_PATH)
    fase = None
    if text:
        for ln in text.splitlines():
            s = ln.strip()
            if s.startswith("## "):
                fase = s.lstrip("#").strip()
                continue
            m = re.match(r"^- (\d{4}-\d{2}-\d{2}) · ([^·]+?) · (.+)$", s)
            if not m:
                continue
            resto = m.group(3).strip()
            partes = resto.rsplit(" · ", 1)
            decision = re.sub(r"\*\*", "", partes[0]).strip()
            porque = partes[1].strip() if len(partes) == 2 else None
            entradas.append({
                "fecha": m.group(1), "ts": m.group(1), "quien": m.group(2).strip(),
                "decision": decision[:400], "porque": (porque or "")[:240] or None,
                "es_operador": _es_operador(m.group(2)),
                "fase": fase, "fuente": "DECISIONS",
                "ref": "org/DECISIONS.md",
            })
    for it in cargar_founder_items():
        if it.get("estado") != "respondido":
            continue
        ts = str(it.get("ts") or "")
        entradas.append({
            "fecha": ts[:10] or "sin datos", "ts": ts or "0",
            "quien": OPERATOR_NAME, "decision": f"respondió: {it.get('titulo') or it.get('id')}"[:400],
            "porque": None, "fase": None, "fuente": "founder", "es_operador": True,
            "ref": str(it.get("id") or ""),
        })
    for iid, m in marcas.items():
        if m["marca"] != "decidido":
            continue
        ts = str(m.get("ts") or "")
        entradas.append({
            "fecha": ts[:10] or "sin datos", "ts": ts or "0",
            "quien": OPERATOR_NAME, "decision": f"selló DECIDIDO: {iid}"[:400],
            "porque": m.get("ref"), "fase": None, "fuente": "sello", "es_operador": True, "ref": iid,
        })
    entradas.sort(key=lambda e: str(e.get("ts") or ""), reverse=True)
    return entradas[:80]


_ORDEN_URGENCIA = {"hoy": 0, "esta semana": 1, "cuando puedas": 2}


@app.get("/api/despacho")
def api_despacho():
    marcas = leer_marcas()
    todos = (_items_docs(marcas) + _items_drafts(marcas) + _items_founder(marcas)
             + _items_outbox(marcas) + _items_blocked(marcas))
    # un item sellado "decidido" sale de las bandejas (vive en el histórico)
    activos = [it for it in todos if it["estado"] != "decidido"]
    decidir = sorted([it for it in activos if it["zona"] == "decidir"],
                     key=lambda it: (_ORDEN_URGENCIA.get(it["urgencia"], 9), -(it["mtime"] or 0)))
    leer = sorted([it for it in activos if it["zona"] == "leer"],
                  key=lambda it: (0 if it["estado"] == "sin-leer" else 1, -(it["mtime"] or 0)))
    decidido = _decidido(marcas)
    error = None if (ARTIFACTS_DIR.is_dir() or SYSTEM_DIR.is_dir() or FOUNDER_DIR.is_dir()) \
        else "sin datos (árbol del org incompleto)"
    return {"decidir": decidir, "leer": leer, "decidido": decidido,
            "conteos": {"decidir": len(decidir),
                        "leer_sin_leer": sum(1 for it in leer if it["estado"] == "sin-leer"),
                        "leer": len(leer), "decidido": len(decidido)},
            "error": error}


def _firma_doc(text: str):
    """(squad, mision) heurísticos del header de un doc (primeras 15 líneas)."""
    squad = mision = None
    for ln in (text or "").splitlines()[:15]:
        if squad is None:
            m = re.search(r"[Ss]quad:?\**\s*([A-Za-z0-9 _/+().-]{2,40})", ln)
            if m:
                squad = m.group(1).strip().rstrip("·").strip()
        if mision is None:
            m = re.search(r"[Mm]isi[oó]n:?\**\s*([A-Za-z0-9-]{4,60})", ln)
            if m:
                mision = m.group(1).strip()
    return squad, mision


@app.get("/api/despacho/biblioteca")
def api_despacho_biblioteca():
    """Recursos (links) que el org USÓ, por documento: qué doc, qué squad/misión
    firma, y la línea de contexto (qué se obtuvo). 100% derivado de los docs."""
    rutas = []
    if ARTIFACTS_DIR.is_dir():
        rutas += sorted(ARTIFACTS_DIR.rglob("*.md"))
    if SYSTEM_DIR.is_dir():
        rutas += sorted(SYSTEM_DIR.glob("*.md"))
    if BELTS_DIR.is_dir():
        rutas += sorted(BELTS_DIR.glob("*.md"))
    if CATALOG_DIR.is_dir():
        rutas += sorted(CATALOG_DIR.rglob("*.md"))
    docs, dominios = [], {}
    for p in rutas:
        text = leer_texto(p)
        if not text or "http" not in text:
            continue
        rel = _rel_de(p)
        if rel is None:
            continue
        squad, mision = _firma_doc(text)
        vistos, recursos = set(), []
        for ln in text.splitlines():
            if "http" not in ln:
                continue
            encontrados = [(t, u) for t, u in _URL_MD_RE.findall(ln)]
            con_md = {u for _, u in encontrados}
            encontrados += [("", u) for u in _URL_SUELTA_RE.findall(ln) if u not in con_md]
            contexto = re.sub(r"\[([^\]]*)\]\((https?://[^\s)]+)\)", r"\1",
                              ln.strip().lstrip("-*#> ").strip())
            contexto = re.sub(r"https?://\S+", "", contexto).strip(" ·—-:,")
            for texto_link, url in encontrados:
                url = url.rstrip(".,;:")
                if url in vistos or len(recursos) >= 60:
                    continue
                vistos.add(url)
                try:
                    dominio = urlparse(url).hostname or "?"
                except ValueError:
                    dominio = "?"
                dominios[dominio] = dominios.get(dominio, 0) + 1
                recursos.append({"url": url, "dominio": dominio,
                                 "texto": (texto_link or "")[:90],
                                 "contexto": contexto[:160],
                                 "verificado": "verificado" in ln.lower()})
        if recursos:
            titulo = next((l.strip().lstrip("#").strip()
                           for l in text.splitlines() if l.strip()), p.name)
            docs.append({"path": rel, "titulo": titulo[:120], "squad": squad or "org",
                         "mision": mision, "mtime": mtime_de(p),
                         "recursos": recursos, "n": len(recursos)})
    docs.sort(key=lambda d: d["n"], reverse=True)
    top = sorted(dominios.items(), key=lambda kv: kv[1], reverse=True)[:10]
    total = sum(d["n"] for d in docs)
    return {"docs": docs[:40], "total": total,
            "dominios": [{"dominio": k, "n": v} for k, v in top],
            "error": None if docs else "sin datos (ningún doc con links)"}


@app.post("/api/despacho/marcar")
async def api_despacho_marcar(request: Request):
    """Escritura (h): UNA línea nueva en despacho-marcas.jsonl. Es estado de
    lectura del operador (no trabajo del org): por eso no pasa por draft."""
    err = chequear_csrf(request, "/api/despacho/marcar")
    if err:
        return err
    rl = rate_excedido("despacho", "/api/despacho/marcar")
    if rl:
        return rl
    try:
        payload = json.loads(await request.body())
    except (json.JSONDecodeError, ValueError):
        payload = None
    if not isinstance(payload, dict):
        return JSONResponse({"ok": False, "hint": "body JSON inválido"}, status_code=400)
    iid = str(payload.get("id") or "").strip()
    marca = str(payload.get("marca") or "").strip()
    ref = str(payload.get("ref") or "").strip()[:300]
    if marca not in MARCAS_VALIDAS:
        return JSONResponse({"ok": False, "hint": f"marca fuera de catálogo ({', '.join(MARCAS_VALIDAS)})"},
                            status_code=400)
    if not DESPACHO_ID_RE.match(iid) or ".." in iid.split("/"):
        append_security("DESPACHO_ID_INVALIDO", f"id={iid[:120]}")
        return JSONResponse({"ok": False, "hint": "id inválido"}, status_code=400)
    # el id debe ser un item REAL de las bandejas actuales: sin esto se podría
    # pre-marcar "decidido" un id futuro y suprimir una decisión antes de nacer
    sin_marcas = {}
    actuales = {it["id"] for it in (_items_docs(sin_marcas) + _items_drafts(sin_marcas)
                                    + _items_founder(sin_marcas) + _items_outbox(sin_marcas)
                                    + _items_blocked(sin_marcas))}
    if iid not in actuales:
        append_security("DESPACHO_ID_INEXISTENTE", f"id={iid[:120]}")
        return JSONResponse({"ok": False,
                             "hint": "id no corresponde a ningún item actual del Despacho"},
                            status_code=400)
    linea = json.dumps({"ts": now_iso(), "id": iid, "marca": marca, "ref": ref or None},
                       ensure_ascii=False)
    try:
        DESPACHO_MARCAS.parent.mkdir(parents=True, exist_ok=True)
        with open(DESPACHO_MARCAS, "a", encoding="utf-8") as f:
            f.write(linea + "\n")  # una línea completa en un write (§2.2)
    except OSError as e:
        return JSONResponse({"ok": False, "hint": f"no se pudo escribir la marca: {e}"},
                            status_code=500)
    return {"ok": True, "hint": f"marca {marca} registrada para {iid}"}


if __name__ == "__main__":
    puerto = int(os.environ.get("DASHBOARD_PORT", "8787"))
    uvicorn.run(app, host="127.0.0.1", port=puerto, log_level="info")
