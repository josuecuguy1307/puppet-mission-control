#!/usr/bin/env python3
"""Telegram <-> org bridge (the bot only TRANSPORTS, it does not deliberate).

DISABLED BY DEFAULT: without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (environment variables)
nothing is sent and nothing fails — the commands print a notice and exit 0. There is no default
token, chat id or name: they come only from YOUR environment (see .env.example).

Two filesystem hooks:

  intake "<order>"   IN  : turns an order into a mission draft in missions/inbox/
  outbox             OUT : sends each reports/outbox/*.{md,txt} to your chat and archives it in sent/
  send "<text>"          : sends a loose text (for tests)

Usage:
  python3 org/telegram_bridge.py intake "fix the login endpoint"
  python3 org/telegram_bridge.py outbox
  python3 org/telegram_bridge.py send "BRIDGE ONLINE"
"""
import os, sys, json, glob, shutil, urllib.request
from pathlib import Path
from datetime import datetime, timezone

ROOT     = Path(__file__).resolve().parent.parent
INBOX    = ROOT / "missions" / "inbox"
OUTBOX   = ROOT / "reports" / "outbox"
SENT     = OUTBOX / "sent"

BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
CHAT_ID   = os.environ.get("TELEGRAM_CHAT_ID", "")
TG        = f"https://api.telegram.org/bot{BOT_TOKEN}"
ENABLED   = bool(BOT_TOKEN and CHAT_ID)   # disabled (no error) when either is missing

# --- guardas del hook de misiones ---
# Allowlist: SOLO este user_id de Telegram dispara intake (por defecto, el TELEGRAM_CHAT_ID de tu entorno).
ALLOWED_USER_ID  = str(os.environ.get("TELEGRAM_ALLOWED_USER_ID", CHAT_ID))
# Trigger explícito: solo mensajes que empiezan con esto crean misiones.
MISSION_TRIGGERS = ("mision:", "misión:", "/mision")
SECLOG = ROOT / "reports" / "security.log"

_AVISO = "[bridge] Telegram disabled: set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable it (nothing was sent)."

def now_iso(): return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def tg_send(text):
    if not ENABLED:
        return False
    ok = True
    for i in range(0, len(text) or 1, 4000):
        chunk = text[i:i+4000] or " "
        data = json.dumps({"chat_id": CHAT_ID, "text": chunk}).encode()
        req = urllib.request.Request(f"{TG}/sendMessage", data=data,
                                     headers={"Content-Type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=15)
        except Exception as e:
            sys.stderr.write(f"[bridge] error enviando: {e}\n"); ok = False
    return ok

def slugify(s):
    import unicodedata
    s = unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()
    s = "".join(c if (c.isascii() and c.isalnum()) or c in " -" else "" for c in s)
    return "-".join(s.split())[:32].strip("-") or "orden"

def next_id(slug):
    today = now_iso()[:10]
    n = len(glob.glob(str(INBOX / f"{today}-*.md"))) + 1
    return f"{today}-{n:04d}-{slug}"

def make_mission(order):
    """Escribe un draft de misión en inbox y devuelve (mid, path). No delibera."""
    INBOX.mkdir(parents=True, exist_ok=True)
    mid = next_id(slugify(order))
    body = (f"---\nid: {mid}\nsquad: TBD            # lo decide el Supervisor\n"
            f"tipo: TBD             # fast-lane | ceremonia (lo decide el Supervisor)\n"
            f"spec: {json.dumps(order, ensure_ascii=False)}\n"
            f"done: TBD             # criterio de cierre (lo define el Supervisor)\n"
            f"estado: inbox\norigen: telegram\ncreada: {now_iso()}\n---\n"
            f"Orden cruda del operador (el bot solo transportó):\n{order}\n")
    p = INBOX / f"{mid}.md"
    p.write_text(body, encoding="utf-8")
    return mid, p

def cmd_intake(order):
    """IN (CLI): deja la orden como draft de misión para el Supervisor."""
    mid, p = make_mission(order)
    print(str(p))
    return 0

# ---------- hook para el bot (allowlist + trigger explícito) ----------
def security_log(uid, text):
    SECLOG.parent.mkdir(parents=True, exist_ok=True)
    with open(SECLOG, "a", encoding="utf-8") as f:
        f.write(f"{now_iso()}\tIGNORED_NON_ALLOWLISTED\tuser_id={uid}\ttext={text[:120]!r}\n")

def is_mission_trigger(text):
    t = (text or "").lstrip().lower()
    return any(t.startswith(p) for p in MISSION_TRIGGERS)

def strip_trigger(text):
    t = (text or "").lstrip()
    for p in MISSION_TRIGGERS:
        if t.lower().startswith(p):
            return t[len(p):].strip()
    return t.strip()

def mission_hook(msg, text):
    """Wiring para el handler del bot. Devuelve:
      - None  -> NO es trigger de misión; el bot sigue su charla normal (sin efectos).
      - ""    -> trigger pero user_id NO permitido; se ignoró y logueó (no responder).
      - str   -> 'misión recibida: <id>' para que el bot se lo avise al operador.
    El bot NO delibera: solo transporta el resultado de este hook."""
    if not ENABLED or not is_mission_trigger(text):
        return None                                   # desactivado o charla normal: sin side-effects
    uid = str(((msg or {}).get("from") or {}).get("id", ""))
    if not ALLOWED_USER_ID or uid != ALLOWED_USER_ID: # ALLOWLIST
        security_log(uid, text)
        return ""                                     # ignorar silenciosamente al ajeno
    order = strip_trigger(text)
    if not order:
        return "misión vacía: escribí 'mision: <qué hay que hacer>'"
    mid, _ = make_mission(order)
    return f"misión recibida: {mid}"

def cmd_outbox():
    """OUT: manda cada reporte pendiente a tu chat y lo archiva."""
    if not ENABLED:
        print(_AVISO); return 0                       # sin variables: no se envía ni se archiva nada
    OUTBOX.mkdir(parents=True, exist_ok=True); SENT.mkdir(parents=True, exist_ok=True)
    files = sorted(glob.glob(str(OUTBOX / "*.md")) + glob.glob(str(OUTBOX / "*.txt")))
    if not files:
        print("[bridge] outbox vacío"); return 0
    sent = 0
    for f in files:
        text = Path(f).read_text(encoding="utf-8")
        if tg_send(text):
            shutil.move(f, str(SENT / Path(f).name)); sent += 1
            print(f"[bridge] enviado + archivado: {Path(f).name}")
        else:
            print(f"[bridge] NO enviado (queda en outbox): {Path(f).name}")
    return 0 if sent == len(files) else 1

def cmd_send(text):
    if not ENABLED:
        print(_AVISO); return 0
    return 0 if tg_send(text) else 1

def main():
    if len(sys.argv) < 2:
        sys.stderr.write(__doc__); return 64
    cmd = sys.argv[1]
    if cmd == "intake" and len(sys.argv) >= 3: return cmd_intake(sys.argv[2])
    if cmd == "outbox": return cmd_outbox()
    if cmd == "send" and len(sys.argv) >= 3:   return cmd_send(sys.argv[2])
    sys.stderr.write("uso: intake \"<orden>\" | outbox | send \"<texto>\"\n"); return 64

if __name__ == "__main__":
    sys.exit(main())
