"""The public demo stays synthetic and must never overwrite existing data."""
import os
import sqlite3
import subprocess
import sys
from datetime import date
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/seed-demo.py"


def seed(directory):
    return subprocess.run(
        [sys.executable, str(SCRIPT)],
        env={**os.environ, "DATA_DIR": str(directory)},
        capture_output=True, text=True,
    )


def test_demo_uses_current_period_and_refuses_existing_data(tmp_path):
    directory = tmp_path / "cuentas-demo"
    result = seed(directory)
    assert result.returncode == 0, result.stderr
    databases = list(directory.glob("*.sqlite*")) + list(directory.glob("*.db"))
    database = next(path for path in databases if not path.name.endswith(("-shm", "-wal")))
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT email FROM users").fetchall() == [("demo@example.test",)]
        assert connection.execute("SELECT count(*) FROM invoices").fetchone()[0] == 5
        assert connection.execute("SELECT DISTINCT date FROM invoices").fetchall() == [(date.today().replace(day=1).isoformat(),)]
    assert seed(directory).returncode != 0
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT count(*) FROM invoices").fetchone()[0] == 5


def test_demo_refuses_normal_application_directories(tmp_path):
    directory = tmp_path / "real-data"
    assert seed(directory).returncode != 0
    assert not directory.exists()
