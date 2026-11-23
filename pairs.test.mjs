import assert from "node:assert/strict";
import {test} from "node:test";
import {copyFileSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {MenuPairs, evaluate} from "./pairs.mjs";
import {train, holdout} from "./snapshot.mjs";
import {seed} from "./examples/seed.mjs";

const config = {offers: ["gyoza", "sencha"], minPair: 2, k: 1};
function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "menu pairs #"));
  t.after(() => rmSync(temp, {recursive: true, force: true}));
  return {...seed(join(temp, "two snapshots"), process.env.HEY_TABLE_MIGRATIONS), temp};
}

function edit(path, action) {
  const db = new DatabaseSync(path);
  try { action(db); } finally { db.close(); }
}

test("actual command recommends a side and compares identical held-out orders", t => {
  const {first, second} = fixture(t);
  const before = readFileSync(first);
  const cli = fileURLToPath(new URL("./menu-pairs.mjs", import.meta.url));
  const configs = fileURLToPath(new URL("./examples/config.json", import.meta.url));
  const cart = fileURLToPath(new URL("./examples/cart.json", import.meta.url));
  function run(...args) {
    const r = spawnSync(process.execPath, [cli, ...args], {encoding: "utf8"});
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }
  const {trainingOrders, suggestions: [suggestion]} = run("recommend", first, configs, cart);
  assert.equal(trainingOrders, 11);
  assert.equal(suggestion.id, "gyoza");
  assert.equal(suggestion.evidence.together, 4);
  assert.equal(suggestion.evidence.ordersWithAnchor, 5);
  assert.deepEqual(run("evaluate", first, configs, second), {
    trainingOrders: 11, k: 1, completedOrders: 8, evaluated: 7, noAnchor: 1, withoutAddOn: 1,
    recommendationHits: 5, popularityHits: 3,
    paired: {bothHit: 2, recommendationOnly: 3, popularityOnly: 1, bothMiss: 1}
  });
  assert.deepEqual(readFileSync(first), before);
});

test("model freezes completion status, ignores line order, rejects divergent snapshots", t => {
  const {first, second} = fixture(t);
  const trained = train(first, config);
  edit(second, db => {
    const lines = JSON.parse(db.prepare("SELECT items FROM orders WHERE id=1").get().items);
    db.prepare("UPDATE orders SET items=?, note='changed' WHERE id=1").run(JSON.stringify(lines.reverse()));
  });
  assert.equal(holdout(second, trained).evaluated, 7);
  edit(second, db => db.exec("DELETE FROM orders WHERE id=12"));
  assert.throws(() => holdout(second, trained), /training order history/);
});

test("backdated new sales and malformed paid portions cannot silently change evidence", t => {
  const {first, second, temp} = fixture(t);
  const trained = train(first, config);
  edit(second, db => db.exec("UPDATE orders SET created=1 WHERE id=14"));
  assert.throws(() => holdout(second, trained), /predates/);
  const broken = join(temp, "broken.db");
  copyFileSync(first, broken);
  edit(broken, db => db.prepare("UPDATE orders SET items=? WHERE id=3").run('[{"id":"sencha","qty":0}]'));
  assert.throws(() => train(broken, config), /quantity/);
  assert.throws(() => train(join(temp, "missing.db"), config));
});

test("multiple portions count once, sold-out or selected dishes are excluded, cold cart uses popularity", () => {
  const model = new MenuPairs({...config, k: 3});
  assert.deepEqual(model.rank(["unknown"]), []);
  model.observe(["sencha", "katsudon", "sencha"]);
  model.observe(["katsudon", "gyoza"]);
  model.observe(["sencha"]);
  assert.equal(model.rank(["katsudon"])[0].evidence, null);
  assert.equal(model.rank(["unknown"])[0].ordersWithOffer, 2);
  assert.deepEqual(model.rank(["katsudon", "sencha"], ["gyoza"]), []);
  model.observe(["katsudon", "gyoza"]);
  assert.equal(model.rank(["katsudon"], ["sencha"])[0].evidence.together, 2);
  assert.deepEqual(evaluate(model, []).paired, {bothHit: 0, bothMiss: 0, recommendationOnly: 0, popularityOnly: 0});
});

test("a changed buying pattern can favor the popularity baseline", () => {
  const model = new MenuPairs(config);
  for (let i=0; i<8; i++) model.observe(["oyakodon", "sencha"]);
  for (let i=0; i<4; i++) model.observe(["katsudon", "gyoza"]);
  const report = evaluate(model, Array.from({length: 6}, () => ["katsudon", "sencha"]));
  assert.equal(report.paired.popularityOnly, 6);
  assert.equal(report.recommendationHits, 0);
});

test("rankings agree with recounting original baskets for 256 generated histories", () => {
  let state = 735921;
  function next() {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 2**32;
  }
  const dishes = ["a", "b", "x", "y", "z"];
  for (let run=0; run<256; run++) {
    const offers = ["x", "y", "z"], minPair = 1 + run % 4;
    const model = new MenuPairs({offers, minPair, k: 3});
    const baskets = Array.from({length: 8+run%17}, () => {
      const subset = dishes.filter(() => next() < 0.45);
      return subset.length ? subset : ["a"];
    });
    for (const basket of baskets) model.observe(basket);
    const cart = ["a", "b"];
    const expected = [];
    for (const id of offers) {
      const n = baskets.filter(b => b.includes(id)).length;
      if (!n) continue;
      const scores = [];
      for (const anchor of cart) {
        const matched = baskets.filter(b => b.includes(anchor));
        const both = matched.filter(b => b.includes(id)).length;
        if (both >= minPair) scores.push((both + 2*(n/baskets.length))/(matched.length+2));
      }
      expected.push({id, n, score: scores.length ? Math.max(...scores) : n/baskets.length});
    }
    expected.sort((a,b) => b.score-a.score || b.n-a.n || a.id.localeCompare(b.id));
    assert.deepEqual(model.rank(cart).map(r => r.id), expected.map(r => r.id));
  }
});
