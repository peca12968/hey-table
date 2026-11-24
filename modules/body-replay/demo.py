"""Replay two Stockroom releases and an explicitly narrowed rehearsal against the same corpus."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory


HERE = Path(__file__).resolve().parent
OLD = "34165f1adceb2baceaa53997b7a79a86656e959b"
NEW = "d6d5139e2b4413fea49f83d15b3928c7e97be6da"
CORPUS = HERE/"examples/requests.json"


def extract_python(checkout, revision, destination):
    git = ["git","-C",str(checkout)]
    paths = subprocess.check_output([*git,"ls-tree","-r","--name-only",revision,"--","stockroom"],text=True)
    for name in paths.splitlines():
        if name.endswith(".py"):
            target = destination/name
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(subprocess.check_output([*git,"show",revision+":"+name]))


def generate(checkout, destination):
    destination.mkdir()
    runtime = {}
    with TemporaryDirectory() as temporary:
        for label, revision in [("published",OLD), ("current",NEW), ("rehearsal",NEW)]:
            source = Path(temporary)/label
            extract_python(checkout, revision, source)
            if label == "rehearsal":
                api = source/"stockroom/api.py"
                code = api.read_text(encoding="utf8")
                marker = "class Order(Quantity):\n"
                assert code.count(marker) == 1
                api.write_text(code.replace(marker, marker+"    quantity: int = Field(strict=True, ge=1, le=5)\n"),
                               encoding="utf8")
            result = json.loads(subprocess.check_output([sys.executable,"-B",str(HERE/"stockroom_probe.py"),
                                                        str(source),str(CORPUS)]))
            (destination/f"{label}.json").write_text(json.dumps(result["spec"], indent=2),encoding="utf8")
            runtime[label] = result["statuses"]

    cases = json.loads(CORPUS.read_text())
    assert all(code == 201 for code in runtime["published"].values())
    for label in ["current","rehearsal"]:
        run = subprocess.run([sys.executable,str(HERE/"replay.py"),str(destination/"published.json"),
                              str(destination/f"{label}.json"),str(CORPUS)],capture_output=True,text=True)
        assert run.returncode == (1 if label == "rehearsal" else 0), run.stderr
        report = json.loads(run.stdout)
        empirical = {key for key,code in runtime[label].items() if code == 422}
        assert all(code in (201,422) for code in runtime[label].values())
        assert {f["id"] for f in report["findings"]} == empirical
        count = sum(case["count"] for case in cases if case["id"] in empirical)
        assert report["counts"] == {"preserved":75-count,"regressed":count,"baselineRejected":0}
        assert report["uncoveredCandidateBodyOperations"] == ["POST /dispatch-batches"]
        if label == "rehearsal":
            assert empirical == {"six-unit-hold","ten-unit-hold"} and count == 15
            assert all(f["issues"][0]["pointer"] == "/quantity" for f in report["findings"])
        print(label, report["counts"])
    (destination/"runtime-statuses.json").write_text(json.dumps(runtime,indent=2),encoding="utf8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("checkout",type=Path)
    parser.add_argument("new_directory",type=Path)
    args = parser.parse_args()
    generate(args.checkout, args.new_directory)
