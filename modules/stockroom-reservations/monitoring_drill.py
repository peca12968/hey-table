"""Replay counters scraped from two Stockroom apps through real Prometheus rules."""
import argparse
from contextlib import closing, ExitStack
import json
from pathlib import Path
import sqlite3
import subprocess
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from prometheus_client.parser import text_string_to_metric_families
from stockroom.api import create_app


def counters(response):
    response.raise_for_status()
    return {sample.labels["status"]: int(sample.value)
            for family in text_string_to_metric_families(response.text)
            for sample in family.samples if sample.name == "http_requests_total"}


def drill(promtool, rules):
    with TemporaryDirectory() as temp, ExitStack() as stack:
        root = Path(temp)
        clients = {name: stack.enter_context(TestClient(create_app(root / "stock.db"), raise_server_exceptions=False))
                   for name in ("a", "b")}
        with closing(sqlite3.connect(root / "stock.db")) as db:
            db.execute("""CREATE TRIGGER simulated_write_failure BEFORE INSERT ON reservations
                          WHEN NEW.id LIKE 'fault-%' BEGIN SELECT RAISE(FAIL, 'simulated storage failure'); END""")
        series = {}
        statuses = {}
        for instance, client in clients.items():
            statuses[instance] = set(counters(client.get("/metrics")))
            assert not any(counters(client.get("/metrics")).values())
            for code in statuses[instance]:
                series[instance, code] = ["0"]
        for minute in range(1, 422):
            for name, client in clients.items():
                if name == "a" and 371 <= minute <= 378:
                    reply = client.post("/reservations", headers={"Idempotency-Key": f"fault-{minute}"},
                                        json={"sku": "KIT-01", "quantity": 1})
                    assert reply.status_code == 500
                else:
                    assert client.get("/inventory").status_code == 200
                reading = counters(client.get("/metrics")) if name == "a" or minute < 415 else None
                if reading is not None:
                    assert set(reading) == statuses[name] and sum(reading.values()) == minute
                for code in statuses[name]:
                    series[name, code].append("_" if reading is None else str(reading[code]))
        assert counters(clients["a"].get("/metrics"))["500"] == 8
        with closing(sqlite3.connect(root / "stock.db")) as db:
            assert db.execute("SELECT COUNT(*) FROM reservations").fetchone() == (0,)
        inputs = [{"series": f'http_requests_total{{service="stockroom",instance="{name}",status="{code}"}}',
                   "values": " ".join(samples)} for (name, code), samples in series.items()]
        for name in clients:
            inputs.append({"series": f'slo_target_expected{{service="stockroom",instance="{name}"}}', "values": "1x421"})
        burn = {"exp_labels": {"service": "stockroom", "severity": "page"},
                "exp_annotations": {"summary": "Error budget for stockroom is burning across a pair of windows"}}
        missing = {"exp_labels": {"service": "stockroom", "instance": "b", "severity": "warning"},
                   "exp_annotations": {"summary": "No request counter samples for stockroom on b in 5m"}}
        alerts = [{"eval_time": f"{m}m", "alertname": "ServiceErrorBudgetBurn", "exp_alerts": [burn] if active else []}
                  for m, active in [(370, False), (378, True), (388, True), (410, False), (421, False)]]
        alerts.append({"eval_time": "421m", "alertname": "RequestTelemetryMissing", "exp_alerts": [missing]})
        checks = [{"expr": f"count(service:slo_burn_{kind})", "eval_time": "388m", "exp_samples": expected}
                  for kind, expected in (("fast", []), ("sustained", [{"labels": "{}", "value": 1}]))]
        case = {"input_series": inputs, "interval": "1m", "alert_rule_test": alerts, "promql_expr_test": checks}
        fixture = root / "scrapes.yml"
        fixture.write_text(json.dumps({"rule_files": [rules.resolve().as_posix()], "evaluation_interval": "1m", "tests": [case]}))
        subprocess.run([promtool.resolve(), "test", "rules", fixture], check=True)
        return {"requests": 842, "server_errors": 8, "sustained_only_at_minute": 388,
                "page_clear_at_check": 410, "missing_scrape_instance": "b"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("promtool", type=Path)
    parser.add_argument("rules", type=Path)
    args = parser.parse_args()
    print(json.dumps(drill(args.promtool, args.rules), indent=2))
