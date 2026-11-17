"""Builds the MetaTrader 5 bridge's own Python: packages/desktop/resources/mt5-runtime/

    python script/build-mt5-runtime.py

Downloads the official embeddable CPython for Windows (python.org) of the newest release the
``MetaTrader5`` package has wheels for (3.14), and installs ``MetaTrader5`` (and its ``numpy``)
into it from PyPI as binary wheels. The result is self-contained: the trading engine runs
``mt5-runtime/pythonw.exe`` for the bridge, so the user's own Python (the bots' 3.15 .venv, say)
needs no MetaTrader5 package. Re-running it is a no-op once the runtime is complete.
(Ported from DeepTrading's build_runtime.py.)
"""
from __future__ import annotations

import io
import json
import pathlib
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "resources" / "mt5-runtime"
SITE = OUT / "site-packages"
MINOR = "3.14"


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as resp:
        return resp.read()


def newest_patch(minor: str) -> str:
    listing = fetch("https://www.python.org/ftp/python/").decode("utf-8", "replace")
    patches = sorted({int(m) for m in re.findall(rf'href="{re.escape(minor)}\.(\d+)/"', listing)}, reverse=True)
    for patch in patches:
        version = f"{minor}.{patch}"
        try:
            page = fetch(f"https://www.python.org/ftp/python/{version}/").decode("utf-8", "replace")
        except Exception:
            continue
        if f"python-{version}-embed-amd64.zip" in page:
            return version
    raise SystemExit(f"no embeddable Python {minor} found on python.org")


def main() -> None:
    if (OUT / "pythonw.exe").is_file() and (SITE / "MetaTrader5").is_dir():
        print(f"mt5-runtime already built in {OUT}")
        return
    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir(parents=True)
    version = newest_patch(MINOR)
    url = f"https://www.python.org/ftp/python/{version}/python-{version}-embed-amd64.zip"
    print(f"downloading {url}")
    zipfile.ZipFile(io.BytesIO(fetch(url))).extractall(OUT)

    tag = MINOR.replace(".", "")
    print("installing MetaTrader5 and numpy (binary wheels)")
    subprocess.run([
        sys.executable, "-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check",
        "--target", str(SITE), "--only-binary=:all:", "--platform", "win_amd64",
        "--python-version", MINOR, "--implementation", "cp", "--abi", f"cp{tag}",
        "MetaTrader5", "numpy",
    ], check=True)

    # The embeddable distribution ignores PYTHONPATH and site; its ._pth file is the path.
    pth = next(OUT.glob("python*._pth"))
    lines = [line for line in pth.read_text(encoding="utf-8").splitlines() if line.strip()]
    if "site-packages" not in lines:
        lines.insert(1, "site-packages")
    pth.write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUT / "BUILD.json").write_text(json.dumps({"python": version}, indent=1), encoding="utf-8")
    print(f"mt5-runtime ready: Python {version} in {OUT}")


if __name__ == "__main__":
    main()
