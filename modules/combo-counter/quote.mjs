// All monetary products and optimization costs are exact; JSON amounts use safe integers.
function integer(value, minimum, field) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError("Invalid " + field);
  return value;
}

function byId(left, right) {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function indexed(rows, label) {
  if (!Array.isArray(rows)) throw new TypeError(label + " must be an array");
  const index = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || index.has(row.id)) {
      throw new TypeError(label + " needs unique nonempty IDs");
    }
    index.set(row.id, row);
  }
  return index;
}

function edge(graph, from, to, capacity, cost = 0n) {
  const forward = {from, to, capacity, cost};
  const reverse = {from: to, to: from, capacity: 0, cost: -cost, back: forward};
  forward.back = reverse;
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function optimize(graph, sink) {
  for (;;) {
    const distance = Array(graph.length).fill(null);
    const parent = Array(graph.length);
    distance[0] = 0n;
    for (let pass = 1; pass < graph.length; pass++) {
      let changed = false;
      for (let from = 0; from < graph.length; from++) {
        if (distance[from] === null) continue;
        for (const step of graph[from]) {
          if (!step.capacity) continue;
          const cost = distance[from] + step.cost;
          if (distance[step.to] === null || cost < distance[step.to]) {
            distance[step.to] = cost;
            parent[step.to] = step;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    // An extra pair is optional. A zero-cost path adds a bundle without saving money.
    if (distance[sink] === null || distance[sink] >= 0n) return;
    let amount = Number.MAX_SAFE_INTEGER;
    for (let node = sink; node !== 0; node = parent[node].from) {
      amount = Math.min(amount, parent[node].capacity);
    }
    for (let node = sink; node !== 0; node = parent[node].from) {
      const step = parent[node];
      step.capacity -= amount;
      step.back.capacity += amount;
    }
  }
}

function splitSaving(mainPrice, sidePrice, saving) {
  // Round the main's proportional share to the nearest dollar; exact ties go to the main.
  const original = BigInt(mainPrice) + BigInt(sidePrice);
  const main = (2n * saving * BigInt(mainPrice) + original) / (2n * original);
  return [main, saving - main];
}

export function quoteCombos(menu, promotions, items) {
  const catalog = indexed(menu, "menu");
  for (const dish of catalog.values()) integer(dish.price, 0, "menu price");
  const rules = [...indexed(promotions, "promotions").values()].sort(byId);
  const mains = new Set(), sides = new Set();
  for (const rule of rules) {
    if (!catalog.has(rule.main) || !catalog.has(rule.side)) throw new TypeError("Unknown promotion dish: " + rule.id);
    mains.add(rule.main);
    sides.add(rule.side);
    integer(rule.price, 0, "bundle price");
    if (rule.limit !== undefined) integer(rule.limit, 0, "per-order limit");
  }
  if ([...mains].some(id => sides.has(id))) throw new TypeError("Main and side roles must be disjoint");

  const basket = [...indexed(items, "cart").values()].sort(byId);
  const graph = Array.from({length: basket.length + 2}, () => []);
  const sink = graph.length - 1, nodes = new Map();
  const lines = new Map();
  let subtotal = 0n;
  for (const [i, item] of basket.entries()) {
    if (!catalog.has(item.id)) throw new TypeError("Unknown cart dish: " + item.id);
    const qty = integer(item.qty, 1, "cart quantity");
    const price = catalog.get(item.id).price;
    const gross = BigInt(price) * BigInt(qty);
    subtotal += gross;
    if (subtotal > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Cart total exceeds safe integer range");
    lines.set(item.id, {id: item.id, qty, price, subtotal: Number(gross), paired: 0, discount: 0});
    nodes.set(item.id, i+1);
    if (mains.has(item.id)) edge(graph, 0, i+1, qty);
    if (sides.has(item.id)) edge(graph, i+1, sink, qty);
  }

  const eligible = [];
  for (const rule of rules) {
    const main = lines.get(rule.main), side = lines.get(rule.side);
    if (!main || !side) continue;
    const saving = BigInt(main.price) + BigInt(side.price) - BigInt(rule.price);
    const limit = Math.min(main.qty, side.qty, rule.limit ?? Number.MAX_SAFE_INTEGER);
    if (saving <= 0n || !limit) continue;
    const step = edge(graph, nodes.get(rule.main), nodes.get(rule.side), limit, -saving);
    eligible.push({rule, step, saving, main, side});
  }
  optimize(graph, sink);

  const bundles = [];
  for (const {rule, step, saving, main, side} of eligible) {
    const qty = step.back.capacity;
    if (!qty) continue;
    const [mainShare, sideShare] = splitSaving(main.price, side.price, saving);
    main.paired += qty;
    side.paired += qty;
    main.discount += Number(mainShare * BigInt(qty));
    side.discount += Number(sideShare * BigInt(qty));
    bundles.push({id: rule.id, main: main.id, side: side.id, qty, unitPrice: rule.price,
      unitSavings: Number(saving), mainUnitDiscount: Number(mainShare), sideUnitDiscount: Number(sideShare)});
  }
  const receipt = [...lines.values()].map(line => ({...line, total: line.subtotal - line.discount}));
  const discount = receipt.reduce((sum, line) => sum + line.discount, 0);
  return {currency: "TWD", subtotal: Number(subtotal), discount, total: Number(subtotal) - discount,
    bundles, lines: receipt};
}
