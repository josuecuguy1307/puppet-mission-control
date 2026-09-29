"""Fixtures de QA del dashboard v3 (SPEC §6).

REGLA DURA: los tests corren SIEMPRE contra un árbol PUPPET_ROOT temporal REAL
(archivos de fixture de verdad) — jamás contra el org vivo. Cada test recarga
app.py con su propio módulo (estado de rate-limit y rutas frescos por test).
"""

import importlib.util
import itertools
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

APP_PATH = Path(__file__).resolve().parent.parent / "app.py"
_contador = itertools.count()


def cargar_app(root: Path):
    """Carga app.py como módulo FRESCO con PUPPET_ROOT=root (árbol temporal)."""
    os.environ["PUPPET_ROOT"] = str(root)
    nombre = f"app_dashboard_bajo_test_{next(_contador)}"
    spec = importlib.util.spec_from_file_location(nombre, APP_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[nombre] = mod
    spec.loader.exec_module(mod)
    return mod


def _md(path: Path, texto: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(texto, encoding="utf-8")


def _mision(mid, squad="backend", deps=(), extra="", titulo=None):
    deps_s = "[" + ", ".join(deps) + "]"
    titulo = titulo or f"Misión {mid}"
    return (f"---\nid: {mid}\nsquad: {squad}\ntipo: fast-lane\n"
            f"spec: \"spec de {mid}\"\ndone: \"done de {mid}\"\n"
            f"depends_on: {deps_s}\n{extra}estado: x\norigen: terminal\n---\n{titulo}\n")


def _agente_md(nombre, tools, skills, gateway="constructor-code", native="sonnet"):
    return (f"---\nname: {nombre}\ndescription: fixture\n"
            f"model_gateway: {gateway}\nmodel_native: {native}\n"
            f"tools: [{', '.join(tools)}]\nskills: [{', '.join(skills)}]\n---\nCuerpo.\n")


def armar_arbol(base: Path):
    """Árbol temporal REAL con todos los formatos del org (SPEC §2)."""
    ahora = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # --- squads.json con campo agente: por asiento (tabla §3) ---
    squads = [
        {"slug": "backend", "nombre": "Backend / API", "division": "Engineering",
         "regimen": "caliente", "aliases": ["backend-api", "api"], "asientos": [
            {"rol": "Lead", "modelo": "Opus", "tier": "opus", "agente": "squad-lead", "compartido": True},
            {"rol": "Constructor", "modelo": "gpt-oss-120b (constructor-code)", "tier": "oss",
             "agente": "eng-backend-constructor"},
            {"rol": "Reviewer", "modelo": "Opus", "tier": "opus", "agente": "reviewer", "compartido": True},
        ]},
        {"slug": "qa", "nombre": "QA", "division": "Engineering",
         "regimen": "caliente", "aliases": [], "asientos": [
            {"rol": "Lead", "modelo": "Opus", "tier": "opus", "agente": "squad-lead", "compartido": True},
            {"rol": "Constructor / Test-writer", "modelo": "gpt-oss-120b", "tier": "oss",
             "agente": "eng-qa-constructor"},
        ]},
        {"slug": "security", "nombre": "Security", "division": "Engineering",
         "regimen": "caliente", "aliases": ["sec"], "asientos": [
            {"rol": "Threat Modeler", "modelo": "Opus", "tier": "opus", "j": True,
             "agente": "eng-security-threat-modeler"},
            {"rol": "Reviewer", "modelo": "Opus", "tier": "opus", "agente": "security-reviewer"},
            {"rol": "Supervisor", "modelo": "Fable 5", "tier": "fable", "agente": None},
        ]},
    ]
    _md(base / "org/dashboard/squads.json", "")
    (base / "org/dashboard/squads.json").write_text(json.dumps(squads, ensure_ascii=False), encoding="utf-8")

    # --- .claude/agents/*.md (formato lista-inline real) ---
    ag = base / ".claude/agents"
    _md(ag / "squad-lead.md", _agente_md("squad-lead", ["Read", "Grep", "Glob", "mcp__github"],
                                         ["skill-creator"], "premium", "opus"))
    _md(ag / "reviewer.md", _agente_md("reviewer", ["Read", "Grep", "Glob", "Bash", "mcp__github"],
                                       ["code-review-skill"], "premium", "opus"))
    _md(ag / "eng-backend-constructor.md",
        _agente_md("eng-backend-constructor",
                   ["Read", "Edit", "Write", "Bash", "mcp__github", "mcp__claude_ai_Context7"],
                   ["code-review-skill"]))
    _md(ag / "eng-qa-constructor.md", _agente_md("eng-qa-constructor", ["Read", "Bash"], ["webapp-testing"]))
    _md(ag / "security-reviewer.md", _agente_md("security-reviewer", ["Read", "Grep"],
                                                ["code-review-skill"], "premium", "opus"))
    _md(ag / "eng-security-threat-modeler.md",
        _agente_md("eng-security-threat-modeler", ["Read", "Bash"], ["code-review-skill"], "premium", "opus"))

    # --- .mcp.json: github dedupe exacto · context7 dedupe por alias · exa nuevo ---
    _md(base / ".mcp.json", "")
    (base / ".mcp.json").write_text(json.dumps(
        {"mcpServers": {"github": {"type": "http"}, "exa": {"type": "http"},
                        "context7": {"type": "http"}}}), encoding="utf-8")

    # --- belt con item propio (belt-mcp) y uno que matchea catálogo ---
    _md(base / "org/belts/test-belt.md",
        "# Belt de prueba\n\n| MCP | uso |\n|---|---|\n"
        "| `mcp-pandoc` | exportación |\n| `mcp__exa` | research |\n")

    # --- misiones: cadena completed→processing→inbox + roto + ciclo + founder ---
    mi = base / "missions"
    _md(mi / "completed/mision-a.md", _mision("mision-a", "backend", extra="agente: eng-backend-constructor\n"))
    _md(mi / "processing/mision-b.md", _mision("mision-b", "backend", ["mision-a"],
                                               extra="agente: eng-backend-constructor\n"))
    _md(mi / "inbox/mision-c.md", _mision(
        "mision-c", "qa", ["mision-b"], extra="agentes: [eng-qa-constructor]\n",
        titulo="<script>alert(1)</script> misión de prueba"))
    _md(mi / "inbox/mision-d.md", _mision("mision-d", "qa", ["mision-c"]))
    _md(mi / "inbox/mision-e.md", _mision("mision-e", "qa", ["no-existe-jamas"]))
    _md(mi / "inbox/mision-f.md", _mision("mision-f", "qa", ["mision-g"]))
    _md(mi / "inbox/mision-g.md", _mision("mision-g", "qa", ["mision-f"]))
    _md(mi / "inbox/mision-h.md", _mision("mision-h", "backend",
                                          extra="espera_founder: decision-2026-06-10-001-test\n"))
    _md(mi / "inbox/mision-i.md", _mision("mision-i", "backend",
                                          extra="espera_founder: item-que-no-existe\n"))
    _md(mi / "inbox/mision-j.md", _mision("mision-j", "backend", ["mision-a"]))
    _md(mi / "processing/mision-k.md", _mision("mision-k", "qa",
                                               extra="espera_founder: decision-2026-06-10-001-test\n"))

    # --- founder: decisión abierta (con doc y XSS en título) + brief abierto + chat ---
    _md(base / "org/founder/decisiones/decision-2026-06-10-001-test.md",
        "---\nid: decision-2026-06-10-001-test\ntipo: decision\nsquad: frontend\n"
        "mision: mision-h\nts: " + ahora + "\n"
        "titulo: \"<script>alert(1)</script> decisión de prueba\"\nestado: abierto\n"
        "doc: org/artifacts/doc-prueba.md\n"
        "default: \"Si no respondés: queda como está.\"\n---\nTL;DR de la decisión.\n")
    _md(base / "org/founder/briefs/brief-2026-06-10-001-test.md",
        "---\nid: brief-2026-06-10-001-test\ntipo: brief\nsquad: qa\n"
        "ts: " + ahora + "\ntitulo: \"Brief de prueba\"\nestado: abierto\n---\nCuerpo del brief.\n")
    _md(base / "org/founder/chats/backend.jsonl",
        json.dumps({"ts": ahora, "de": "operator", "texto": "hola lead"}) + "\n")
    (base / "org/founder/preguntas").mkdir(parents=True, exist_ok=True)

    # --- artifacts para library/doc ---
    _md(base / "org/artifacts/doc-prueba.md", "# Doc de prueba\n\ncontenido con palabra-magica.\n")
    _md(base / "org/artifacts/sub/otro.md", "# Otro doc\n\nnada especial.\n")
    _md(base / "reports/retro-test.md", "# Retro\n\nresumen.\n")

    # --- estado de agentes (lo escribe tu orquestador; acá fixture) ---
    _md(base / "org/state/agents.json", "")
    (base / "org/state/agents.json").write_text(json.dumps(
        {"eng-qa-constructor": {"estado": "pausado", "model_override": "opus"}}), encoding="utf-8")

    # --- events.jsonl: 2 líneas completas + 1 SIN \n final (debe ignorarse, §2.2) ---
    ev1 = json.dumps({"ts": ahora, "tipo": "review_verdict", "mision": "mision-a",
                      "agente": "eng-backend-constructor", "squad": "backend",
                      "verdict": "aprobado", "detalle": "ok"})
    ev2 = json.dumps({"ts": ahora, "tipo": "review_verdict", "mision": "mision-c",
                      "agente": "eng-qa-constructor", "squad": "qa",
                      "verdict": "rechazado", "detalle": "falta C"})
    _md(base / "org/events/events.jsonl",
        ev1 + "\n" + ev2 + "\n" + '{"tipo":"review_verdict","verdict":"aprobado","agente":"eng-backend-constructor"')

    # --- usage.log: 2 corridas recientes del constructor + 1 vieja del reviewer ---
    _md(base / "reports/usage.log",
        f"{ahora}\teng-backend-constructor\tconstructor-code\tin=100\tout=50\n"
        f"{ahora}\teng-backend-constructor\tconstructor-code\tin=10\tout=5\n"
        f"2026-06-01T00:00:00Z\treviewer\tpremium\tin=1\tout=1\n")
    _md(base / "reports/security.log", "")
    (base / "reports/security.log").write_text("", encoding="utf-8")

    # --- static (el server sirve index.html como esté) ---
    _md(base / "org/dashboard/static/index.html", "<!doctype html><title>fixture</title>ok\n")
    return base


@pytest.fixture
def arbol(tmp_path):
    return armar_arbol(tmp_path / "org-fixture")


@pytest.fixture
def mod(arbol):
    return cargar_app(arbol)


@pytest.fixture
def cliente(mod):
    return TestClient(mod.app, base_url="http://localhost")


@pytest.fixture
def arbol_vacio(tmp_path):
    d = tmp_path / "org-vacio"
    d.mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture
def mod_vacio(arbol_vacio):
    return cargar_app(arbol_vacio)


@pytest.fixture
def cliente_vacio(mod_vacio):
    return TestClient(mod_vacio.app, base_url="http://localhost")
