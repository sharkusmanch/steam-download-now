import Millennium
import os
from datetime import datetime

LOG_PATH = os.path.join(os.path.expanduser("~"), "steam-download-now.log")


def _write(message: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_PATH, "a", encoding="utf-8") as f:
        f.write(f"[{ts}] {message}\n")


# Module-level function — Millennium resolves callServerMethod targets here, not on Plugin
def log(message: str) -> None:
    _write(message)


class Plugin:
    def _load(self):
        _write("=== Plugin loaded ===")
        Millennium.ready()

    def _front_end_loaded(self):
        _write("=== Frontend loaded ===")

    def _unload(self):
        _write("=== Plugin unloaded ===")
