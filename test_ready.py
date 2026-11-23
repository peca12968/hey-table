import itertools
import math
import unittest

from example import lunch
from ready import report


def snap(time, states):
    return dict(format="hey-table.station-orders.v1", capturedAt=time, throughId=max(states, default=0),
                orders=[dict(id=i, created=0, mode="table", status=s) for i, s in states.items()])


class ReadyRangeTests(unittest.TestCase):
    def test_lunch(self):
        summary = report(lunch(), 40)
        self.assertEqual(summary["counts"], dict(on_time=1, missed=2, uncertain=2))
        self.assertEqual(summary["percentileMs"], dict(p50=[40000, 100000], p90=[None, None]))
        self.assertEqual(summary["onTimeCountRange"], [1, 3])
        self.assertEqual(report(lunch(), 40, "table")["observed"], 2)
        self.assertEqual(summary["orders"][0]["latestMs"], 40000)
        self.assertEqual(summary["orders"][2]["earliestMs"], 70000)

    def test_enumerate_possible_ready_times(self):
        # Evaluate every combination of feasible discrete event times, including never.
        samples = list(lunch())
        choices = [[0, 10000, 40000], [10000, 40000, 70000], [70000, 100000, math.inf],
                   [40000, 70000, 100000], [math.inf]]
        possibilities = list(itertools.product(*choices))
        for target in [0, 10, 39, 40, 41, 69, 70, 100]:
            summary = report(samples, target)
            counts = [sum(value <= 1000 * target for value in events) for events in possibilities]
            self.assertEqual(summary["onTimeCountRange"], [min(counts), max(counts)])
            for percent, index in [(50, 2), (90, 4)]:
                ranks = [sorted(events)[index] for events in possibilities]
                expected = [None if math.isinf(x) else x for x in (min(ranks), max(ranks))]
                self.assertEqual(summary["percentileMs"][f"p{percent}"], expected)

    def test_terminal_window(self):
        first = snap(100, {1:"pending", 2:"preparing", 3:"ready", 4:"completed", 5:"cancelled"})
        second = snap(200, {i:"completed" for i in range(6, 26)})
        rows = report([first, second], 1)["orders"]
        self.assertEqual([r["evidence"] for r in rows[:5]],
                         ["terminal_unknown", "inferred_completed", "inferred_completed", "completed", "cancelled"])
        self.assertEqual([r["latestMs"] for r in rows[:5]], [None, 200, 100, 100, None])
        again = snap(300, {1:"ready", **{i:"completed" for i in range(6,26)}})
        with self.assertRaises(ValueError):
            report([first, second, again], 1)
        with self.assertRaises(ValueError):
            report([first, snap(200, {25:"pending"})], 1)

    def test_clock_and_status(self):
        for seq in [
            [snap(5,{1:"pending"}), snap(5,{1:"ready"})],
            [snap(7,{1:"pending"}), snap(6,{1:"ready"})],
            [snap(5,{1:"preparing"}), snap(6,{1:"cancelled"})],
            [snap(5,{1:"completed"}), snap(6,{1:"ready"})],
        ]:
            with self.assertRaises(ValueError):
                report(seq, 5)
        samples = list(lunch())
        self.assertEqual(report(samples, 40), report([samples[0], *samples], 40))

    def test_invalid_rows_and_empty_cohort(self):
        for changes in [dict(id=True), dict(created=11), dict(mode="delivery"), dict(status=[])]:
            sample = snap(10, {1:"pending"})
            sample["orders"][0].update(changes)
            with self.assertRaises(ValueError):
                report([sample], 10)
        self.assertEqual(report([snap(10,{})], 0)["percentileMs"]["p50"], [None,None])
        self.assertEqual(report([snap(10,{1:"ready"})], 1, "pickup")["observed"], 0)


if __name__ == "__main__":
    unittest.main()
