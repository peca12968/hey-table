"""Build a read-only warehouse pick list from a Stockroom packing snapshot."""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory


def plan(snapshot, floor, bins, solver):
    captured_at = snapshot['captured_at_ms']
    if type(captured_at) is not int or captured_at < 0 or not isinstance(snapshot['holds'], list):
        raise ValueError('Expected a Stockroom packing snapshot')
    if not isinstance(bins, dict):
        raise ValueError('Expected an object mapping SKU to bin coordinates')
    quantities = Counter()
    orders = set()
    for item in snapshot['holds']:
        hold = item['reservation']
        order, sku, held = hold['id'], hold['sku'], hold['held']
        if not isinstance(order, str) or not isinstance(sku, str) or order in orders or type(held) is not int or held < 0:
            raise ValueError(f'Invalid reservation in packing snapshot: {order}')
        orders.add(order)
        if held:
            quantities[sku] += held

    rows = [list(row) for row in floor.splitlines()]
    if not rows or sum(row.count('D') for row in rows) != 1 or any(
            len(row) != len(rows[0]) or set(row) - set('#.D') for row in rows):
        raise ValueError('Expected a rectangular warehouse plan with one depot and no premarked pick stops')
    stops = defaultdict(list)
    for sku, quantity in sorted(quantities.items()):
        location = bins.get(sku)
        if not isinstance(location, list) or len(location) != 2 or any(type(value) is not int for value in location):
            raise ValueError(f'Expected a row and column for {sku}')
        row, col = location
        if not (1 <= row <= len(rows) and 1 <= col <= len(rows[0])) or rows[row - 1][col - 1] == '#':
            raise ValueError(f'Bin for {sku} is outside the walkable plan')
        if rows[row - 1][col - 1] == 'D':
            raise ValueError(f'Bin for {sku} overlaps the depot')
        rows[row - 1][col - 1] = '*'
        stops[row, col].append({'sku': sku, 'quantity': quantity})

    with TemporaryDirectory() as folder:
        route_input = Path(folder) / 'route.txt'
        route_input.write_text('\n'.join(''.join(row) for row in rows) + '\n', encoding='ascii')
        result = subprocess.run([solver.resolve(), route_input], capture_output=True, text=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'The route solver could not visit all bins')
    route = json.loads(result.stdout)
    return {'captured_at_ms': captured_at, 'steps': route['steps'], 'walk': route['walk'],
            'pick_list': [{'cell': cell, 'items': stops[tuple(cell)]} for cell in route['pick_order']]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot', type=Path)
    parser.add_argument('floor', type=Path)
    parser.add_argument('bins', type=Path)
    parser.add_argument('solver', type=Path)
    args = parser.parse_args()
    try:
        output = plan(json.loads(args.snapshot.read_text(encoding='utf-8-sig')), args.floor.read_text(encoding='utf-8-sig'),
                      json.loads(args.bins.read_text(encoding='utf-8-sig')), args.solver)
    except (KeyError, TypeError, ValueError, OSError) as error:
        parser.exit(2, f'{error}\n')
    print(json.dumps(output, indent=2))
