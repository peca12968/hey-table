from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import sqlite3
from threading import Barrier

import pytest
from fastapi.testclient import TestClient

from stockroom.api import create_app


def reserve(api, order, units):
    response = api.post("/reservations", headers={"Idempotency-Key": order}, json={"sku":"KIT-01","quantity":units})
    assert response.status_code == 201


def box(order, shipment, units):
    return {"reservation_id":order, "shipment_id":shipment, "quantity":units}


def dispatch(api, key, boxes):
    return api.post("/dispatch-batches", headers={"Idempotency-Key":key}, json={"boxes":boxes})


def test_box_receipts_survive_restart_expiry_and_returns(tmp_path):
    database = tmp_path / "ship.db"
    items = [box("south","A",2), box("north","B",1), box("north","A",2)]
    with TestClient(create_app(database, ttl_seconds=3, clock=lambda:100)) as api:
        reserve(api, "north", 4)
        reserve(api, "south", 2)
        first = dispatch(api, "van", items)
        assert first.status_code == 201
        receipt = first.json()
        assert receipt == {"batch_id":"van","boxes":[
            {**items[2],"held_after":2}, {**items[1],"held_after":1}, {**items[0],"held_after":0}]}
        assert api.post("/reservations/north/fulfillments/A/returns", headers={"Idempotency-Key":"restocked"},
                        json={"quantity":1}).status_code == 201
    with TestClient(create_app(database, clock=lambda:103)) as restarted:
        replay = dispatch(restarted, "van", list(reversed(items)))
        assert (replay.status_code, replay.json()) == (200, receipt)
        assert restarted.get("/dispatch-batches/van").json() == receipt
        assert restarted.get("/reservations/north").json()["state"] == "expired"
        assert restarted.get("/inventory").json() == [{"sku":"KIT-01","capacity":16,"available":16}]
        assert restarted.get("/reservations/north/fulfillments/A").json()["returnable"] == 1
        old_route = restarted.post("/reservations/north/fulfillments", headers={"Idempotency-Key":"A"},
                                   json={"quantity":2})
        assert (old_route.status_code, old_route.json()) == (200, receipt["boxes"][0])
        for changed in [items[:-1], [*items, box("north","C",1)], [*items[:-1],box("north","A",3)]]:
            assert dispatch(restarted, "van", changed).status_code == 409


def test_whole_batch_rolls_back_on_last_box_and_retry_can_succeed(tmp_path):
    database = tmp_path / "atomic.db"
    with TestClient(create_app(database)) as api:
        reserve(api, "A", 4)
        reserve(api, "Z", 2)
        good = [box("A","1",3),box("Z","2",2)]
        for invalid, code in [([good[0],box("Z","2",3)],409), ([good[0],box("absent","2",2)],404)]:
            failure = dispatch(api,"load",invalid)
            assert failure.status_code == code
            assert failure.json()["detail"].startswith(invalid[1]["reservation_id"]+"/2:")
            assert api.get("/reservations/A/fulfillments").json()["boxes"] == []
            assert api.get("/dispatch-batches/load").status_code == 404
            assert api.get("/inventory").json()[0] == {"sku":"KIT-01","capacity":20,"available":14}
        with closing(sqlite3.connect(database)) as db:
            db.execute("""CREATE TRIGGER fail_last BEFORE INSERT ON dispatch_batch_boxes
                          WHEN NEW.reservation_id='Z' BEGIN SELECT RAISE(ABORT, 'test failure'); END""")
        with pytest.raises(sqlite3.IntegrityError, match="test failure"):
            dispatch(api,"load",good)
        assert api.get("/dispatch-batches/load").status_code == 404
        assert api.get("/reservations/Z").json()["shipped"] == api.get("/reservations/A").json()["shipped"] == 0
        with closing(sqlite3.connect(database)) as db:
            db.execute("DROP TRIGGER fail_last")
        assert dispatch(api,"load",good).status_code == 201


