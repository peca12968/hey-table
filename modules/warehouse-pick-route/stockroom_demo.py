"""Feed an actual Stockroom API export to the route CLI before and after expiration."""
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient


ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT.parent / 'stockroom-reservations'))
from stockroom.api import create_app


def exercise(solver, directory):
    floor = directory / 'floor.txt'
    floor.write_text('#####\n#D..#\n#####\n', encoding='ascii')
    bins = directory / 'bins.json'
    bins.write_text(json.dumps({'KIT-01': [2, 3]}), encoding='utf-8')
    exported = directory / 'snapshot.json'
    clock = [80]
    with TestClient(create_app(directory / 'stockroom.db', ttl_seconds=2, clock=lambda: clock[0])) as api:
        def reserve(order, units):
            result = api.post('/reservations', headers={'Idempotency-Key': order}, json={'sku': 'KIT-01', 'quantity': units})
            result.raise_for_status()

        def route():
            response = api.post('/packing-snapshots', json={'reservation_ids': ['east', 'west']})
            response.raise_for_status()
            exported.write_bytes(response.content)
            return json.loads(subprocess.check_output([sys.executable, ROOT / 'stockroom_route.py', exported, floor, bins, solver]))

        reserve('east', 5)
        clock[0] = 81
        reserve('west', 4)
        shipment = api.post('/reservations/west/fulfillments', headers={'Idempotency-Key': 'box'}, json={'quantity': 1})
        shipment.raise_for_status()
        before = route()
        clock[0] = 82
        after = route()
        clock[0] = 83
        empty = route()
        expected = lambda quantity: [{'cell': [2, 3], 'items': [{'sku': 'KIT-01', 'quantity': quantity}]}]
        if before['pick_list'] != expected(8) or after['pick_list'] != expected(3) or empty['pick_list']:
            raise ValueError('The route must reflect the outstanding, unshipped quantities at each snapshot')
        if [item['steps'] for item in (before, after, empty)] != [2, 2, 0]:
            raise ValueError('Expected one two-step round trip, then no picking when both holds expire')
        return {'before_expiry': 8, 'after_first_expiry': 3, 'after_second_expiry': 0}


if __name__ == '__main__':
    with TemporaryDirectory() as folder:
        print(json.dumps(exercise(Path(sys.argv[1]), Path(folder))))
