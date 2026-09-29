"""The Telegram bridge is DISABLED (and silent) when its variables are missing."""
import importlib.util
import subprocess
import sys
from pathlib import Path

BRIDGE = Path(__file__).resolve().parents[2] / "telegram_bridge.py"


def _env_sin_telegram():
    import os
    e = dict(os.environ)
    for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_ID"):
        e.pop(k, None)
    return e


def test_outbox_y_send_sin_variables_no_fallan_ni_envian():
    for args in (["outbox"], ["send", "hola"]):
        r = subprocess.run([sys.executable, str(BRIDGE), *args], capture_output=True, text=True, env=_env_sin_telegram())
        assert r.returncode == 0
        assert "disabled" in r.stdout


def test_hook_de_mision_devuelve_none_si_esta_desactivado(monkeypatch):
    for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "TELEGRAM_ALLOWED_USER_ID"):
        monkeypatch.delenv(k, raising=False)
    spec = importlib.util.spec_from_file_location("bridge_bajo_test", BRIDGE)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.ENABLED is False
    assert mod.mission_hook({"from": {"id": 1}}, "mision: hacer algo") is None


def test_no_hay_credenciales_por_defecto_en_el_codigo():
    src = BRIDGE.read_text(encoding="utf-8")
    assert 'TELEGRAM_BOT_TOKEN", "")' in src and 'TELEGRAM_CHAT_ID", "")' in src
