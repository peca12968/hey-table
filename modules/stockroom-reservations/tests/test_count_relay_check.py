import json
from pathlib import Path
import subprocess
import sys

from fastapi.testclient import TestClient

from stockroom.api import create_app


COUNT_RELAY = Path(__file__).resolve().parents[2] / "count-relay"


def test_offline_count_against_stockroom_snapshot(tmp_path):
    def run(script, *args, expected_status=0):
        result = subprocess.run([sys.executable, COUNT_RELAY / script, *args],
                                cwd=tmp_path, capture_output=True, text=True, check=False)
        assert result.returncode == expected_status, result.stderr
        return json.loads(result.stdout)

    def save(name, data):
        (tmp_path / name).write_text(json.dumps(data), encoding="utf-8")

    def relay(*args):
        return run("count_relay.py", *args)

    def check(expected_status):
        save("counts.json", relay("export", "east.db"))
        return run("stockroom_check.py", "counts.json", "inventory.json", "scope.json",
                   expected_status=expected_status)

    def display(stage, result):
        return {"stage": stage, "unmapped_batches": result["unmapped_batches"],
                **result["products"]["KIT-01"]}

    now = [100]
    app = create_app(tmp_path / "stock.db", ttl_seconds=2, clock=lambda: now[0])
    with TestClient(app) as client:
        assert client.post("/reservations", headers={"Idempotency-Key": "order"},
                           json={"sku": "KIT-01", "quantity": 6}).status_code == 201
        response = client.get("/inventory-snapshot")
        assert response.status_code == 200
        assert response.headers["Cache-Control"] == "no-store"
        snapshot = response.json()
        assert snapshot == {"captured_at_ms": 100_000, "products": [
            {"sku": "KIT-01", "capacity": 20, "available": 14},
        ]}
        assert client.get("/inventory").json() == snapshot["products"]
        basis = client.get("/inventory/KIT-01/count-basis").raise_for_status().json()
        assert basis["captured_at_ms"] == snapshot["captured_at_ms"]
        now[0] = 102
        assert client.get("/inventory-snapshot").json() == {"captured_at_ms": 102_000, "products": [
            {"sku": "KIT-01", "capacity": 20, "available": 20},
        ]}
    save("inventory.json", snapshot)

    for device, units in (("east", "20"), ("west", "18")):
        relay("init", f"{device}.db", "shift-1")
        relay("record", f"{device}.db", "pallet", units, "--device", device)
    relay("record", "east.db", "empty-box", "0", "--device", "east")
    save("west.json", relay("export", "west.db"))
    relay("merge", "east.db", "west.json")
    scope = {"session": "shift-1", "batches": {"pallet": "KIT-01", "spare-bin": "KIT-01"}}
    save("scope.json", scope)

    review = display("review", check(1))

    rev = relay("status", "east.db")["batches"]["pallet"]["revision"]
    relay("record", "east.db", "pallet", "19", "--device", "lead", "--expect", rev)
    scope["batches"] = {"pallet": "KIT-01"}
    save("scope.json", scope)
    assert check(1)["products"]["KIT-01"]["variance"] is None

    scope["batches"]["empty-box"] = "KIT-01"
    save("scope.json", scope)
    result = check(1)
    assert result["session"] == "shift-1"
    assert result["captured_at_ms"] == 100_000
    variance = display("variance", result)

    relay("record", "east.db", "pallet", "20", "--device", "lead")
    balanced = display("balanced", check(0))
    demo = json.loads((COUNT_RELAY / "examples" / "stockroom-audit.json").read_bytes())
    assert demo == [review, variance, balanced]

    committed = result["products"]["KIT-01"]
    with TestClient(create_app(tmp_path / "stock.db", clock=lambda: now[0])) as restarted:
        receipt = restarted.post("/inventory/KIT-01/count-adjustments", headers={"Idempotency-Key": "adjust-shift-1"},
                                 json={"expected_revision": basis["revision"], "counted": committed["counted"],
                                       "count_session": result["session"], "reason": "Completed recount"})
        assert receipt.status_code == 201
        assert receipt.json()["count_session"] == "shift-1"
        assert receipt.json()["counted"] == 19
        assert restarted.get("/inventory").json() == [{"sku": "KIT-01", "capacity": 19, "available": 19}]
