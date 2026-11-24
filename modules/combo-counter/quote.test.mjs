import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {quoteCombos} from "@peca12968/combo-counter";

const example = name => JSON.parse(readFileSync(new URL("./examples/"+name+".json", import.meta.url), "utf8"));
const menu = example("menu"), promotions = example("promotions"), cart = example("cart");

test("reassign the best-looking pair to save another NT$30", () => {
  const out = quoteCombos(menu,promotions,cart);
  assert.deepEqual([out.subtotal,out.discount,out.total], [490,75,415]);
  assert.deepEqual(out.bundles.map(b=>[b.id,b.qty]), [["chicken-gyoza",1],["pork-tea",1]]);
  assert.deepEqual(out.lines.map(l=>[l.id,l.total]), [["gyoza",72],["katsudon",162],["oyakodon",143],["sencha",38]]);
  assert.equal(quoteCombos(menu,promotions,cart.filter(line=>line.id!=="sencha")).discount,45);
  assert.deepEqual(quoteCombos(menu,promotions,cart.map(line=>({...line,price:0,discount:999}))), out);
});

const two = [{id:"a",price:5},{id:"b",price:5}];
const pair = (id, price, limit) => ({id,main:"a",side:"b",price,...(limit===undefined?{}:{limit})});
const both = qty => two.map(({id})=>({id,qty}));

test("parallel offers consume a per-order allowance once; unhelpful offers stay unused", () => {
  const rules = [pair("early",5,1),pair("usual",8),pair("full",10),pair("disabled",0,0)];
  const result = quoteCombos(two,rules,both(3));
  assert.deepEqual(result.bundles.map(b=>[b.id,b.qty]), [["early",1],["usual",2]]);
  assert.equal(result.total,21);
  assert.deepEqual(result.bundles.map(b=>[b.mainUnitDiscount,b.sideUnitDiscount]), [[3,2],[1,1]]);
  assert.equal(quoteCombos(two,[pair("overpriced",11)],both(2)).total,20);
  assert.equal(quoteCombos(two,rules,[]).total,0);
});

test("use exact whole-dollar shares at the JSON integer boundary and batch large quantities", () => {
  const limit = Number.MAX_SAFE_INTEGER;
  const rows = [{id:"a",price:limit-2},{id:"b",price:2}];
  const out = quoteCombos(rows,[pair("zero",0)],both(1));
  assert.deepEqual(out.lines.map(l=>l.discount), [limit-2,2]);
  assert.equal(out.total,0);
  assert.throws(()=>quoteCombos(rows,[],both(2)),/safe integer/);
  const bulk = quoteCombos(two,[pair("volume",1)],both(1_000_000_000));
  assert.equal(bulk.bundles[0].qty,1_000_000_000);
  assert.equal(bulk.total,1_000_000_000);
});

test("validate menu, rule roles, quantities, limits and identifiers before pricing", () => {
  for (const [m,p,c] of [
    [[...two,two[0]],[],[]], [two,[pair("x",1),pair("x",2)],[]],
    [two,[{...pair("loop",2),side:"a"}],[]],
    [two,[pair("x",1),{id:"y",main:"b",side:"a",price:0}],[]],
    [two,[{...pair("unknown",1),main:"c"}],[]], [two,[pair("x",0,-1)],[]],
    [two,[pair("x",0,null)],[]], [two,[pair("x",0.5)],[]],
    [two,[],[{id:"missing",qty:1}]], [two,[],[{id:"a",qty:true}]],
    [two,[],[...both(1),{id:"a",qty:1}]], [two,[],both(0)]
  ]) assert.throws(()=>quoteCombos(m,p,c));
});

test("a long alternating path can replace two assignments; equal savings need fewer bundles", () => {
  const rows = ["a","b","c","x","y","z"].map(id=>({id,price:10}));
  const qty = rows.map(({id})=>({id,qty:1}));
  const rule = (main,side,saving) => ({id:main+side,main,side,price:20-saving});
  const offers = [rule("a","x",10),rule("b","y",10),rule("c","x",9),rule("a","y",9),rule("b","z",9)];
  const chosen = quoteCombos(rows,offers,qty);
  assert.deepEqual(chosen.bundles.map(b=>b.id),["ay","bz","cx"]);
  assert.equal(chosen.discount,27);
  const tied = quoteCombos(rows,[rule("a","x",10),rule("a","y",5),rule("b","x",5)],qty);
  assert.deepEqual(tied.bundles.map(b=>b.id),["ax"]);
  assert.equal(tied.discount,10);
});

