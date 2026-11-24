"""Build a pinned Stockroom image and run a disposable single-node kind drill."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid


ROOT = Path(__file__).resolve().parent
REVISION = "1bec99199cf0ee8ed9d9b3d34ddbaad10dc01930"
IMAGE = "stockroom-drill:" + REVISION[:7]


def workload(kube):
    def kubectl(*args, data=None):
        return subprocess.check_output([*kube, *args], input=data, text=True, timeout=210)

    def identity():
        pod = json.loads(kubectl("get", "pod", "stockroom-0", "-o", "json"))
        claim = next(v["persistentVolumeClaim"]["claimName"] for v in pod["spec"]["volumes"]
                     if v["name"] == "data")
        pvc = json.loads(kubectl("get", "pvc", claim, "-o", "json"))
        if pvc["status"]["phase"] != "Bound":
            raise RuntimeError(f"Claim {claim} is not bound")
        return {"pod_uid": pod["metadata"]["uid"], "claim_uid": pvc["metadata"]["uid"],
                "volume": pvc["spec"]["volumeName"]}

    def probe(phase):
        return json.loads(kubectl("exec", "-i", "http-client", "--", "python", "-",
                                  "http://stockroom", phase, data=(ROOT / "probe.py").read_text()))

    kubectl("apply", "-f", str(ROOT / "deploy.yaml"))
    rollout = ["rollout", "status", "statefulset/stockroom", "--timeout=180s"]
    kubectl(*rollout)
    kubectl("run", "http-client", "--restart=Never", f"--image={IMAGE}", "--image-pull-policy=Never",
            "--overrides=" + json.dumps({"spec": {"automountServiceAccountToken": False}}),
            "--command", "--", "python", "-c", "import time; time.sleep(600)")
    kubectl("wait", "--for=condition=Ready", "pod/http-client", "--timeout=120s")
    first = identity()
    before = probe("before")
    kubectl("rollout", "restart", "statefulset/stockroom")
    kubectl(*rollout)
    second = identity()
    if first["pod_uid"] == second["pod_uid"]:
        raise RuntimeError("The pod UID did not change")
    for field in ("claim_uid", "volume"):
        if first[field] != second[field]:
            raise RuntimeError(f"Storage identity changed: {field}")
    after = probe("after")
    if before["reservation"] != after["reservation"]:
        raise RuntimeError("Replayed reservation differs from the original")
    return {"first": first, "second": second, "before": before, "after": after}


def run(source):
    # Build only committed files at the revision exercised in CI.
    context = subprocess.check_output(["git", "-C", source, "archive", "--format=tar", REVISION,
                                       "Dockerfile", "requirements.txt", "stockroom"])
    subprocess.run(["docker", "build", "-t", IMAGE, "-"], input=context, stdout=sys.stderr, check=True, timeout=600)
    name = "stockroom-" + uuid.uuid4().hex[:12]
    with tempfile.TemporaryDirectory() as temp:
        config = str(Path(temp) / "kubeconfig")
        env = {**os.environ, "KUBECONFIG": config}
        kube = ["kubectl", "--kubeconfig", config, "--context", "kind-" + name]
        created = False
        try:
            subprocess.run(["kind", "create", "cluster", "--name", name, "--kubeconfig", config,
                            "--wait", "180s"], env=env, stdout=sys.stderr, check=True, timeout=360)
            created = True
            subprocess.run(["kind", "load", "docker-image", IMAGE, "--name", name],
                           env=env, stdout=sys.stderr, check=True, timeout=240)
            return workload(kube)
        except Exception:
            if created:
                for args in (["get", "pods,pvc,svc", "-o", "wide"], ["get", "events", "--sort-by=.lastTimestamp"],
                             ["logs", "stockroom-0", "--tail=40"]):
                    subprocess.run([*kube, "--request-timeout=10s", *args], stdout=sys.stderr, check=False)
            raise
        finally:
            subprocess.run(["kind", "delete", "cluster", "--name", name, "--kubeconfig", config],
                           env=env, stdout=sys.stderr, check=True, timeout=180)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("stockroom_checkout", type=Path)
    args = parser.parse_args()
    print(json.dumps(run(args.stockroom_checkout), indent=2), flush=True)
