"""Build the upstream C# checkout and replay the lunch shift with the calculated float."""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from float_plan import amount, plan, shared_plan


def compare(upstream):
    root = Path(__file__).resolve().parent
    shift = json.loads((upstream/"examples/lunch.json").read_text(encoding="utf-8-sig"))
    assert shift == json.loads((root/"examples/lunch.json").read_text(encoding="utf-8-sig"))
    supply = json.loads((root/"examples/supply.json").read_text())
    result = plan(shift, supply)
    alternative = json.loads((root/"examples/tea-lunch.json").read_text(encoding="utf-8"))
    shared = shared_plan([shift,alternative], supply)
    subprocess.run(["dotnet", "build", str(upstream/"TillChange.csproj"), "-c", "Release"], check=True)
    dll = upstream/"bin/Release/net10.0/TillChange.dll"
    with TemporaryDirectory() as folder:
        path = Path(folder)/"shift.json"

        def replay(inputs, opening):
            path.write_text(json.dumps({**inputs, "opening":opening}), encoding="utf-8")
            output = subprocess.check_output(["dotnet", str(dll), str(path)], encoding="utf-8")
            return json.loads(output)

        baseline = replay(shift, shift["opening"])
        funded = replay(shift, [a+b for a,b in zip(shift["opening"],result["topUp"])])
        shared_opening = [a+b for a,b in zip(shift["opening"], shared["topUp"])]
        variants = [replay(inputs, shared_opening) for inputs in (shift,alternative)]
    assert shared["topUpValue"] == 55
    for register, scenario in zip(variants, shared["scenarios"]):
        assert [r["status"] for r in register["receipts"]] == ["accepted"]*4
        assert amount(shift["denominations"],register["closing"]) == amount(shift["denominations"],scenario["closing"])
    assert [r["status"] for r in baseline["receipts"]] == ["accepted","accepted","no_exact_change","accepted"]
    assert [r["status"] for r in funded["receipts"]] == ["accepted"]*4
    assert funded["closing"] == result["closing"] == [0,0,0,0,6]
    print(json.dumps(dict(topUp=result["topUpValue"], before=3, after=4, closing=funded["closing"],
                          sharedTopUp=shared["topUpValue"],
                          branchClosingValues=[amount(shift["denominations"],r["closing"]) for r in variants])))


if __name__ == "__main__":
    compare(Path(sys.argv[1]).resolve())
