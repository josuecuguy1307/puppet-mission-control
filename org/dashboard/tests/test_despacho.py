"""QA del Despacho del Founder (contrato org/system/DESPACHO.md).

Misma regla dura de la suite: árbol PUPPET_ROOT temporal REAL, jamás el org
vivo. app.py no cachea nada → se pueden escribir fixtures extra DESPUÉS de
cargar el módulo y el endpoint los ve al siguiente request.
"""

import json


def _md(path, texto):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(texto, encoding="utf-8")


DOC_FYI = """# Informe de prueba FYI

## PUNTOS CLAVE
- punto uno del informe
- punto dos del informe
**Decisión que se te pide:** ninguna — FYI de prueba.

---
Cuerpo largo del informe.
"""

DOC_PIDE = """# Propuesta que pide decisión

## PUNTOS CLAVE
- la propuesta cambia X
**Decisión que se te pide:** aprobar la propuesta X o vetarla.
**Urgencia:** hoy

---
Detalle.
"""

DOC_FENCE = """# Contrato que EJEMPLIFICA el bloque (no debe aparecer)

## PUNTOS CLAVE — formato de ejemplo

```
- bullet de ejemplo dentro del fence
**Decisión que se te pide:** esto está fenced y no cuenta
```
"""

DRAFT_PENDIENTE = """---
id: 2026-06-11-P009-prueba
squad: qa
tipo: fast-lane
spec: "spec del draft de prueba"
done: "done del draft"
depends_on: []
status: ready
estado: draft
origen: mandato-test
pieza: rnd/INSTANCIA
---
Cuerpo del draft.
"""

BRIEF_PIDE = """FOUNDER-BRIEF de prueba
QUÉ:      hay que decidir algo ya
ORIGEN:   test
AVANZA:   nada
BLOQUEA:  nada
ACCIÓN:   correr el comando X (~1 min)
URGENCIA: hoy
"""

BRIEF_FYI = """FOUNDER-BRIEF informativo
QUÉ:      pasó algo lindo
ACCIÓN:   ninguna — FYI
URGENCIA: cuando puedas
"""


def _ids(items):
    return {it["id"] for it in items}


def test_despacho_zonas_basicas(arbol, cliente):
    _md(arbol / "org/artifacts/informe-fyi.md", DOC_FYI)
    _md(arbol / "org/artifacts/propuesta-pide.md", DOC_PIDE)
    _md(arbol / "org/system/mandates/drafts/P009-prueba.md", DRAFT_PENDIENTE)
    _md(arbol / "org/system/mandates/drafts/P008-viejo.md.emitted", DRAFT_PENDIENTE)
    r = cliente.get("/api/despacho")
    assert r.status_code == 200
    d = r.json()
    assert d["error"] is None

    decidir, leer = _ids(d["decidir"]), _ids(d["leer"])
    # doc con decisión pedida → DECIDIR; FYI → LEER
    assert "org/artifacts/propuesta-pide.md" in decidir
    assert "org/artifacts/informe-fyi.md" in leer
    # draft pendiente → DECIDIR con la acción descriptiva; el .emitted NO aparece
    assert "P009-prueba.md" in decidir
    assert not any("P008" in i for i in decidir | leer)
    draft = next(it for it in d["decidir"] if it["id"] == "P009-prueba.md")
    assert "P009" in draft["accion"] and "emítelo" in draft["accion"]
    # founder decision abierta → DECIDIR · brief abierto → LEER (fixture base)
    assert "decision-2026-06-10-001-test" in decidir
    assert "brief-2026-06-10-001-test" in leer
    # misiones blocked-on-founder del fixture → DECIDIR
    assert {"mision-h", "mision-k"} <= decidir
    # urgencia declarada en el bloque se respeta
    prop = next(it for it in d["decidir"] if it["id"] == "org/artifacts/propuesta-pide.md")
    assert prop["urgencia"] == "hoy"
    assert prop["puntos"] == ["la propuesta cambia X"]
    # conteos coherentes
    assert d["conteos"]["decidir"] == len(d["decidir"])
    assert d["conteos"]["leer"] == len(d["leer"])


