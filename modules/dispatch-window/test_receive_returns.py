import unittest

from receive_returns import parse_returns, receive


CSV = "code,quantity\nDW1/east/box/3,2\nDW1/west/box/2,1\n"
BATCH = "dock-1"


class ReturnReceivingTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.saved = None
        self.conflict = False
        self.balance = {"east": 3, "west": 2}
        self.receipt = {"batch_id": BATCH, "boxes": [
            {"reservation_id": reservation, "shipment_id": "box", "quantity": quantity,
             "return_id": BATCH, "returnable_after": 1}
            for reservation, quantity in (("east", 2), ("west", 1))
        ]}

    def request(self, path, body=None, headers=None):
        self.calls.append(path)
        if path == "/packing-snapshots":
            self.assertEqual(body, {"reservation_ids": ["east", "west"]})
            return 200, {"captured_at_ms": 100, "holds": [
                {"reservation": {"id": order}, "boxes": [
                    {"reservation_id": order, "shipment_id": "box", "dispatched": sent,
                     "restocked": sent - self.balance[order], "returnable": self.balance[order]}
                ]}
                for order, sent in (("east", 3), ("west", 2))
            ]}
        if path == "/return-batches/" + BATCH:
            return (200, self.saved) if self.saved else (404, None)
        self.assertEqual(path, "/return-batches")
        self.assertEqual(headers, {"Idempotency-Key": BATCH})
        self.assertEqual(body, {"boxes": [
            {name: box[name] for name in ("reservation_id", "shipment_id", "quantity")}
            for box in self.receipt["boxes"]
        ]})
        return (409, None) if self.conflict else (201, self.receipt)

    def test_mismatched_label_and_unknown_shipment_cannot_write(self):
        result = receive(CSV.replace("east/box/3", "east/box/2").replace("west/box/", "west/missing/"),
                         BATCH, self.request, confirm=True)
        self.assertEqual(result["state"], "blocked")
        self.assertEqual([box["status"] for box in result["boxes"]], ["label_mismatch", "unknown_shipment"])
        self.assertEqual(self.calls, ["/packing-snapshots"])

    def test_needs_confirmation_and_reports_a_concurrent_rejection(self):
        self.assertEqual(receive(CSV, BATCH, self.request)["state"], "ready")
        self.assertNotIn("/return-batches", self.calls)
        self.conflict = True
        result = receive(CSV, BATCH, self.request, confirm=True)
        self.assertEqual((result["state"], result["http_status"]), ("conflict", 409))
        self.assertNotIn("receipt", result)
        self.assertEqual(self.calls.count("/return-batches"), 1)

    def test_recovers_original_receipt_after_returnable_is_consumed(self):
        self.assertEqual(receive(CSV, BATCH, self.request, confirm=True)["state"], "received")
        self.saved = self.receipt
        self.balance["east"] = 0
        reversed_csv = "code,quantity\nDW1/west/box/2,1\nDW1/east/box/3,2\n"
        recovered = receive(reversed_csv, BATCH, self.request, confirm=True)
        self.assertEqual(recovered["state"], "recovered")
        self.assertEqual(recovered["receipt"], self.receipt)
        self.assertEqual(self.calls.count("/return-batches"), 1)
        with self.assertRaisesRegex(ValueError, "already used"):
            receive(CSV.replace("box/3,2", "box/3,1"), BATCH, self.request, confirm=True)

    def test_validates_rows_before_accessing_stockroom(self):
        document = 'code,quantity\r\n"DW1/east/box/3","2"\r\n\r\nDW1/west/box/2,1\r\n'
        self.assertEqual([row["line"] for row in parse_returns(document)], [2, 4])
        for invalid in ("quantity,code\n", "code,quantity\n", CSV + "DW1/east/box/3,1\n",
                        CSV.replace("/3,2", "/3,0"), CSV.replace("/3,2", "/3,1000001"), CSV + " " * 65536):
            with self.subTest(sample=invalid[:32]), self.assertRaises(ValueError):
                receive(invalid, BATCH, self.request, confirm=True)
        self.assertEqual(self.calls, [])
