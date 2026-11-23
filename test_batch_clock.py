from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest

from batch_clock import calibrate, read_kitchen, stamp

ROOT = Path(__file__).resolve().parent
KITCHEN = ROOT / "examples/kitchen.json"
CUTOFF = "2026-11-23T00:00:00+08:00"


class BatchClockTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / "timers.db"

    def cli(self, *args, expected=0):
        p = subprocess.run([sys.executable,str(ROOT/"batch_clock.py"),"--db",str(self.db),*map(str,args)],
                           capture_output=True,text=True,encoding="utf8")
        self.assertEqual(p.returncode,expected,p.stderr)
        if expected:
            self.assertEqual(p.stdout,"")
            return p.stderr
        return json.loads(p.stdout)

    def fit(self, *args):
        return self.cli("calibrate","--cutoff",CUTOFF,"--kitchen",KITCHEN,*args)

    def load(self):
        return self.cli("import",ROOT/"examples/tea.jsonl","--kitchen",KITCHEN)

    def test_time_split_groups_fallback_and_reimport(self):
        self.assertEqual(self.load(),{"events_read":48})
        report=self.fit()
        self.assertEqual(report["kitchen"]["recipes"]["sencha"]["seconds"],[48,85])
        self.assertEqual(report["kitchen"]["stations"],read_kitchen(KITCHEN)["stations"])
        tea=report["dishes"]["sencha"]
        self.assertEqual(tea["training_by_qty"],{"1":{"count":10,"seconds":[48,57]},"2":{"count":10,"seconds":[77,85]}})
        self.assertEqual([tea["before"]["within"],tea["after"]["within"],tea["after"]["late_seconds"]],[1,3,7])
        self.assertEqual(tea["holdout_by_qty"]["2"]["after"]["late"],1)
        self.assertEqual(tea["holdout_by_qty"]["1"]["after"]["within"],2)
        self.assertEqual(report["dishes"]["edamame"]["fallback_sizes"],3)
        self.assertEqual(self.fit("--min-batches","11","--format","kitchen"),read_kitchen(KITCHEN))
        self.load()
        self.assertEqual(self.fit(),report)

    def test_bad_import_rolls_back_even_after_a_valid_line(self):
        self.load()
        file=self.db.parent/"bad.jsonl"
        first={"action":"start","id":"new","dish":"sencha","qty":1,"lane":1,"at":"2026-12-01T10:00:00Z"}
        file.write_text(json.dumps(first)+"\n"+json.dumps({**first,"qty":2})+"\n",encoding="utf8")
        self.assertIn("line 2",self.cli("import",file,"--kitchen",KITCHEN,expected=2))
        self.assertEqual(self.cli("active"),[])
        with closing(sqlite3.connect(self.db)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM batches").fetchone()[0],24)

    def test_replayed_actions_boundaries_and_changed_recipe(self):
        def start(id,lane,at):
            return self.cli("start",id,"oyakodon","--qty",1,"--lane",lane,"--at",at,"--kitchen",KITCHEN)
        start("train",1,"2026-11-22T23:59:00+08:00")
        self.cli("finish","train","--at",CUTOFF)
        self.cli("finish","train","--at","2026-11-22T16:00:00Z")
        self.cli("finish","train","--at","2026-11-23T00:00:01+08:00",expected=2)
        self.cli("discard","train",expected=2)
        start("later",1,CUTOFF)
        self.cli("finish","later","--at","2026-11-23T00:30:00+08:00")
        start("overlap",2,"2026-11-22T23:59:59+08:00")
        self.cli("finish","overlap","--at","2026-11-23T00:05:00+08:00")
        start("lost",2,"2026-11-23T00:05:00+08:00")
        self.cli("discard","lost","--at","2026-11-23T00:05:00+08:00")
        start("ongoing",2,"2026-11-23T01:00:00+08:00")
        r=self.fit("--min-batches",1)
        self.assertEqual(r["dishes"]["oyakodon"]["after"]["seconds"],[60,60])
        self.assertEqual(r["dishes"]["oyakodon"]["after"]["late_seconds"],1740)
        self.assertEqual(r["excluded"],{"active":1,"discarded":1,"changed_recipe":0,"crossing_cutoff":1})
        self.assertEqual([o["id"] for o in self.cli("active")],["ongoing"])
        model=read_kitchen(KITCHEN)
        model["recipes"]["oyakodon"]["batchSize"]=2
        with closing(sqlite3.connect(self.db)) as db:
            db.row_factory=sqlite3.Row
            changed=calibrate(db,model,stamp(CUTOFF),1)
        self.assertEqual(changed["excluded"]["changed_recipe"],3)

    def test_missing_portion_keeps_baseline_and_future_outliers_never_change_training(self):
        self.load()
        with closing(sqlite3.connect(self.db)) as db, db:
            db.row_factory=sqlite3.Row
            db.execute("DELETE FROM batches WHERE id LIKE 'training-%' AND qty=2")
            r=calibrate(db,read_kitchen(KITCHEN),stamp(CUTOFF),10)
            self.assertEqual(r["dishes"]["sencha"]["fallback_sizes"],1)
            self.assertEqual(r["kitchen"]["recipes"]["sencha"]["seconds"],[48,90])
            db.execute("UPDATE batches SET ended=ended+3600 WHERE id='later-4'")
            second=calibrate(db,read_kitchen(KITCHEN),stamp(CUTOFF),10)
            self.assertEqual(second["kitchen"],r["kitchen"])
            self.assertGreater(second["dishes"]["sencha"]["after"]["late_seconds"],r["dishes"]["sencha"]["after"]["late_seconds"])

    def test_eight_cooks_contend_for_one_lane(self):
        gate=threading.Barrier(8)
        def claim(i):
            gate.wait(timeout=10)
            p=subprocess.run([sys.executable,ROOT/"batch_clock.py","--db",self.db,"start",str(i),"sencha",
                              "--kitchen",KITCHEN,"--lane","1","--qty","1","--at",CUTOFF],capture_output=True,text=True)
            if p.returncode != 0:
                self.assertEqual(p.returncode,2)
                self.assertIn("lane is busy",p.stderr)
            return p.returncode==0
        with ThreadPoolExecutor(max_workers=8) as pool:
            won=list(pool.map(claim,range(8)))
        self.assertEqual(won.count(True),1)
        winner=str(won.index(True))
        self.cli("start",winner,"sencha","--qty",1,"--lane",1,"--kitchen",KITCHEN)
        self.cli("discard",winner,"--at",CUTOFF)
        self.cli("start","old","sencha","--qty",1,"--lane",1,"--kitchen",KITCHEN,"--at","2026-11-22T00:00:00Z",expected=2)

    def test_read_only_commands_do_not_create_an_empty_log(self):
        self.cli("active",expected=2)
        self.assertFalse(self.db.exists())
        self.cli("calibrate","--cutoff",CUTOFF,"--kitchen",KITCHEN,expected=2)
        self.assertFalse(self.db.exists())


if __name__=="__main__":
    unittest.main()
