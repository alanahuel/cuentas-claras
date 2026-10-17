"""One-command local demo: synthetic data, loopback only, no AI keys, removed on exit."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def main():
    for command in ("uv", "npm"):
        if not shutil.which(command):
            raise SystemExit(f"Install {command} before running the demo (see README).")
    subprocess.run(["uv", "sync", "--frozen"], cwd=ROOT / "backend", check=True)
    subprocess.run(["npm", "ci"], cwd=ROOT / "frontend", check=True)
    subprocess.run(["npm", "run", "build"], cwd=ROOT / "frontend", check=True)
    with tempfile.TemporaryDirectory(prefix="cuentas-demo-") as temporary:
        env = os.environ.copy()
        env.update({
            "DATA_DIR": str(Path(temporary) / "cuentas-demo"),
            "FRONTEND_DIR": str(ROOT / "frontend/dist"),
            "APP_ORIGIN": "http://localhost:8030", "COOKIE_SECURE": "false",
            "OPENAI_API_KEY": "", "DOCUMENT_AI_MODEL": "", "ASSISTANT_MODEL": "",
        })
        python = ROOT / "backend/.venv/bin/python"
        subprocess.run([str(python), str(ROOT / "scripts/seed-demo.py")], env=env, check=True)
        print("\nDemo: http://localhost:8030\nLogin: demo@example.test\nPassword: synthetic-demo-only\nSynthetic data only. Ctrl+C stops the demo and deletes its server data.\n", flush=True)
        try:
            subprocess.run([str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8030"], cwd=ROOT / "backend", env=env, check=True)
        except KeyboardInterrupt:
            pass

if __name__ == "__main__":
    main()
