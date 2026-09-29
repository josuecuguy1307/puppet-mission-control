"""QA mínimo del backend v3 (SPEC §6) — corre contra PUPPET_ROOT temporal."""

import asyncio
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[3]  # raíz puppet-ai (solo LECTURA acá)


# ---------- contratos GET — org con datos ----------

def test_squads_contrato_v2(cliente):
    r = cliente.get("/api/squads")
    assert r.status_code == 200
    data = r.json()
    assert data["error"] is None and data["total"] == 3
    backend = next(s for s in data["squads"] if s["slug"] == "backend")
    assert backend["estado"] == "working"
    assert "mision-b" in backend["misiones_processing"]
    assert backend["mision_activa"]["id"] in ("mision-b", "mision-k")


def test_missions_contrato_y_tabla(cliente):
    data = cliente.get("/api/missions").json()
    assert data["error"] is None
    por_id = {m["id"]: m for m in data["missions"]}
    # campos v2 intactos + nuevos aditivos
    m = por_id["mision-b"]
    for k in ("id", "id_corto", "squad", "tipo", "lane", "depends_on", "espera_a",
              "status", "status_calc", "artifact", "titulo", "spec", "carpeta",
              "mtime", "ts_evento", "agente", "agentes", "espera_founder", "error"):
        assert k in m
    # TABLA NORMATIVA §2.6 en orden
    assert por_id["mision-a"]["status_calc"] == "completed"
    assert por_id["mision-b"]["status_calc"] == "processing"
    assert por_id["mision-c"]["status_calc"] == "blocked"
    assert por_id["mision-e"]["status_calc"] == "roto"
    assert por_id["mision-f"]["status_calc"] == "ciclo"
    assert por_id["mision-g"]["status_calc"] == "ciclo"
    assert por_id["mision-h"]["status_calc"] == "blocked-on-founder"
    assert por_id["mision-i"]["status_calc"] == "founder-roto"
    assert por_id["mision-j"]["status_calc"] == "ready"
    # blocked-on-founder aplica TAMBIÉN en processing (fila 3 antes que la 4)
    assert por_id["mision-k"]["status_calc"] == "blocked-on-founder"


def test_feed_contrato_v2(cliente):
    data = cliente.get("/api/feed").json()
    assert {"eventos", "total", "ultimo_ts"} <= set(data)
    assert any(e["tipo"] == "mision" for e in data["eventos"])


def test_index_sirve_html(cliente):
    r = cliente.get("/")
    assert r.status_code == 200 and "fixture" in r.text


# ---------- /api/agents — el join ----------

def test_agents_join(cliente):
    data = cliente.get("/api/agents").json()
    assert data["error"] is None
    por_clave = {(a["agente"], a["squad"]): a for a in data["agentes"]}
    ctor = por_clave[("eng-backend-constructor", "backend")]
    assert ctor["tier"] == "sonnet" and ctor["compartido"] is False
    assert ctor["estado_agente"] == "activo" and ctor["model_override"] is None
    assert "Bash" in ctor["tools"] and "code-review-skill" in ctor["skills"]
    assert ctor["mision_actual"]["id"] == "mision-b"
    st = ctor["stats"]
    assert st["runs"] == 2 and st["tokens_in"] == 110 and st["tokens_out"] == 55
    assert st["completadas"] == 1 and st["aprobados"] == 1  # línea sin \n IGNORADA
    assert st["tasa_aprobacion"] == 1.0
    assert st["xp"] == 15 and st["nivel"] == 2  # 10*1 + 5*1; 1+floor(sqrt(1.5))
    # SCHEDULER-V2 no existe → SIEMPRE null
    assert st["latencia_media"] is None and st["intentos"] is None
    qa = por_clave[("eng-qa-constructor", "qa")]
    assert qa["estado_agente"] == "pausado" and qa["model_override"] == "opus"
    assert qa["tier"] == "opus"  # el override manda en la tabla alias→tier
    assert qa["stats"]["rechazados"] == 1 and qa["stats"]["tasa_aprobacion"] == 0.0
    assert qa["mision_actual"] is None  # mision-c (agentes: plural) está en inbox
    lead = por_clave[("squad-lead", "backend")]
    assert lead["compartido"] is True and lead["tier"] == "opus"
    # asiento con agente: null (Supervisor) NO aparece
    assert ("None", "security") not in por_clave
    assert all(a["agente"] for a in data["agentes"])