def test_legacy_shipments_cannot_be_claimed_by_new_batches(tmp_path):
    database = tmp_path / "upgrade.db"
    with TestClient(create_app(database)) as old:
        reserve(old,"order",4)
        assert old.post("/reservations/order/fulfillments", headers={"Idempotency-Key":"Z"},
                        json={"quantity":2}).status_code == 201
    with closing(sqlite3.connect(database)) as db:
        db.execute("DROP TABLE dispatch_batch_boxes")  # Schema before batch membership existed.
    with TestClient(create_app(database)) as api:
        assert dispatch(api,"truck",[box("order","A",1), box("order","Z",2)]).status_code == 409
        assert api.get("/dispatch-batches/truck").status_code == 404
        assert api.get("/reservations/order/fulfillments/A").status_code == 404
        assert api.get("/reservations/order/fulfillments/Z").json()["dispatched"] == 2
        assert dispatch(api,"truck",[box("order","A",2)]).status_code == 201


def test_two_services_racing_shared_box_and_reordered_replays(tmp_path):
    database = tmp_path / "concurrent.db"
    with TestClient(create_app(database)) as left, TestClient(create_app(database)) as right:
        for key in ("east","west","shared"):
            reserve(left,key,4)
        def load(key):
            return [box("east" if key=="one" else "west","first",2), box("shared","only",3)]

        gate = Barrier(12, timeout=15)
        def attempt(index):
            key = "one" if index % 2 else "two"
            items = load(key)
            gate.wait()
            return key, dispatch(left if index%3 else right,key,items if index%4 < 2 else items[::-1])

        with ThreadPoolExecutor(max_workers=12) as pool:
            replies = list(pool.map(attempt, range(12)))
        assert sorted(r.status_code for _,r in replies) == [200]*5 + [201] + [409]*6
        winner, original = next((key,r.json()) for key,r in replies if r.status_code == 201)
        assert all(r.json() == original for key,r in replies if key == winner)
        loser = "two" if winner == "one" else "one"
        assert right.get("/dispatch-batches/"+loser).status_code == 404
        skipped = load(loser)[0]
        assert right.get("/reservations/"+skipped["reservation_id"]+"/fulfillments/first").status_code == 404
        assert left.get("/inventory").json()[0]["capacity"] == 15


def test_invalid_or_repeated_boxes_never_create_a_batch(tmp_path):
    with TestClient(create_app(tmp_path/"validation.db")) as api:
        one = box("order","box",1)
        for entries in [[], [one,one], [one,{**one,"quantity":2}], [{**one,"quantity":True}],
                        [{**one,"shipment_id":"bad/id"}], [box("order",str(i),1) for i in range(101)]]:
            assert dispatch(api, "invalid", entries).status_code == 422
        assert api.get("/dispatch-batches/invalid").status_code == 404


def test_lost_success_response_can_be_recovered_by_batch_key(tmp_path):
    database = tmp_path/"lost.db"
    app = create_app(database)
    async def disconnect(scope, receive, send):
        async def send_or_drop(message):
            if (scope.get("path") == "/dispatch-batches" and message["type"] == "http.response.start"
                    and message["status"] == 201):
                raise ConnectionResetError("test drops the successful response")
            await send(message)
        await app(scope, receive, send_or_drop)

    boxes = [box("order","A",2),box("order","B",3)]
    with TestClient(disconnect) as client:
        reserve(client,"order",5)
        with pytest.raises(ConnectionResetError):
            dispatch(client,"lost",boxes)
    with TestClient(create_app(database)) as recovered:
        saved = recovered.get("/dispatch-batches/lost")
        assert saved.status_code == 200
        replay = dispatch(recovered,"lost",boxes[::-1])
        assert (replay.status_code,replay.json()) == (200,saved.json())
        assert recovered.get("/inventory").json() == [{"sku":"KIT-01","capacity":15,"available":15}]
