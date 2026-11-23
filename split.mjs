// Public amounts are safe integers. All fractional costs and intermediate products use BigInt.
function integer(value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError("Invalid " + label);
  return BigInt(value);
}

function gcd(a, b) {
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function textOrder(a, b) {
  // Match Python's Unicode code point order, including non-BMP diner names.
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const difference = left[i].codePointAt(0) - right[i].codePointAt(0);
    if (difference) return difference;
  }
  return left.length - right.length;
}

function edge(graph, from, to, capacity, billCost = 0n, itemCost = 0n) {
  const forward = {to, capacity, billCost, itemCost};
  const reverse = {to:from, capacity:0, billCost:-billCost, itemCost:-itemCost, back:forward};
  forward.back = reverse;
  graph[from].push(forward);
  graph[to].push(reverse);
  return forward;
}

function assign(graph, sink, units) {
  for (let unit = 0; unit < units; unit++) {
    const distance = Array(graph.length).fill(null);
    const previous = Array(graph.length);
    distance[0] = [0n, 0n];
    for (let pass = 1; pass < graph.length; pass++) {
      let changed = false;
      for (const [from, edges] of graph.entries()) {
        if (!distance[from]) continue;
        for (const step of edges) {
          if (!step.capacity) continue;
          const bill = distance[from][0] + step.billCost;
          const item = distance[from][1] + step.itemCost;
          const best = distance[step.to];
          if (!best || bill < best[0] || (bill === best[0] && item < best[1])) {
            distance[step.to] = [bill, item];
            previous[step.to] = step;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    if (!previous[sink]) throw new Error("Cannot satisfy receipt quotas");
    for (let node = sink; node !== 0;) {
      const step = previous[node];
      step.capacity--;
      step.back.capacity++;
      node = step.back.to;
    }
  }
}

export function splitReceipt(receipt, shares) {
  const total = integer(receipt.total, 0, "receipt total");
  if (!Array.isArray(receipt.items) || !receipt.items.length || !shares || typeof shares !== "object")
    throw new TypeError("Expected receipt items and share weights");
  const dishes = new Map(), names = new Set();
  let scale = 1n, sum = 0n;
  for (const {id, price, qty} of receipt.items) {
    if (typeof id !== "string" || !id.trim() || dishes.has(id) || !Object.hasOwn(shares, id))
      throw new TypeError("Missing or repeated dish " + id);
    if (!shares[id] || typeof shares[id] !== "object" || Array.isArray(shares[id]))
      throw new TypeError("Invalid weights for " + id);
    const people = Object.keys(shares[id]).sort(textOrder);
    if (!people.length) throw new TypeError("Missing diner for " + id);
    const amount = integer(price, 0, "price") * integer(qty, 1, "quantity");
    let denominator = 0n;
    for (const person of people) {
      if (!person.trim()) throw new TypeError("Empty diner name");
      names.add(person);
      denominator += integer(shares[id][person], 1, "share weight");
    }
    dishes.set(id, {people, denominator, amount});
    scale = scale / gcd(scale, denominator) * denominator;
    sum += amount;
  }
  if (sum !== total || dishes.size !== Object.keys(shares).length)
    throw new TypeError("Receipt totals or share weights do not match");

  const pool = dishes.size + names.size + 1, sink = pool + 1;
  const graph = Array.from({length:sink + 1}, () => []);
  const diners = new Map(Array.from(names).sort(textOrder).map((name, i) =>
    [name, {node:dishes.size + i + 1, exact:0n, pay:0}]));
  const lines = Object.create(null), choices = [];
  let extra = 0, row = 0;
  for (const id of Array.from(dishes.keys()).sort(textOrder)) {
    row++;
    const {people, denominator, amount} = dishes.get(id);
    const portions = lines[id] = Object.create(null);
    let remaining = Number(amount);
    const supply = edge(graph, 0, row, 0);
    for (const person of people) {
      const diner = diners.get(person);
      const scaled = amount * BigInt(shares[id][person]) * (scale / denominator);
      const base = Number(scaled / scale), fraction = scaled % scale;
      portions[person] = base;
      remaining -= base;
      diner.pay += base;
      diner.exact += scaled;
      if (fraction) choices.push({portions, person, diner,
        step:edge(graph, row, diner.node, 1, 0n, scale - 2n * fraction)});
    }
    supply.capacity = remaining;
    extra += remaining;
  }
  let mandatory = 0;
  for (const {node, exact, pay} of diners.values()) {
    const required = Number(exact / scale) - pay;
    mandatory += required;
    edge(graph, node, sink, required);
    const fraction = exact % scale;
    if (fraction) edge(graph, node, pool, 1, scale - 2n * fraction);
  }
  edge(graph, pool, sink, extra - mandatory);
  assign(graph, sink, extra);
  for (const {step, portions, person, diner} of choices) {
    if (step.capacity === 0) { portions[person]++; diner.pay++; }
  }
  const totals = Object.create(null);
  for (const [person, {exact, pay}] of diners) {
    const divisor = gcd(exact, scale);
    totals[person] = {exact:scale === divisor ? String(exact / divisor) :
      String(exact / divisor) + "/" + String(scale / divisor), pay};
  }
  return {total:receipt.total, lines, diners:totals};
}