def test_agents_plural_cuenta_en_processing(cliente, arbol):
    # mover mision-c (agentes: [eng-qa-constructor]) a processing → mision_actual
    src = arbol / "missions/inbox/mision-c.md"
    dst = arbol / "missions/processing/mision-c.md"
    shutil.move(str(src), str(dst))
    data = cliente.get("/api/agents").json()
    qa = next(a for a in data["agentes"] if a["agente"] == "eng-qa-constructor")
    assert qa["mision_actual"]["id"] == "mision-c"


# ---------- /api/armory — catálogo canónico ----------

def test_armory_algoritmo(cliente):
    data = cliente.get("/api/armory").json()
    assert data["error"] is None
    por_id = {i["id"]: i for i in data["items"]}
    # (1) unión exacta de tools:/skills: de los 6 frontmatters del fixture
    for t in ("Read", "Edit", "Write", "Bash", "Grep", "Glob"):
        assert por_id[t]["clase"] == "tool" and por_id[t]["equipable"] is True
    assert por_id["code-review-skill"]["clase"] == "skill"
    assert por_id["webapp-testing"]["clase"] == "skill"
    # (2) dedupe contra .mcp.json: github exacto, context7 por alias, exa nuevo
    gh = por_id["mcp__github"]
    assert gh["clase"] == "mcp" and ".mcp.json" in gh["origen"] and "frontmatter" in gh["origen"]
    c7 = por_id["mcp__claude_ai_Context7"]  # id canónico = string EXACTO del frontmatter
    assert "mcp__context7" in c7["aliases"]
    assert "mcp__context7" not in por_id  # deduplicado: un solo item
    assert por_id["mcp__exa"]["origen"] == ".mcp.json" and por_id["mcp__exa"]["equipable"] is True
    # (3) belt: mcp-pandoc informativo no-equipable; mcp__exa NO se duplica
    pandoc = por_id["mcp-pandoc"]
    assert pandoc["clase"] == "belt-mcp" and pandoc["equipable"] is False
    assert data["belts"][0]["belt"] == "test-belt" and "mcp-pandoc" in data["belts"][0]["items"]
    # sensibles: Bash/Write/Edit y mcp de escritura (github); lectura no
    assert por_id["Bash"]["sensible"] and por_id["Write"]["sensible"] and por_id["Edit"]["sensible"]
    assert por_id["mcp__github"]["sensible"] is True
    assert por_id["mcp__exa"]["sensible"] is False
    # equipado_por con squad real
    assert {"agente": "eng-backend-constructor", "squad": "backend"} in por_id["Edit"]["equipado_por"]
    # conteo == fuentes reales: 6 tools + 3 mcp + 3 skills + 1 belt-mcp
    assert len([i for i in data["items"] if i["clase"] == "tool"]) == 6
    assert len([i for i in data["items"] if i["clase"] == "mcp"]) == 3
    assert len([i for i in data["items"] if i["clase"] == "belt-mcp"]) == 1


def test_equipar_tool_conserva_formato_regex(arbol):
    """Tras una edición TEXTUAL de la línea tools:, la regex de lectura de agentes
    (`tools:\\s*\\[(.*?)\\]`) sigue parseando el frontmatter del agente."""
    p = arbol / ".claude/agents/eng-qa-constructor.md"
    texto = p.read_text(encoding="utf-8")
    nuevo = re.sub(r"(tools:\s*\[[^\]]*)\]", r"\1, mcp__exa]", texto, count=1)
    p.write_text(nuevo, encoding="utf-8")
    m = re.search(r"tools:\s*\[(.*?)\]", p.read_text(encoding="utf-8"))
    assert m is not None
    tools = [t.strip() for t in m.group(1).split(",")]
    assert "mcp__exa" in tools and "Read" in tools and "Bash" in tools


# ---------- /api/dag — tabla §2.6 + camino crítico ----------

