"""Validación del header Host (anti DNS-rebinding)."""
from fastapi.testclient import TestClient


def _cli(mod, host):
    # el header Host se fija explícito (el parser de URL del TestClient no soporta "[::1]:puerto")
    return TestClient(mod.app, base_url="http://localhost", headers={"host": host})


def test_loopback_permitido(mod):
    for host in ("localhost", "localhost:8787", "127.0.0.1:8787", "[::1]:8787"):
        assert _cli(mod, host).get("/api/squads").status_code != 403, host


def test_host_ajeno_rechazado_en_get_y_post(mod):
    cli = _cli(mod, "evil.example.com:8787")
    for ruta in ("/api/state", "/api/founder", "/api/doc?path=org/x.md", "/"):
        r = cli.get(ruta)
        assert r.status_code == 403 and r.json()["ok"] is False, ruta
    assert cli.post("/api/command", json={}).status_code == 403


def test_rebinding_con_ip_publica_rechazado(mod):
    assert _cli(mod, "203.0.113.7:8787").get("/api/state").status_code == 403


def test_host_extra_por_env(mod, monkeypatch):
    monkeypatch.setenv("DASHBOARD_ALLOWED_HOSTS", "tunel.example.org")
    assert _cli(mod, "tunel.example.org").get("/api/squads").status_code != 403


def test_rechazo_queda_en_security_log(mod):
    _cli(mod, "evil.example.com").get("/api/state")
    log = mod.SECURITY_LOG.read_text(encoding="utf-8")
    assert "HOST_RECHAZADO" in log and "evil.example.com" in log