def test_puntos_clave_fenced_no_cuenta(arbol, cliente):
    _md(arbol / "org/artifacts/contrato-fenced.md", DOC_FENCE)
    d = cliente.get("/api/despacho").json()
    todos = _ids(d["decidir"]) | _ids(d["leer"])
    assert "org/artifacts/contrato-fenced.md" not in todos
    # heading con sufijo ("— contrato...") tampoco cuenta: solo la forma exacta
    _md(arbol / "org/artifacts/heading-sufijo.md",
        "# Doc contrato\n\n## PUNTOS CLAVE — contrato de algo\n- regla\n"
        "La línea **\"Decisión que se te pide:\"** es OBLIGATORIA.\n")
    _md(arbol / "org/artifacts/heading-parentesis.md",
        "# Doc ok\n\n## PUNTOS CLAVE (para Operator)\n- punto\n"
        "**Decisión que se te pide:** ninguna — FYI.\n")
    d = cliente.get("/api/despacho").json()
    todos = _ids(d["decidir"]) | _ids(d["leer"])
    assert "org/artifacts/heading-sufijo.md" not in todos
    assert "org/artifacts/heading-parentesis.md" in _ids(d["leer"])


def test_decision_como_bullet_o_sin_bold_va_a_decidir(arbol, cliente):
    # hallazgo del review adversarial: un slip de formato no debe ESCONDER una decisión
    _md(arbol / "org/artifacts/decision-bullet.md",
        "# Doc bullet\n\n## PUNTOS CLAVE\n- contexto\n"
        "- **Decisión que se te pide:** aprobá la propuesta YA\n")
    _md(arbol / "org/artifacts/decision-sin-bold.md",
        "# Doc sin bold\n\n## PUNTOS CLAVE\n- contexto\n"
        "Decisión que se te pide: aprobá el deploy\n")
    _md(arbol / "org/artifacts/fyi-bold-anidado.md",
        "# FYI raro\n\n## PUNTOS CLAVE\n- contexto\n"
        "**Decisión que se te pide:** **ninguna** — FYI\n")
    d = cliente.get("/api/despacho").json()
    decidir, leer = _ids(d["decidir"]), _ids(d["leer"])
    assert "org/artifacts/decision-bullet.md" in decidir
    assert "org/artifacts/decision-sin-bold.md" in decidir
    assert "org/artifacts/fyi-bold-anidado.md" in leer


def test_marcar_lifecycle(arbol, cliente):
    _md(arbol / "org/artifacts/informe-fyi.md", DOC_FYI)
    iid = "org/artifacts/informe-fyi.md"
    # sin marca → sin-leer
    d = cliente.get("/api/despacho").json()
    item = next(it for it in d["leer"] if it["id"] == iid)
    assert item["estado"] == "sin-leer"
    # marcar leído
    r = cliente.post("/api/despacho/marcar", json={"id": iid, "marca": "leido"})
    assert r.status_code == 200 and r.json()["ok"] is True
    d = cliente.get("/api/despacho").json()
    item = next(it for it in d["leer"] if it["id"] == iid)
    assert item["estado"] == "leido"
    # sello decidido → sale de la bandeja y entra al histórico
    r = cliente.post("/api/despacho/marcar",
                     json={"id": iid, "marca": "decidido", "ref": "prueba"})
    assert r.status_code == 200 and r.json()["ok"] is True
    d = cliente.get("/api/despacho").json()
    assert iid not in _ids(d["leer"]) | _ids(d["decidir"])
    sellos = [e for e in d["decidido"] if e["fuente"] == "sello" and e["ref"] == iid]
    assert sellos and sellos[0]["quien"] == "Operator" and sellos[0]["porque"] == "prueba"
    # el archivo de marcas es jsonl append-only de líneas completas
    lineas = (arbol / "org/founder/despacho-marcas.jsonl").read_text(encoding="utf-8")
    assert lineas.endswith("\n") and len(lineas.strip().splitlines()) == 2


def test_marcar_guards(arbol, cliente):
    r = cliente.post("/api/despacho/marcar", json={"id": "x.md", "marca": "archivado"})
    assert r.status_code == 400
    r = cliente.post("/api/despacho/marcar", json={"id": "../../etc/passwd", "marca": "leido"})
    assert r.status_code == 400
    # id válido en forma pero INEXISTENTE en las bandejas → 400 (anti pre-supresión)
    r = cliente.post("/api/despacho/marcar",
                     json={"id": "org/artifacts/futuro.md", "marca": "decidido"})
    assert r.status_code == 400
    assert "ningún item actual" in r.json()["hint"]
    # CSRF: content-type no-json → 403 + security.log
    r = cliente.post("/api/despacho/marcar", content=b"x",
                     headers={"Content-Type": "text/plain"})
    assert r.status_code == 403
    log = (arbol / "reports/security.log").read_text(encoding="utf-8")
    assert "CSRF_RECHAZADO" in log and "DESPACHO_ID_INEXISTENTE" in log
    assert not (arbol / "org/founder/despacho-marcas.jsonl").exists()