def test_dag_nodos_aristas_camino(cliente):
    data = cliente.get("/api/dag").json()
    assert data["error"] is None
    por_id = {n["id"]: n for n in data["nodos"]}
    assert por_id["mision-h"]["status_calc"] == "blocked-on-founder"
    assert por_id["mision-i"]["status_calc"] == "founder-roto"
    assert por_id["mision-f"]["status_calc"] == "ciclo"
    assert ["mision-a", "mision-b"] in data["aristas"]  # a depende de de; flecha de→a
    # camino crítico = cadena más larga NO completed, SIN nodos en ciclo, sin colgarse
    assert data["camino_critico"] == ["mision-b", "mision-c", "mision-d"]
    assert "mision-f" not in data["camino_critico"] and "mision-g" not in data["camino_critico"]
    assert "mision-a" not in data["camino_critico"]  # completed excluido


def test_dag_nunca_cuelga_con_ciclo_total(tmp_path):
    """Fixture donde TODO es ciclo: /api/dag responde y camino_critico = []."""
    from conftest import cargar_app, _md, _mision
    base = tmp_path / "solo-ciclos"
    _md(base / "missions/inbox/x.md", _mision("x", "qa", ["y"]))
    _md(base / "missions/inbox/y.md", _mision("y", "qa", ["x"]))
    from fastapi.testclient import TestClient
    cli = TestClient(cargar_app(base).app, base_url="http://localhost")
    data = cli.get("/api/dag").json()
    assert data["camino_critico"] == []
    assert {n["status_calc"] for n in data["nodos"]} == {"ciclo"}


def test_dag_coincide_con_pipeline(arbol):
    """pipeline.py y /api/dag sobre el MISMO fixture deben coincidir (§2.6).
    Se copia pipeline.py DENTRO del fixture: deriva su ROOT de __file__ (y honra
    PUPPET_ROOT cuando ORG lo agregue) — jamás toca el org vivo."""
    src = REPO / "org" / "pipeline.py"
    if not src.is_file():
        pytest.skip("org/pipeline.py no existe en el repo")
    dst = arbol / "org" / "pipeline.py"
    shutil.copy(str(src), str(dst))
    env = {"PUPPET_ROOT": str(arbol), "PATH": "/usr/bin:/bin:/usr/local/bin"}
    res = subprocess.run([sys.executable, str(dst)], capture_output=True, text=True,
                         env=env, timeout=60)
    assert res.returncode == 0, res.stderr
    from conftest import cargar_app
    from fastapi.testclient import TestClient
    cli = TestClient(cargar_app(arbol).app, base_url="http://localhost")
    data = cli.get("/api/dag").json()
    for n in data["nodos"]:
        if n["carpeta"] != "inbox":
            continue
        p = arbol / "missions/inbox" / f"{n['id']}.md"
        m = re.search(r"^status:\s*(\S+)", p.read_text(encoding="utf-8"), re.M)
        if not m:
            continue  # pipeline no escribió status para esta misión
        escrito = m.group(1).strip()
        # el status: del frontmatter coherente con la carpeta es fuente primaria
        assert n["status_calc"] == escrito, f"{n['id']}: dag={n['status_calc']} pipeline={escrito}"


# ---------- founder / library / doc / agent-log — guards ----------

def test_founder_lista_y_conteos(cliente):
    data = cliente.get("/api/founder").json()
    assert data["error"] is None and data["total"] == 2
    assert data["conteos"] == {"decision": 1, "brief": 1}
    assert data["chats"]["backend"][0]["texto"] == "hola lead"


def test_founder_item_con_doc(cliente):
    data = cliente.get("/api/founder/item", params={"id": "decision-2026-06-10-001-test"}).json()
    assert data["error"] is None and data["item"]["estado"] == "abierto"
    assert "palabra-magica" in data["doc_body"]  # doc: pasó el guard de /api/doc
    assert "<script>" in data["item"]["titulo"]  # el API devuelve crudo; escapa el front


def test_founder_item_guards(cliente):
    assert cliente.get("/api/founder/item", params={"id": "../../etc/passwd"}).status_code == 403
    assert cliente.get("/api/founder/item", params={"id": "MAYUSCULAS"}).status_code == 403
    data = cliente.get("/api/founder/item", params={"id": "no-existe"}).json()
    assert data["item"] is None and "sin datos" in data["error"]