function enumerate(menu, rules, cart) {
  const prices = new Map(menu.map(d=>[d.id,d.price]));
  const left = new Map(cart.map(l=>[l.id,l.qty]));
  let best = {saving:0,count:0};
  function visit(i, saving, count) {
    if (i===rules.length) {
      if (saving>best.saving || (saving===best.saving && count<best.count)) best = {saving,count};
      return;
    }
    const r=rules[i], m=left.get(r.main)??0, s=left.get(r.side)??0;
    const max=Math.min(m,s,r.limit??Infinity);
    const unit=prices.get(r.main)+prices.get(r.side)-r.price;
    for (let n=0; n<=max; n++) {
      left.set(r.main,m-n); left.set(r.side,s-n);
      visit(i+1,saving+n*unit,count+n);
    }
    left.set(r.main,m); left.set(r.side,s);
  }
  visit(0,0,0);
  return best;
}

function checkReceipt(out, menu, rules, cart) {
  const prices = new Map(menu.map(d=>[d.id,d.price]));
  const usage = new Map(), discount = new Map();
  for (const b of out.bundles) {
    const r = rules.find(r=>r.id===b.id);
    assert.ok(r && b.qty>0 && b.qty<=(r.limit??Infinity));
    assert.deepEqual([r.main,r.side,r.price], [b.main,b.side,b.unitPrice]);
    const unitRetail = prices.get(b.main) + prices.get(b.side);
    const saving = unitRetail - r.price;
    const mainDiscount = Math.round(saving * prices.get(b.main) / unitRetail);
    assert.deepEqual([b.mainUnitDiscount,b.sideUnitDiscount,b.unitSavings], [mainDiscount,saving-mainDiscount,saving]);
    for (const [id,share] of [[b.main,b.mainUnitDiscount],[b.side,b.sideUnitDiscount]]) {
      usage.set(id,(usage.get(id)??0)+b.qty);
      discount.set(id,(discount.get(id)??0)+share*b.qty);
    }
  }
  assert.deepEqual(out.lines.map(line=>line.id).sort(),cart.map(item=>item.id).sort());
  for (const line of out.lines) {
    assert.equal(line.price,prices.get(line.id));
    assert.equal(line.qty,cart.find(item=>item.id===line.id).qty);
    assert.equal(line.paired,usage.get(line.id)??0);
    assert.ok(line.paired<=line.qty && line.total>=0);
    assert.equal(line.discount,discount.get(line.id)??0);
    assert.equal(line.total,line.price*line.qty-line.discount);
  }
  assert.equal(out.lines.reduce((n,l)=>n+l.total,0),out.total);
  assert.equal(out.subtotal-out.discount,out.total);
}

test("512 carts match exhaustive bundle allocations, minimum pair count and per-line accounting", () => {
  let state = 77261;
  function random(n) {
    state = (Math.imul(1664525,state)+1013904223)>>>0;
    return Math.floor(state/2**32*n);
  }
  const ids = ["m1","m2","m3","s1","s2","s3"];
  for(let k=0; k<512; k++) {
    const rows = ids.map(id=>({id,price:random(21)}));
    const qty = ids.map(id=>({id,qty:random(4)})).filter(line=>line.qty);
    const rules = Array.from({length:1+random(9)},(_,i)=>({
      id:"r"+i,main:ids[random(3)],side:ids[3+random(3)],price:random(36),
      ...(random(2)?{limit:random(4)}:{})
    }));
    const out = quoteCombos(rows,rules,qty);
    assert.deepEqual({saving:out.discount,count:out.bundles.reduce((n,b)=>n+b.qty,0)},enumerate(rows,rules,qty));
    checkReceipt(out,rows,rules,qty);
    assert.deepEqual(quoteCombos(rows.reverse(),rules.reverse(),qty.reverse()),out);
  }
});

test("CLI emits the same receipt as the package entry point", () => {
  const root=fileURLToPath(new URL(".",import.meta.url));
  const result=spawnSync(process.execPath,["cli.mjs","examples/menu.json","examples/promotions.json","examples/cart.json"],
    {cwd:root,encoding:"utf8"});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),quoteCombos(menu,promotions,cart));
  const bad=spawnSync(process.execPath,["cli.mjs","examples/menu.json","examples/promotions.json","examples/menu.json"],
    {cwd:root,encoding:"utf8"});
  assert.equal(bad.status,2);
  assert.equal(bad.stdout,"");
});
