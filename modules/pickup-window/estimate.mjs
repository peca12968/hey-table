/** Schedule independent station batches, joining the last batch of each order. */
const inactive = new Set(["pending", "ready", "completed", "cancelled"]);
function check(condition, message) {
  if (!condition) throw new Error(message);
}
function integer(value, min, name, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, "Invalid " + name);
  return value;
}
function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function range(value, min, name) {
  check(Array.isArray(value) && value.length === 2, "Expected two values for " + name);
  integer(value[0], min, name);
  integer(value[1], value[0], name);
}
function validateKitchen(kitchen) {
  check(object(kitchen?.stations) && object(kitchen?.recipes), "Expected stations and recipes");
  for (const [name, lanes] of Object.entries(kitchen.stations)) integer(lanes, 1, "lanes for " + name);
  for (const [id, recipe] of Object.entries(kitchen.recipes)) {
    check(object(recipe) && typeof recipe.station === "string" && Object.hasOwn(kitchen.stations, recipe.station), "Unknown station for " + id);
    integer(recipe.batchSize, 1, "batchSize for " + id);
    range(recipe.seconds, 1, "seconds for " + id);
  }
}
function lines(items, recipes) {
  check(Array.isArray(items) && items.length > 0, "Expected a non-empty item list");
  const seen = new Set();
  return items.map(item => {
    check(typeof item?.id === "string" && Object.hasOwn(recipes, item.id), "Unknown dish: " + item?.id);
    check(!seen.has(item.id), "Duplicate dish: " + item.id);
    seen.add(item.id);
    return {id:item.id, remaining:integer(item.qty, 1, "quantity", 20), active:[], recipe:recipes[item.id]};
  }).sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function applyProgress(orders, progress, capturedAt, stations) {
  if (progress === undefined) return;
  check(progress?.capturedAt === capturedAt && Array.isArray(progress.lines), "Progress must belong to this snapshot");
  const lookup = new Map(orders.map(order => [order.id, order]));
  const seen = new Set(), busy = new Map();
  for (const row of progress.lines) {
    const line = lookup.get(row?.orderId)?.lines.find(item => item.id === row.dishId);
    check(line, "Progress references an unknown active order or dish");
    check(!seen.has(line), "Duplicate progress line");
    seen.add(line);
    line.remaining -= integer(row.doneQty, 0, "doneQty", line.remaining);
    check(Array.isArray(row.inFlight), "Expected inFlight batches");
    for (const batch of row.inFlight) {
      line.remaining -= integer(batch?.qty, 1, "in-flight quantity", Math.min(line.remaining, line.recipe.batchSize));
      range(batch.remainingSeconds, 0, "remainingSeconds");
      line.active.push(batch.remainingSeconds);
      const station = line.recipe.station;
      busy.set(station, (busy.get(station) ?? 0) + 1);
      check(busy.get(station) <= stations[station], "Too many in-flight batches at " + station);
    }
  }
}
function schedule(orders, capacities, bound) {
  const queues = new Map(Object.keys(capacities).map(station => [station, []]));
  const ends = orders.map(() => new Map());
  function record(index, station, seconds) {
    ends[index].set(station, Math.max(ends[index].get(station) ?? 0, seconds));
  }
  for (const [index, order] of orders.entries()) {
    for (const line of order.lines) {
      const station = line.recipe.station;
      record(index, station, 0);
      for (const remaining of line.active) {
        queues.get(station).push(remaining[bound]);
        record(index, station, remaining[bound]);
      }
    }
  }
  for (const [index, order] of orders.entries()) {
    for (const {recipe, remaining} of order.lines) {
      const laneEnds = queues.get(recipe.station);
      const batches = Math.ceil(remaining / recipe.batchSize);
      for (let batch = 0; batch < batches; batch++) {
        let lane = laneEnds.length, start = 0;
        if (laneEnds.length === capacities[recipe.station]) {
          lane = 0;
          for (let i = 1; i < laneEnds.length; i++) if (laneEnds[i] < laneEnds[lane]) lane = i;
          start = laneEnds[lane];
        }
        const end = integer(start + recipe.seconds[bound], 0, "finish time");
        laneEnds[lane] = end;
        record(index, recipe.station, end);
      }
    }
  }
  return ends;
}

export function estimate(snapshot, kitchen, {progress, cart} = {}) {
  validateKitchen(kitchen);
  check(snapshot?.format === "hey-table.station-orders.v1" && Array.isArray(snapshot.orders), "Expected a Hey Table station export");
  const at = integer(snapshot.capturedAt, 0, "capturedAt", 8640000000000000);
  const through = integer(snapshot.throughId, 0, "throughId");
  const orders = [], seen = new Set();
  for (const row of snapshot.orders) {
    const id = integer(row?.id, 1, "order id", through);
    check(!seen.has(id), "Duplicate order id");
    seen.add(id);
    if (inactive.has(row.status)) continue;
    check(row.status === "preparing", "Unknown order status");
    orders.push({id, created:integer(row.created, 0, "created", at), lines:lines(row.items, kitchen.recipes)});
  }
  check(seen.size ? seen.has(through) : through === 0, "Snapshot does not contain its last order id");
  orders.sort((a,b) => a.created - b.created || a.id - b.id);
  applyProgress(orders, progress, at, kitchen.stations);
  if (cart !== undefined) orders.push({id:null, lines:lines(cart?.items, kitchen.recipes)});
  const fast = schedule(orders, kitchen.stations, 0);
  const slow = schedule(orders, kitchen.stations, 1);
  const estimates = orders.map((order, i) => {
    const stations = Object.fromEntries([...fast[i]].map(([k, v]) => [k, [v, slow[i].get(k)]]));
    const seconds = [Math.max(...fast[i].values()), Math.max(...slow[i].values())];
    const readyAt = seconds.map(s => new Date(integer(at + s * 1000, 0, "ready timestamp", 8640000000000000)).toISOString());
    return {orderId:order.id, seconds, readyAt, stations};
  });
  const quote = cart === undefined ? null : estimates.pop();
  return {capturedAt:at, orders:estimates, quote};
}