def test_founder_item_doc_fuera_de_guard(cliente, arbol):
    p = arbol / "org/founder/decisiones/decision-2026-06-10-002-mala.md"
    p.write_text("---\nid: decision-2026-06-10-002-mala\ntipo: decision\nestado: abierto\n"
                 "titulo: x\ndoc: ../../etc/passwd\n---\ncuerpo\n", encoding="utf-8")
    data = cliente.get("/api/founder/item", params={"id": "decision-2026-06-10-002-mala"}).json()
    assert data["doc_body"] is None and data["nota"] is not None


def test_library(cliente):
    data = cliente.get("/api/library", params={"q": "palabra-magica"}).json()
    assert data["total"] == 1 and data["items"][0]["path"] == "org/artifacts/doc-prueba.md"
    todo = cliente.get("/api/library").json()
    rutas = [i["path"] for i in todo["items"]]
    assert "org/artifacts/sub/otro.md" in rutas and "reports/retro-test.md" in rutas
    assert "org/founder/briefs/brief-2026-06-10-001-test.md" in rutas
    assert not any(r.endswith(".log") for r in rutas)


def test_doc_guards(cliente):
    ok = cliente.get("/api/doc", params={"path": "org/artifacts/doc-prueba.md"})
    assert ok.status_code == 200 and "palabra-magica" in ok.json()["body"]
    ok2 = cliente.get("/api/doc", params={"path": "missions/inbox/mision-c.md"})
    assert ok2.status_code == 200
    for malo in ("../../etc/passwd", "/etc/passwd", "reports/security.log",
                 "org/dashboard/squads.json", "org/state/agents.json",
                 "org/artifacts/../../.claude/agents/reviewer.md", "CLAUDE.md"):
        assert cliente.get("/api/doc", params={"path": malo}).status_code == 403, malo


def test_agent_log(cliente):
    data = cliente.get("/api/agent-log", params={"agente": "eng-backend-constructor"}).json()
    assert len(data["usage"]) == 2 and data["mision_actual"]["id"] == "mision-b"
    assert any(e.get("verdict") == "aprobado" for e in data["eventos"])
    assert cliente.get("/api/agent-log", params={"agente": "../etc"}).status_code == 403
    assert cliente.get("/api/agent-log", params={"agente": "no-existe"}).status_code == 403


# ---------- metrics / state ----------

def test_metrics_etiquetado_honesto(cliente):
    data = cliente.get("/api/metrics").json()
    assert data["nota"] == "actividad_gateway NO registra la lane tools (Agent tool)"
    assert data["inbox_actual"] == 8  # c,d,e,f,g,h,i,j
    assert data["rechazos"] == {"qa": 1}
    serie = data["actividad_gateway"]["backend"]  # 2 corridas recientes del fixture
    assert sum(p["n"] for p in serie) == 2 and all({"t", "n"} <= set(p) for p in serie)
    assert isinstance(data["idle_horas"]["backend"], (int, float))
    assert data["idle_horas"]["security"] is None  # squad sin actividad → sin datos


def test_state_digest(cliente):
    data = cliente.get("/api/state").json()
    assert data["paused"] is None
    assert data["agentes"]["eng-qa-constructor"]["estado"] == "pausado"
    d = data["digest"]
    assert d["completadas_hoy"] == 1 and d["processing"] == 2
    assert d["esperan_founder"] == 2  # mision-h (inbox) + mision-k (processing)
    ids_briefs = {b["id"] for b in d["top_briefs"]}
    assert "brief-2026-06-10-001-test" in ids_briefs and len(d["top_briefs"]) <= 3


# ---------- contratos GET — org VACÍO (regla de oro: nunca crashear) ----------

def test_todo_get_sobre_org_vacio(cliente_vacio):
    assert cliente_vacio.get("/api/squads").json()["error"].startswith("sin datos")
    assert cliente_vacio.get("/api/missions").json() == {
        "missions": [], "total": 0, "error": "sin datos (missions/ no existe)"}
    assert cliente_vacio.get("/api/feed").json()["total"] == 0
    ag = cliente_vacio.get("/api/agents").json()
    assert ag["agentes"] == [] and "sin datos" in ag["error"]
    ar = cliente_vacio.get("/api/armory").json()
    assert ar["items"] == [] and "sin datos" in ar["error"]
    dag = cliente_vacio.get("/api/dag").json()
    assert dag["nodos"] == [] and dag["camino_critico"] == []
    fo = cliente_vacio.get("/api/founder").json()
    assert fo["items"] == [] and "sin datos" in fo["error"]
    li = cliente_vacio.get("/api/library").json()
    assert li["items"] == [] and "sin datos" in li["error"]
    me = cliente_vacio.get("/api/metrics").json()
    assert me["actividad_gateway"] == {} and me["inbox_actual"] == 0
    st = cliente_vacio.get("/api/state").json()
    assert st["paused"] is None and st["digest"]["completadas_hoy"] == 0
    assert "sin datos" in cliente_vacio.get("/").json()["error"]


