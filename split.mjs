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
  if (!Array.isArray(receipt.items) || !receipt.items.length) throw new TypeError("Expected receipt items");
  const rows = receipt.items.map(({id, price, qty}) => ({
    id, amount: integer(price, 0, "price") * integer(qty, 1, "quantity")
  }));
  return splitAmounts(receipt.total, rows, shares);
}

function splitAmounts(receiptTotal, rows, shares) {
  const total = integer(receiptTotal, 0, "receipt total");
  if (!shares || typeof shares !== "object" || Array.isArray(shares)) throw new TypeError("Expected share weights");
  const dishes = new Map(), names = new Set();
  let scale = 1n, sum = 0n;
  for (const {id, amount} of rows) {
    if (typeof id !== "string" || !id.trim() || dishes.has(id) || !Object.hasOwn(shares, id))
      throw new TypeError("Missing or repeated dish " + id);
    if (!shares[id] || typeof shares[id] !== "object" || Array.isArray(shares[id]))
      throw new TypeError("Invalid weights for " + id);
    const people = Object.keys(shares[id]).sort(textOrder);
    if (!people.length) throw new TypeError("Missing diner for " + id);
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
  return {total:receiptTotal, lines, diners:totals};
}

// Validate the amounts on a Combo Counter quote before assigning a diner's share.
export function splitQuote(quote, shares) {
  if (quote.currency !== "TWD" || !Array.isArray(quote.lines) || !Array.isArray(quote.bundles))
    throw new TypeError("Expected a TWD Combo Counter quote");
  const lines = new Map(), rows = [];
  let gross = 0n, savings = 0n;
  for (const line of quote.lines) {
    if (typeof line.id !== "string" || !line.id.trim() || lines.has(line.id))
      throw new TypeError("Missing or repeated quote dish");
    const price = integer(line.price, 0, "price"), qty = integer(line.qty, 1, "quantity");
    const subtotal = integer(line.subtotal, 0, "line subtotal"), discount = integer(line.discount, 0, "line discount");
    const net = integer(line.total, 0, "line total"), paired = integer(line.paired, 0, "paired quantity");
    if (subtotal !== price * qty || subtotal - discount !== net || paired > qty)
      throw new TypeError("Inconsistent price or quantity for " + line.id);
    lines.set(line.id, {price, paired, discount, used: 0n, applied: 0n});
    rows.push({id:line.id, amount:net});
    gross += subtotal;
    savings += discount;
  }
  const ids = new Set(), mains = new Set(), sides = new Set();
  for (const bundle of quote.bundles) {
    const main = lines.get(bundle.main), side = lines.get(bundle.side);
    if (typeof bundle.id !== "string" || !bundle.id.trim() || ids.has(bundle.id) || !main || !side)
      throw new TypeError("Invalid bundle ID or dish");
    ids.add(bundle.id); mains.add(bundle.main); sides.add(bundle.side);
    const qty = integer(bundle.qty, 1, "bundle quantity");
    const retail = main.price + side.price, price = integer(bundle.unitPrice, 0, "bundle price");
    const saving = integer(bundle.unitSavings, 1, "unit savings");
    const m = integer(bundle.mainUnitDiscount, 0, "main discount"), s = integer(bundle.sideUnitDiscount, 0, "side discount");
    if (retail - price !== saving || m + s !== saving || m !== (2n * saving * main.price + retail) / (2n * retail))
      throw new TypeError("Inconsistent unit discount for " + bundle.id);
    main.used += qty; side.used += qty;
    main.applied += qty * m; side.applied += qty * s;
  }
  for (const [id, line] of lines) {
    if ((mains.has(id) && sides.has(id)) || line.paired !== line.used || line.discount !== line.applied)
      throw new TypeError("Bundle quantities or discounts disagree for " + id);
  }
  if (integer(quote.subtotal, 0, "quote subtotal") !== gross || integer(quote.discount, 0, "quote discount") !== savings)
    throw new TypeError("Quote header and lines disagree");
  return splitAmounts(quote.total, rows, shares);
}