def test_drafts_basura_no_aparecen(arbol, cliente):
    _md(arbol / "org/system/mandates/drafts/basura-sin-numero.md", "no soy un draft\n")
    _md(arbol / "org/system/mandates/drafts/P009-prueba.md", DRAFT_PENDIENTE)
    d = cliente.get("/api/despacho").json()
    decidir = _ids(d["decidir"])
    assert "P009-prueba.md" in decidir and "basura-sin-numero.md" not in decidir


def test_decidido_parsea_decisions_md(arbol, cliente):
    _md(arbol / "org/DECISIONS.md",
        "# DECISIONS\n\n## Fase de prueba\n"
        "- 2026-06-11 · Operator · **Decisión de prueba** · porque sí.\n"
        "- 2026-06-10 · Supervisor · Otra cosa del org · razones.\n")
    d = cliente.get("/api/despacho").json()
    jos = [e for e in d["decidido"] if e["quien"] == "Operator" and e["fuente"] == "DECISIONS"]
    assert jos and jos[0]["decision"] == "Decisión de prueba"
    assert jos[0]["porque"] == "porque sí." and jos[0]["fase"] == "Fase de prueba"
    # orden: más reciente primero
    assert d["decidido"][0]["fecha"] >= d["decidido"][-1]["fecha"]


def test_outbox_brief_en_transito(arbol, cliente):
    _md(arbol / "reports/outbox/brief-pide.md", BRIEF_PIDE)
    _md(arbol / "reports/outbox/brief-fyi.txt", BRIEF_FYI)
    d = cliente.get("/api/despacho").json()
    pide = next(it for it in d["decidir"] if it["id"] == "outbox/brief-pide.md")
    assert pide["urgencia"] == "hoy" and "comando X" in pide["accion"]
    fyi = next(it for it in d["leer"] if it["id"] == "outbox/brief-fyi.txt")
    assert fyi["decision_pedida"] is None


def test_biblioteca_extrae_recursos(arbol, cliente):
    _md(arbol / "org/artifacts/con-links.md",
        "# Doc con links\n**Squad:** QA · algo\n**Misión:** 2026-06-11-0042-prueba\n\n"
        "- [server bueno](https://github.com/x/y) — verificado 2026-06-11\n"
        "- suelto https://example.com/recurso para datos\n")
    r = cliente.get("/api/despacho/biblioteca")
    assert r.status_code == 200
    b = r.json()
    doc = next(x for x in b["docs"] if x["path"] == "org/artifacts/con-links.md")
    assert doc["squad"].startswith("QA") and doc["mision"] == "2026-06-11-0042-prueba"
    urls = {rec["url"] for rec in doc["recursos"]}
    assert "https://github.com/x/y" in urls and "https://example.com/recurso" in urls
    gh = next(rec for rec in doc["recursos"] if rec["url"] == "https://github.com/x/y")
    assert gh["dominio"] == "github.com" and gh["verificado"] is True
    assert any(x["dominio"] == "github.com" for x in b["dominios"])


def test_doc_guard_acepta_org_system(arbol, cliente):
    _md(arbol / "org/system/DOC-SISTEMA.md", "# Doc de sistema\ncontenido.\n")
    r = cliente.get("/api/doc", params={"path": "org/system/DOC-SISTEMA.md"})
    assert r.status_code == 200 and "contenido" in r.json()["body"]
    # fuera de los prefijos sigue 403
    _md(arbol / "org/dashboard/secreto.md", "no.\n")
    assert cliente.get("/api/doc", params={"path": "org/dashboard/secreto.md"}).status_code == 403


def test_despacho_sobre_org_vacio(cliente_vacio):
    r = cliente_vacio.get("/api/despacho")
    assert r.status_code == 200
    d = r.json()
    assert d["decidir"] == [] and d["leer"] == [] and d["decidido"] == []
    assert d["error"] and "sin datos" in d["error"]
    r = cliente_vacio.get("/api/despacho/biblioteca")
    assert r.status_code == 200 and "sin datos" in r.json()["error"]
    # árbol vacío no tiene items → marcar cualquier id da 400 (sin crashear)
    r = cliente_vacio.post("/api/despacho/marcar", json={"id": "x.md", "marca": "leido"})
    assert r.status_code == 400 and r.json()["ok"] is False