def test_alarm_token_creado_al_arranque(mod, arbol):
    """Escritura (f): .alarm-token generado SOLO si no existe, chmod 600."""
    p = arbol / "org/dashboard/.alarm-token"
    assert p.is_file() and p.read_text().strip()
    assert (p.stat().st_mode & 0o777) == 0o600


# ---------- POST /api/command ----------

def test_command_valido_crea_draft(cliente, arbol):
    r = cliente.post("/api/command", json={
        "tipo": "reasignar_modelo",
        "payload": {"agente": "eng-qa-constructor", "squad": "qa", "modelo_nuevo": "sonnet"}})
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] and data["id"].startswith("cmd-") and "Supervisor" in data["hint"]
    archivos = list((arbol / "missions/inbox/commands").glob("cmd-*-reasignar_modelo.json"))
    assert len(archivos) == 1
    draft = json.loads(archivos[0].read_text(encoding="utf-8"))
    assert draft["user_id"] == "operator"  # sellado por el server
    assert draft["origen"] == "dashboard" and draft["status"] == "draft"
    assert draft["payload"]["modelo_nuevo"] == "sonnet"


def test_command_todos_los_tipos(cliente, arbol):
    casos = [
        ("nudge", {"agente": "eng-qa-constructor", "squad": "qa", "mensaje": "dale"}),
        ("pausar_agente", {"agente": "eng-qa-constructor", "squad": "qa", "motivo": "x"}),
        ("reanudar_agente", {"agente": "eng-qa-constructor", "squad": "qa"}),
        ("equipar_tool", {"agente": "eng-qa-constructor", "tool": "mcp__exa"}),
        ("desequipar_tool", {"agente": "eng-qa-constructor", "tool": "Bash"}),
        ("asignar_mision", {"mision": "mision-j", "squad": "qa"}),
        ("responder_decision", {"item": "decision-2026-06-10-001-test", "opcion": "canvas"}),
        ("responder_pregunta", {"item": "pregunta-x", "respuesta": "si"}),
        ("feedback_brief", {"item": "brief-2026-06-10-001-test", "feedback": "ok"}),
        ("mensaje_lead", {"squad": "backend", "texto": "hola"}),
        ("reanudar_org", {}),
    ]
    for tipo, payload in casos:
        r = cliente.post("/api/command", json={"tipo": tipo, "payload": payload})
        assert r.status_code == 200 and r.json()["ok"], (tipo, r.text)
    assert len(list((arbol / "missions/inbox/commands").glob("*.json"))) == len(casos)


def test_command_invalidos(cliente):
    assert cliente.post("/api/command", json={"tipo": "borrar_todo", "payload": {}}).status_code == 400
    assert cliente.post("/api/command", json={"tipo": "nudge", "payload": {"agente": "a"}}).status_code == 400
    r = cliente.post("/api/command", json={
        "tipo": "nudge", "payload": {"agente": "x; rm -rf /", "squad": "qa", "mensaje": "h"}})
    assert r.status_code == 400 and "inválido" in r.json()["hint"]
    r = cliente.post("/api/command", json={
        "tipo": "reasignar_modelo",
        "payload": {"agente": "a", "squad": "qa", "modelo_nuevo": "gpt-5"}})
    assert r.status_code == 400 and "tabla de tiers" in r.json()["hint"]
    r = cliente.post("/api/command", json={
        "tipo": "nudge", "payload": {"agente": "a", "squad": "qa", "mensaje": "x" * 501}})
    assert r.status_code == 400
    r = cliente.post("/api/command", json={
        "tipo": "nudge", "payload": {"agente": "a", "squad": "qa", "mensaje": "h", "extra": "no"}})
    assert r.status_code == 400


