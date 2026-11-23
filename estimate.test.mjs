import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {estimate} from "./estimate.mjs";

const fixture = name => JSON.parse(readFileSync(new URL("./examples/" + name + ".json", import.meta.url)));
const snapshot = fixture("stations"), kitchen = fixture("kitchen"), cart = fixture("cart"), progress = fixture("progress");
test("parallel stations and split batches set the order and cart windows", () => {
  const plan = estimate(snapshot, kitchen, {cart});
  assert.deepEqual(plan.orders.map(o => [o.orderId, o.seconds]), [[17,[480,600]], [18,[420,540]]]);
  assert.deepEqual(plan.quote.stations, {hot:[660,840], bar:[180,270]});
  assert.deepEqual(plan.quote.seconds, [660,840]);
  assert.deepEqual(plan.quote.readyAt, ["2026-11-23T04:11:00.000Z","2026-11-23T04:14:00.000Z"]);
  assert.deepEqual(estimate({...snapshot, orders:snapshot.orders.toReversed()}, kitchen, {cart}), plan);
  assert.deepEqual(estimate(snapshot, kitchen).orders, plan.orders);
});
test("started batches reserve their lanes and completed quantities never restart", () => {
  const quote = estimate(snapshot, kitchen, {cart, progress}).quote;
  assert.deepEqual(quote.seconds, [465,600]);
  const other = structuredClone(progress);
  other.lines.push({orderId:18, dishId:"karaage", doneQty:0, inFlight:[{qty:2, remainingSeconds:[30,40]}]});
  const plan = estimate(snapshot, kitchen, {cart, progress:other});
  assert.deepEqual(plan.orders[0].stations.hot, [270,340]);
  assert.deepEqual(plan.orders[1].stations.hot, [30,40]);
  other.lines = snapshot.orders.filter(r => r.status === "preparing").flatMap(r => r.items.map(item =>
    ({orderId:r.id, dishId:item.id, doneQty:item.qty, inFlight:[]})));
  assert.deepEqual(estimate(snapshot, kitchen, {progress:other}).orders.map(o=>o.seconds), [[0,0],[0,0]]);
});
test("reject stale, overbooked or ambiguous inputs", () => {
  for (const change of [
    p=>p.capturedAt--, p=>p.lines.push(p.lines[0]), p=>p.lines[0].orderId=19,
    p=>p.lines[0].inFlight[0].qty=2, p=>p.lines[0].doneQty=3,
    p=>p.lines[0].inFlight[0].remainingSeconds=[60,50],
    p=>{p.lines[0].doneQty=0;p.lines[0].inFlight=Array(3).fill({qty:1,remainingSeconds:[2,4]});}
  ]) {
    const p = structuredClone(progress); change(p);
    assert.throws(()=>estimate(snapshot,kitchen,{progress:p}));
  }
  const bad = structuredClone(snapshot); bad.orders[1].status="paused";
  assert.throws(()=>estimate(bad,kitchen), /status/);
  assert.throws(()=>estimate({...snapshot,throughId:20},kitchen), /last order/);
  assert.throws(()=>estimate({...snapshot,orders:[...snapshot.orders,snapshot.orders[0]]},kitchen), /Duplicate/);
  assert.throws(()=>estimate(snapshot,kitchen,{cart:{items:[{id:"unknown",qty:1}]}}), /Unknown dish/);
});
test("empty kitchens quote a single batch; closed and unaccepted tickets consume no lane", () => {
  const empty = {...snapshot, throughId:0, orders:[]};
  for (const state of ["ready","pending","cancelled","completed"]) {
    const finished = {...snapshot, orders:snapshot.orders.map(r=>({...r,status:state}))};
    assert.deepEqual(estimate(finished,kitchen,{cart}), estimate(empty,kitchen,{cart}));
  }
  assert.deepEqual(estimate(empty,kitchen,{cart}).quote.seconds, [240,300]);
});
test("729 independent tick-by-tick schedules attain both reported bounds", () => {
  const recipes = {x:{station:"hot", batchSize:1,seconds:[1,3]}, y:{station:"bar",batchSize:2,seconds:[1,3]}};
  const model = {stations:{hot:2,bar:1}, recipes};
  const sample = {format:snapshot.format,capturedAt:1000,throughId:2,orders:[
    {id:2, created:1,status:"preparing",items:[{id:"y",qty:1},{id:"x",qty:1}]},
    {id:1, created:1,status:"preparing",items:[{id:"x",qty:2},{id:"y",qty:2}]}
  ]};
  const report = estimate(sample,model,{cart:{items:[{id:"x",qty:1}]}});
  const bounds = [...report.orders, report.quote].map(r=>r.seconds);
  const observed = Array.from({length:3},()=>[Infinity,0]);
  // Each station releases simultaneous completions before taking waiting batches at that tick.
  for (let variant=0; variant<3**6; variant++) {
    const durations = Array.from({length:6},(_,i)=>1+Math.floor(variant/3**i)%3);
    const owners = [0,0,1,2,0,1], ends = [0,0,0];
    for (const [waiting,slots] of [[[0,1,2,3],2],[[4,5],1]]) {
      let cooking = [], tick = 0;
      while (waiting.length || cooking.length) {
        for (const task of cooking.filter(t=>t.end===tick)) ends[owners[task.id]] = Math.max(ends[owners[task.id]],tick);
        cooking = cooking.filter(t=>t.end>tick);
        while (waiting.length && cooking.length < slots) {
          const id=waiting.shift(); cooking.push({id,end:tick+durations[id]});
        }
        tick++;
      }
    }
    for (let i=0; i<3; i++) {
      assert.ok(ends[i]>=bounds[i][0] && ends[i]<=bounds[i][1]);
      observed[i]=[Math.min(observed[i][0],ends[i]),Math.max(observed[i][1],ends[i])];
    }
  }
  assert.deepEqual(observed,bounds);
});
test("CLI returns machine-readable output and a nonzero code for missing input", () => {
  const run = (...args)=>spawnSync(process.execPath,["cli.mjs",...args],{cwd:new URL(".",import.meta.url),encoding:"utf8"});
  const ok=run("examples/stations.json","examples/kitchen.json","--cart","examples/cart.json");
  assert.equal(ok.status,0); assert.deepEqual(JSON.parse(ok.stdout).quote.seconds,[660,840]);
  const bad=run("absent.json","examples/kitchen.json"); assert.equal(bad.status,2); assert.equal(bad.stdout,"");
});
