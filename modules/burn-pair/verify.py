"""Generate request counters and run the actual Prometheus rule evaluator."""
import argparse
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

SERVICE = "checkout"
MINUTES = 420


def counter(instance, status, increments, reset=None, stop=None):
    value = 0
    samples = []
    for minute in range(MINUTES + 1):
        if minute == reset:
            value = 0
        if minute:
            value += increments(minute)
        samples.append("_" if stop is not None and minute >= stop else str(value))
    return {"series": f'http_requests_total{{service="{SERVICE}",instance="{instance}",status="{status}"}}',
            "values": " ".join(samples)}


def target(instance):
    return {"series": f'slo_target_expected{{service="{SERVICE}",instance="{instance}"}}', "values": f"1x{MINUTES}"}


def check_case(name, series, *, fast=False, sustained=False, missing=(), expected_ratio=None):
    page = {"exp_labels": {"severity": "page", "service": SERVICE}, "exp_annotations": {
            "summary": f"Error budget for {SERVICE} is burning across a pair of windows"}}
    alerts = [{"eval_time": "7h", "alertname": "ServiceErrorBudgetBurn", "exp_alerts": [page] if fast or sustained else []}]
    alerts.append({"eval_time": "7h", "alertname": "RequestTelemetryMissing", "exp_alerts": [
        {"exp_labels": {"severity": "warning", "service": SERVICE, "instance": instance},
         "exp_annotations": {"summary": f"No request counter samples for {SERVICE} on {instance} in 5m"}}
        for instance in missing]})
    tests = [{"expr": f"count by (service) (service:slo_burn_{kind})", "eval_time": "7h",
              "exp_samples": [{"labels": f'{{service="{SERVICE}"}}', "value": 1}] if active else []}
             for kind, active in (("fast", fast), ("sustained", sustained))]
    case = {"name": name, "interval": "1m", "input_series": series, "alert_rule_test": alerts, "promql_expr_test": tests}
    if expected_ratio is not None:
        tests.extend([
            {"expr": f"abs(service:slo_error_ratio:rate{window} - {expected_ratio}) < bool 1e-8",
             "eval_time": "7h", "exp_samples": [{"labels": f'{{service="{SERVICE}"}}', "value": 1}]}
            for window in ("5m", "1h", "30m", "6h")])
    return case


def suite():
    def load(error_rate):
        return [target("a"), counter("a", "200", lambda t: 1000-error_rate(t)),
                counter("a", "503", error_rate)]
    cases = [
        check_case("2% throughout fires both windows", load(lambda t: 20), fast=True, sustained=True, expected_ratio=.02),
        check_case("0.7% throughout fires only the sustained window", load(lambda t: 7), sustained=True, expected_ratio=.007),
        check_case("2% over the last 70 minutes fires only the fast window", load(lambda t: 20 if t > 350 else 0), fast=True),
        check_case("a 10% burst lasting 4 minutes cannot page", load(lambda t: 100 if t > 416 else 0)),
        check_case("cleared incident no longer pages after both short windows recover", load(lambda t: 25 if t < 380 else 0)),
        check_case("the busy healthy instance outweighs the quiet failing one, including its restart",
                   [target("busy"), target("quiet"), counter("busy", "200", lambda t: 999, reset=418),
                    counter("quiet", "503", lambda t: 1)], expected_ratio=.001),
        check_case("no 5xx series and active traffic is a measured zero",
                   [target("a"), counter("a", "404", lambda t: 40)], expected_ratio=0),
        check_case("idle instance still reports counters while another disappears",
                   [target("idle"), target("lost"), counter("idle", "200", lambda t: 0),
                    counter("lost", "200", lambda t: 5, stop=415)], missing=["lost"]),
    ]
    separate_services = load(lambda t: 20)
    # Both services deliberately have the same instance label; only checkout should page.
    for series in load(lambda t: 0):
        separate_services.append({**series, "series": series["series"].replace('"checkout"', '"inventory"')})
    mixed = check_case("high error ratio stays attached to its service", separate_services, fast=True, sustained=True)
    cases.append(mixed)
    pulse = check_case("an active page clears once the recent window is healthy",
                       load(lambda t: 20 if 240 < t <= 320 else 0))
    page = {"exp_labels": {"severity": "page", "service": SERVICE}, "exp_annotations": {
            "summary": f"Error budget for {SERVICE} is burning across a pair of windows"}}
    for minute, active in [(240, False), (245, False), (283, False), (284, True),
                           (320, True), (321, True), (322, False), (327, False)]:
        pulse["alert_rule_test"].append({"eval_time": f"{minute}m", "alertname": "ServiceErrorBudgetBurn",
                                         "exp_alerts": [page] if active else []})
    cases.append(pulse)
    return cases


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("promtool", type=Path)
    args = parser.parse_args()
    rules = Path(__file__).with_name("rules.yml").resolve()
    with TemporaryDirectory() as tmp:
        fixture = Path(tmp) / "generated.yml"
        cases = suite()
        fixture.write_text(json.dumps({"rule_files": [rules.as_posix()], "evaluation_interval": "1m", "tests": cases}),
                           encoding="utf-8")
        subprocess.run([args.promtool.resolve(), "test", "rules", fixture], check=True)
        print(f"{len(cases)} scenarios verified using {MINUTES + 1} sample times each")