def test_command_rate_limit(cliente, arbol):
    payload = {"tipo": "reanudar_org", "payload": {}}
    for _ in range(30):
        assert cliente.post("/api/command", json=payload).status_code == 200
    r = cliente.post("/api/command", json=payload)
    assert r.status_code == 429
    assert "RATE_LIMIT" in (arbol / "reports/security.log").read_text(encoding="utf-8")


# ---------- CSRF (§0.6) ----------

def test_csrf_origin_malo(cliente, arbol):
    for ep in ("/api/command", "/api/firealarm", "/api/intake"):
        r = cliente.post(ep, json={"tipo": "reanudar_org", "payload": {}},
                         headers={"Origin": "http://evil.com"})
        assert r.status_code == 403, ep
    assert "CSRF_RECHAZADO" in (arbol / "reports/security.log").read_text(encoding="utf-8")


def test_csrf_content_type_texto(cliente):
    r = cliente.post("/api/command", content=b"tipo=nudge",
                     headers={"Content-Type": "text/plain"})
    assert r.status_code == 403


def test_csrf_origin_localhost_pasa(cliente):
    r = cliente.post("/api/command", json={"tipo": "reanudar_org", "payload": {}},
                     headers={"Origin": "http://localhost:8787"})
    assert r.status_code == 200 and r.json()["ok"]


# ---------- POST /api/firealarm ----------

def test_firealarm_flujo(cliente, arbol):
    seclog = arbol / "reports/security.log"
    assert cliente.post("/api/firealarm", json={"confirmar": True}).status_code == 403
    r = cliente.post("/api/firealarm", json={"token": "incorrecto", "confirmar": True})
    assert r.status_code == 403
    assert "FIREALARM_TOKEN_INVALIDO" in seclog.read_text(encoding="utf-8")
    token = (arbol / "org/dashboard/.alarm-token").read_text(encoding="utf-8").strip()
    assert cliente.post("/api/firealarm", json={"token": token}).status_code == 400  # sin confirmar
    r = cliente.post("/api/firealarm", json={"token": token, "confirmar": True})
    assert r.status_code == 200 and r.json()["ok"]
    # (c) PAUSED creado
    paused = json.loads((arbol / "org/PAUSED").read_text(encoding="utf-8"))
    assert paused["por"] == "operator" and paused["ts"]
    # (d) evento pausa_org appendeado, línea completa con \n
    evlog = (arbol / "org/events/events.jsonl").read_text(encoding="utf-8")
    assert '"tipo": "pausa_org"' in evlog or '"tipo":"pausa_org"' in evlog
    assert evlog.endswith("\n")
    # (e) alerta nueva en outbox
    alertas = list((arbol / "reports/outbox").glob("alerta-pausa-*.txt"))
    assert len(alertas) == 1 and "PAUSADO" in alertas[0].read_text(encoding="utf-8")
    # /api/state refleja la pausa
    assert cliente.get("/api/state").json()["paused"]["por"] == "operator"
    # re-alarma con PAUSED existente: ok pero JAMÁS pisa el archivo
    antes = (arbol / "org/PAUSED").read_text(encoding="utf-8")
    assert cliente.post("/api/firealarm", json={"token": token, "confirmar": True}).status_code == 200
    assert (arbol / "org/PAUSED").read_text(encoding="utf-8") == antes


def test_firealarm_rate_limit(cliente):
    for _ in range(5):
        cliente.post("/api/firealarm", json={"token": "x", "confirmar": True})
    r = cliente.post("/api/firealarm", json={"token": "x", "confirmar": True})
    assert r.status_code == 429


def test_firealarm_token_regenerado_si_falta(cliente, arbol):
    p = arbol / "org/dashboard/.alarm-token"
    viejo = p.read_text(encoding="utf-8").strip()
    p.unlink()
    r = cliente.post("/api/firealarm", json={"token": viejo, "confirmar": True})
    assert r.status_code == 403  # se regeneró: el viejo ya no vale
    assert p.is_file() and p.read_text(encoding="utf-8").strip() != viejo


