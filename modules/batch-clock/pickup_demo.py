"""Run the real Pickup Window CLI on the original and calibrated kitchen files."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile


def run(checkout):
    root = Path(__file__).resolve().parent
    with tempfile.TemporaryDirectory() as folder:
        tmp = Path(folder)
        base = checkout/"examples/kitchen.json"
        cli = [sys.executable, str(root/"batch_clock.py"), "--db", str(tmp/"demo.db")]
        subprocess.run([*cli,"import",root/"examples/tea.jsonl","--kitchen",base],check=True,capture_output=True)
        model = subprocess.check_output([*cli,"calibrate","--kitchen",base,"--cutoff","2026-11-23T00:00:00+08:00","--format","kitchen"])
        calibrated = tmp/"kitchen.json"
        calibrated.write_bytes(model)
        snap, cart = tmp/"stations.json", tmp/"cart.json"
        snap.write_text(json.dumps({"format":"hey-table.station-orders.v1","capturedAt":1795406400000,
                                    "throughId":0,"orders":[]}),encoding="utf8")
        cart.write_text(json.dumps({"items":[{"id":"sencha","qty":3}]}),encoding="utf8")
        def quote(config):
            output = subprocess.check_output(["node",checkout/"cli.mjs",snap,config,"--cart",cart])
            return json.loads(output)["quote"]["seconds"]
        before, after = quote(base), quote(calibrated)
        if (before,after) != ([120,180],[96,170]):
            raise ValueError(f"unexpected quote: {before} -> {after}")
        print(json.dumps({"cups":3,"before_seconds":before,"after_seconds":after}))


if __name__ == "__main__":
    run(Path(sys.argv[1]).resolve())
