import {createHash} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {MenuPairs, evaluate} from "./pairs.mjs";

function withSnapshot(path, action) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    db.exec("BEGIN");
    return action(db);
  } finally {
    db.close();
  }
}

function quantities(serialized) {
  const rows = JSON.parse(serialized);
  if (!Array.isArray(rows) || !rows.length) throw new Error("order has no lines");
  const counts = new Map();
  for (const row of rows) {
    if (!row || typeof row.id !== "string" || !row.id.trim() || !Number.isSafeInteger(row.qty) || row.qty < 1) {
      throw new Error("invalid order dish ID or quantity");
    }
    const sum = (counts.get(row.id) ?? 0) + row.qty;
    if (!Number.isSafeInteger(sum)) throw new Error("order quantity overflow");
    counts.set(row.id, sum);
  }
  return counts;
}

function prefix(db, throughId, model) {
  const hash = createHash("sha256");
  let lastId = 0, lastTime = 0;
  const query = db.prepare("SELECT id,created,items,status FROM orders WHERE id<=? ORDER BY id");
  for (const row of query.iterate(throughId)) {
    if (!Number.isSafeInteger(row.id) || row.id < 1 || !Number.isSafeInteger(row.created) || row.created < 0) {
      throw new Error("invalid order ID or timestamp");
    }
    const items = quantities(row.items);
    const ids = [...items.keys()].sort();
    hash.update(JSON.stringify([row.id, row.created, ids.map(id => [id, items.get(id)])]) + "\n");
    lastId = row.id;
    lastTime = Math.max(lastTime, row.created);
    if (model && row.status === "completed") model.observe(ids);
  }
  return {lastId, lastTime, digest: hash.digest("hex")};
}

export function train(path, config) {
  return withSnapshot(path, db => {
    const model = new MenuPairs(config);
    const history = prefix(db, Number.MAX_SAFE_INTEGER, model);
    return {model, history};
  });
}

export function holdout(path, trained) {
  return withSnapshot(path, db => {
    const {model, history} = trained;
    if (prefix(db, history.lastId).digest !== history.digest) {
      throw new Error("later snapshot does not contain the training order history");
    }
    const rows = db.prepare("SELECT created,items FROM orders WHERE id>? AND status='completed' ORDER BY id");
    function* baskets() {
      for (const row of rows.iterate(history.lastId)) {
        if (!Number.isSafeInteger(row.created) || row.created < history.lastTime) {
          throw new Error("new completed order predates the training history");
        }
        yield [...quantities(row.items).keys()];
      }
    }
    return evaluate(model, baskets());
  });
}