def test_no_hay_endpoint_de_despausa(cliente):
    """La des-pausa NO va por HTTP: se borra org/PAUSED a mano."""
    assert cliente.get("/api/firealarm").status_code == 405
    assert cliente.delete("/api/firealarm").status_code == 405
    for ruta in ("/api/resume", "/api/unpause", "/api/firealarm/off", "/api/reanudar"):
        assert cliente.post(ruta, json={}).status_code == 404, ruta


# ---------- /api/intake (contrato v2) ----------

def test_intake_contrato_v2(cliente, arbol):
    r = cliente.post("/api/intake", json={"texto": "hola, ¿cómo va todo?"})
    assert r.status_code == 200 and r.json()["ok"] is False
    r = cliente.post("/api/intake", json={"texto": "mision: probar el composer del dashboard"})
    data = r.json()
    assert data["ok"] and data["id"]
    draft = arbol / "missions" / "inbox" / f"{data['id']}.md"
    texto = draft.read_text(encoding="utf-8")
    assert "origen: dashboard" in texto and "probar el composer" in texto


# ---------- SSE ----------

def test_sse_hello_inmediato(mod):
    """El PRIMER frame del generador SSE es {"tipo":"hello"}, sin esperar al loop.
    Se consume el generador por-conexión directo (los transports de test bufferean
    respuestas infinitas); wait_for corto garantiza el "inmediato"."""
    from starlette.requests import Request

    async def primer_frame():
        async def receive():
            await asyncio.sleep(3600)  # conexión que nunca manda nada
        scope = {"type": "http", "method": "GET", "path": "/api/stream",
                 "headers": [], "query_string": b""}
        resp = await mod.api_stream(Request(scope, receive))
        assert resp.media_type == "text/event-stream"
        gen = resp.body_iterator
        try:
            return await gen.__anext__()
        finally:
            await gen.aclose()

    frame = asyncio.run(asyncio.wait_for(primer_frame(), timeout=3))
    assert frame.startswith("data:")
    assert json.loads(frame[len("data:"):].strip()) == {"tipo": "hello"}


# ---------- XSS: el API devuelve crudo; escapa el FRONT ----------

def test_xss_api_devuelve_crudo(cliente):
    misiones = cliente.get("/api/missions").json()["missions"]
    c = next(m for m in misiones if m["id"] == "mision-c")
    assert "<script>alert(1)</script>" in c["titulo"]
    items = cliente.get("/api/founder").json()["items"]
    dec = next(i for i in items if i["tipo"] == "decision")
    assert "<script>" in dec["titulo"]


CAMPOS_CONTENIDO_RE = re.compile(
    r"\.\s*(titulo|texto|spec|detalle|body|snippet|mensaje|hint|error|feedback|"
    r"respuesta|default|nombre|doc_body|nota)\b")


def test_front_sin_innerhtml_de_contenido_crudo():
    """Grep estático (§6): en views/panels/data, toda SENTENCIA innerHTML que
    interpole campos de contenido crudo (.titulo/.texto/.spec/…) debe pasar por
    esc() en esa línea. Es grep, no flow-analysis: el fixture XSS de la API +
    la verificación E2E del integrador cubren el resto."""
    js_dir = REPO / "org" / "dashboard" / "static" / "js"
    objetivos = [js_dir / "views.js", js_dir / "data.js"] + sorted(js_dir.glob("panels/*.js"))
    objetivos = [p for p in objetivos if p.is_file()]
    if not objetivos:
        pytest.skip("F-PANELS aún no entregó static/js/ (paquete paralelo)")
    violaciones = []
    for p in objetivos:
        lineas = p.read_text(encoding="utf-8").splitlines()
        for i, linea in enumerate(lineas):
            if ".innerHTML" not in linea:
                continue
            bloque = []  # la sentencia completa: hasta la línea que cierra con `;`
            for j in range(i, min(i + 30, len(lineas))):
                bloque.append((j + 1, lineas[j]))
                if lineas[j].rstrip().endswith(";") or lineas[j].rstrip().endswith("}"):
                    break
            for nro, ln in bloque:
                if "${" in ln and CAMPOS_CONTENIDO_RE.search(ln) and "esc(" not in ln:
                    violaciones.append(f"{p.name}:{nro}: {ln.strip()[:100]}")
    assert not violaciones, "innerHTML con contenido crudo:\n" + "\n".join(violaciones)
