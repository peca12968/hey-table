import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {execFileSync,spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {api} from "../server/api.mjs";
import {settings,lookup} from "../server/tappay.mjs";
import {paymentPrime,openPaymentUrl} from "../lib/tappay-client.mjs";
import {comparePaymentHandoffSummaries,readPaymentHandoffSummary} from "../lib/payment-handoff-compare.mjs";
import {planSupplyReview,supplyReviewRows} from "../lib/supply-review.mjs";
import {matchesPrepOrderSource,prepArrivalReportFormat,prepOrderSource,readPrepArrivalReport,
  readPrepReadinessReport} from "../lib/prep-readiness-report.mjs";
import {forecastPrepReadiness,prepReadinessPlanner} from "../lib/prep-readiness.mjs";
import {readProcurementSnapshot,summarizeIncomingOrders} from "../lib/prep-procurement.mjs";
import {quotePantryPurchase} from "../lib/pantry-purchase.mjs";
import {dishes} from "../lib/menu.mjs";
import {sqliteD1} from "../scripts/sqlite-d1.mjs";
import {applyDemoMigrations} from "../scripts/apply-demo-migrations.mjs";
import {buildReturnLedgerDemo} from "../scripts/return-ledger-demo.mjs";
import {buildPaymentAttentionDemo} from "../scripts/payment-attention-demo.mjs";
import {buildPickupPassHandoffDemo} from "../scripts/pickup-pass-handoff-demo.mjs";
import {buildPickupRosterFollowUpDemo} from "../scripts/pickup-roster-followup-demo.mjs";
import {buildCustomerPaymentRecoveryDemo} from "../scripts/customer-payment-recovery-demo.mjs";
import {buildCartSupplyReviewDemo} from "../scripts/cart-supply-review-demo.mjs";
import {bookablePickupSlots} from "../lib/pickup-slots.mjs";
import {stationReview,stationReviewDigest} from "../lib/kitchen-timing.mjs";
import {cartShareLink,readCartShare,readCartShareAddress} from "../lib/cart-share.mjs";
import {quoteReturn,remainingReturnLots,returnLots} from "../modules/receipt-returns/quote.mjs";

const env={TAPPAY_MODE:"sandbox",TAPPAY_APP_ID:"123",TAPPAY_APP_KEY:"test-public",TAPPAY_PARTNER_KEY:"test-only",
  TAPPAY_SITE_ORIGIN:"https://order.example",TAPPAY_NOTIFY_URL:"https://notify.example/api/payments/notify"};
const ref="H0123456789ABCDEF00";
const attempt={reference:ref,created:Date.now(),merchant:"fixture",trade_id:"known"};
const data={bank_transaction_id:ref,rec_trade_id:"known",merchant_id:"fixture",payment_method:"px_pay_plus",original_amount:190};
const order={total:190,payment_method:"px_pay_plus"};
const reply=record=>async()=>Response.json({status:0,trade_records:[record]});
test("shared carts encode only item IDs and quantities and reject malformed or oversized links",()=>{
  const sample=[{id:"sencha",qty:2,note:"private item note",price:45},{id:"retired-dessert",qty:20,table:"A03"}];
  const url=new URL(cartShareLink("https://order.example",sample));
  assert.equal(url.pathname,"/");
  assert.equal(url.search,"");
  const value=new URLSearchParams(url.hash.slice(1)).get("cart");
  assert.deepEqual(readCartShare(value),[{id:"sencha",qty:2},{id:"retired-dessert",qty:20}]);
  assert.equal(cartShareLink("https://order.example",[sample[0],sample[0]]),"");
  for(const invalid of ["1.","2.sencha:2","1.sencha:0","1.sencha:21","1.sencha:1e1","1.sencha:01",
    "1.sencha:1:2","1.sencha:1,sencha:1","1.<b>:1","1.__proto__:1","1."+("x".repeat(1300))+":1",
    "1."+Array.from({length:25},(_,i)=>"dish-"+i+":1").join(",")])assert.equal(readCartShare(invalid),null);
});
test("pasted cart links must use the menu origin and return only reviewed items",()=>{
  const origin="https://order.example",fragment="#cart=1.sencha%3A2";
  assert.deepEqual(readCartShareAddress("  "+origin+"/?table=A08"+fragment+"  ",origin),[{id:"sencha",qty:2}]);
  for(const invalid of ["https://another.example/"+fragment,origin+"/ticket"+fragment,
    "https://user:password@order.example/"+fragment,"javascript:"+fragment,
    "http://order.example/"+fragment,origin+":444/"+fragment,"/"+fragment,
    origin+"/#reorder=example",origin+"/"+fragment+"&cart=1.sencha%3A1",
    origin+"/?extra="+"x".repeat(4100)+fragment])assert.equal(readCartShareAddress(invalid,origin),null);
});
test("partial-return quotes recover frozen price lots and reject inconsistent receipts",()=>{
  const ticket=JSON.parse(readFileSync(new URL("../modules/receipt-returns/examples/ticket.json",import.meta.url),"utf8"));
  const pricing=returnLots(ticket);
  const returns=(...entries)=>quoteReturn(pricing,new Map(entries));
  assert.deepEqual(returns(["gyoza",1]),{lines:[{dish:"gyoza",bundle:null,qty:1,unit:85,amount:85}],amount:85,remainingValue:260});
  assert.deepEqual(returns(["gyoza",2]),{lines:[
    {dish:"gyoza",bundle:null,qty:1,unit:85,amount:85},
    {dish:"gyoza",bundle:"chicken-gyoza",qty:1,unit:72,amount:72},
  ],amount:157,remainingValue:188});
  const first=returns(["gyoza",1]);
  const following=remainingReturnLots(pricing,[first]);
  assert.equal(quoteReturn(following,new Map([["gyoza",1]])).amount,72);
  assert.throws(()=>remainingReturnLots(pricing,[first,first]),/計價資料不完整/);
  const second=quoteReturn(following,new Map([["gyoza",1]]));
  const corrected=remainingReturnLots(pricing,[{...first,voided:{revision:3}},second]);
  assert.equal(corrected.total,273);
  assert.equal(quoteReturn(corrected,new Map([["gyoza",1]])).amount,85);
  assert.equal(returns(["gyoza",1]).amount,85);
  assert.equal(returns(["sencha",1],["gyoza",2],["oyakodon",1]).remainingValue,0);
  assert.throws(()=>returns(["gyoza",3]),/超出原單/);
  assert.throws(()=>returns(["wrong-dish",1]),/超出原單/);
  assert.throws(()=>returns(["gyoza",0]),/正整數/);
  assert.throws(()=>returns(),/至少/);
  const plain=returnLots({items:[{id:"legacy_free",price:0,qty:2},{id:"legacy_tea",price:38,qty:1}],total:38});
  const free=quoteReturn(plain,new Map([["legacy_free",2]]));
  assert.equal(free.amount,0);
  assert.throws(()=>quoteReturn(remainingReturnLots(plain,[free]),new Map([["legacy_free",1]])),/超出原單/);
  assert.equal(quoteReturn(plain,new Map([["legacy_tea",1]])).amount,38);
  for(const alter of [
    value=>value.total++,
    value=>value.items.push(value.items[0]),
    value=>value.combo.version="future",
    value=>value.combo.quote.bundles[0].qty++,
    value=>{value.combo.quote.bundles[0].mainUnitDiscount++;value.combo.quote.bundles[0].sideUnitDiscount--;},
    value=>value.combo.quote.lines[0].discount++,
  ]){
    const damaged=structuredClone(ticket);
    alter(damaged);
    assert.throws(()=>returnLots(damaged),/計價資料不完整/);
  }
});
test("enable only configured methods and expose only SDK keys",()=>{
  assert.deepEqual(settings({...env,TAPPAY_MERCHANT_PX_PAY_PLUS:"test"}),{mode:"sandbox",methods:["cash","px_pay_plus"],appId:123,appKey:"test-public"});
  assert.deepEqual(settings({...env,TAPPAY_MODE:"invalid"}).methods,["cash"]);
  assert.deepEqual(settings({...env,TAPPAY_NOTIFY_URL:""}).methods,["cash"]);
  assert.deepEqual(settings({...env,TAPPAY_MERCHANT_PLUS_PAY:"plus-only"}).methods,["cash","plus_pay"]);
});
test("SDK 5.26 wallet promises, callback providers and card fields yield their own primes",async()=>{
  for(const [method,provider] of [["easy_wallet","easyWallet"],["pi_wallet","piWallet"],["plus_pay","plusPay"]]){
    const sdk={[provider]:{async getPrime(...args){
      assert.equal(args.length,0);
      return {status:0,prime:method+"-one-use"};
    }}};
    assert.equal(await paymentPrime(sdk,method),method+"-one-use");
    for(const getPrime of [async()=>{throw Error("wallet cancelled");},async()=>({status:0}),async()=>({status:1,prime:"invalid"})])
      await assert.rejects(paymentPrime({[provider]:{getPrime}},method),/無法取得付款授權/);
    const visits=[];
    sdk[provider].pay=url=>visits.push(["wallet",url]);
    const location={assign:url=>visits.push(["browser",url])};
    const url="https://wallet.example/checkout";
    openPaymentUrl(sdk,method,url,location);
    openPaymentUrl(undefined,method,url,location);
    assert.deepEqual(visits,[["wallet",url],["browser",url]]);
  }
  for(const [method,provider] of [["line_pay","linePay"],["px_pay_plus","pxPayPlus"],["jko_pay","jkoPay"],["card","card"]]){
    const payload=method==="card"?{card:{prime:method}}:{prime:method};
    const sdk={[provider]:{getPrime:callback=>callback({status:0,...payload})}};
    assert.equal(await paymentPrime(sdk,method),method);
  }
});
test("match payment, merchant, currency filter, original amount and trade before accepting a record",async()=>{
  for(const [code,state] of [[-1,"failed"],[0,"authorized"],[1,"paid"],[2,"partial"],[3,"refunded"],[4,"pending"],[5,"cancelled"]]){
    assert.deepEqual(await lookup(env,order,attempt,reply({...data,record_status:code})),{state,trade:"known"});
  }
  for(const override of [{currency:"USD"},{original_amount:1},{merchant_id:"other"},{bank_transaction_id:"wrong"},{payment_method:"line_pay"},{rec_trade_id:"other"},{record_status:99}]){
    assert.equal(await lookup(env,order,attempt,reply({...data,record_status:1,...override})),null);
  }
});
function database(beforeMigration=()=>{}){
  const sqlite=new DatabaseSync(":memory:");
  const journal=JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json",import.meta.url)));
  for(const {tag} of journal.entries){
    beforeMigration(tag,sqlite);
    sqlite.exec(readFileSync(new URL("../drizzle/"+tag+".sql",import.meta.url),"utf8"));
  }
  return sqliteD1(sqlite);
}
test("order submission rejects changed payment options without creating an order or consuming a pickup slot",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const now=Date.parse("2026-11-25T12:00:00+08:00"),pickupSlot=Date.parse("2026-11-26T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={...env,DB:db,TAPPAY_MODE:"production",TAPPAY_MERCHANT_LINE_PAY:"live-merchant"};
  const place=(body,settings=runtime)=>api(new Request("https://order.example/api/orders",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
  }),settings);
  const draft={token:crypto.randomUUID(),mode:"pickup",pickupSlot,note:"保留備註",items:[{id:"sencha",qty:1,note:"無冰"}],
    paymentMethod:"line_pay",paymentEnv:"demo"};
  const changed=await place(draft);
  assert.equal(changed.status,409);
  assert.deepEqual(await changed.json(),{code:"payment_environment_changed",error:"付款環境已變更，請重新確認",
    payments:{mode:"production",methods:["cash","line_pay"]}});
  const disabled=await place({...draft,paymentMethod:"px_pay_plus",paymentEnv:"production"});
  assert.equal(disabled.status,409);
  assert.deepEqual(await disabled.json(),{code:"payment_unavailable",error:"此付款方式暫停使用",
    payments:{mode:"production",methods:["cash","line_pay"]}});
  assert.equal((await place({...draft,paymentEnv:"live"})).status,400);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count,0);
  const demo={...runtime,TAPPAY_MODE:"demo"},accepted=await place(draft,demo);
  assert.equal(accepted.status,200);
  const first=await accepted.json();
  assert.equal(first.paymentEnv,"demo");
  assert.equal(first.pickupSlot,pickupSlot);
  assert.equal(first.note,draft.note);
  assert.equal(first.items[0].note,draft.items[0].note);
  assert.deepEqual(await (await place(draft)).json(),first);
  assert.deepEqual(await (await place(draft,{...runtime,TAPPAY_MERCHANT_LINE_PAY:""})).json(),first);
  assert.equal((await place({...draft,paymentEnv:"production"})).status,409);
  const next=await place({...draft,token:crypto.randomUUID(),paymentEnv:"production"});
  assert.equal(next.status,200);
  assert.equal((await next.json()).paymentEnv,"production");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get().count,2);
});

test("changing an untouched payment to cash preserves the booked order and original submission identity",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=Date.parse("2026-11-25T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"};
  const pickupSlot=Date.parse("2026-11-26T12:00:00+08:00");
  const order={token:crypto.randomUUID(),mode:"pickup",pickupSlot,paymentMethod:"line_pay",paymentEnv:"demo",
    note:"原餐單備註",items:[{id:"sencha",qty:1,note:"原單品備註"}]};
  const send=(path,body={},token=order.token)=>api(new Request("https://order.example/api/"+path,{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body),
  }),runtime);
  const read=(path,headers)=>api(new Request("https://order.example/api/"+path,{headers}),runtime);
  const guest={"X-Ticket":order.token},staff={Authorization:"Bearer fixture-staff"};
  const original=await (await send("orders",order)).json();
  const before=await (await read("ticket?progress=1",guest)).json();
  assert.equal(before.paymentDueAt,now+900_000);
  assert.equal((await send("payments/cash",{},crypto.randomUUID())).status,404);
  now+=600_000;
  const changed=now;
  const [a,b]=await Promise.all(Array.from({length:2},()=>send("payments/cash")));
  assert.equal(a.status,200);
  assert.equal(b.status,200);
  const cashPaymentChange={fromMethod:"line_pay",fromEnvironment:"demo",changedAt:changed};
  const confirmation={id:original.id,paymentMethod:"cash",cashPaymentChange};
  assert.deepEqual(await a.json(),confirmation);
  assert.deepEqual(await b.json(),confirmation);
  now+=1_800_000;
  assert.deepEqual(await (await send("payments/cash")).json(),confirmation);
  const ticket=await (await read("ticket?progress=1",guest)).json();
  assert.equal(ticket.paymentDueAt,undefined);
  assert.equal(ticket.cashReceipt,undefined);
  assert.equal(ticket.pickupSlot,pickupSlot);
  assert.equal(ticket.status,"pending");
  assert.deepEqual(await (await send("orders",order)).json(),{...original,paymentMethod:"cash",paymentEnv:"cash",cashPaymentChange});
  assert.equal((await send("orders",{...order,paymentMethod:"cash"})).status,409);
  assert.equal((await send("payments/start")).status,404);
  const booked=await (await read("kitchen/pickup-booking?id="+original.id,staff)).json();
  assert.equal(booked.pickupSlot,pickupSlot);
  assert.equal(booked.paymentMethod,"cash");
  const receipt=await (await read("ticket/order-details",guest)).text();
  assert.match(receipt,/由 LINE Pay 改為現場付款/);
  assert.ok(!receipt.includes(order.token));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM orders").get().n,1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM payment_attempts").get().n,0);
  const immediate={...order,token:crypto.randomUUID(),pickupSlot:undefined};
  const added=await (await send("orders",immediate)).json();
  now+=600_000;
  assert.equal((await send("payments/cash",{},immediate.token)).status,200);
  const queue=async()=>(await (await read("kitchen",staff)).json()).find(row=>row.id===added.id);
  assert.equal((await queue()).overdue,undefined);
  now+=300_000;
  assert.deepEqual((await queue()).overdue,{elapsedMs:300_000,overByMs:0});
});

test("cash conversion and starting payment exclude each other at the database write",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=Date.parse("2026-11-25T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db};
  const send=(path,token,body={},db=runtime.DB)=>api(new Request("https://order.example/api/"+path,{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body),
  }),{...runtime,DB:db});
  const place=async()=>{
    const token=crypto.randomUUID();
    const response=await send("orders",token,{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod:"px_pay_plus"});
    assert.equal(response.status,200);
    return token;
  };
  const first=await place();
  const attempt=(await (await send("payments/start",first)).json()).attempt;
  assert.equal((await send("payments/cash",first)).status,409);
  assert.equal((await send("payments/demo",first,{ref:attempt.ref,outcome:"failed"})).status,200);
  assert.equal((await send("payments/cash",first)).status,409);
  const second=await place();
  let raced=false;
  const interleaved={...db,prepare(sql){
    const statement=db.prepare(sql);
    if(!sql.startsWith("INSERT INTO payment_attempts"))return statement;
    return {...statement,bind(...args){
      const bound=statement.bind(...args);
      return {...bound,async run(){
        raced=true;
        assert.equal((await send("payments/cash",second)).status,200);
        return bound.run();
      }};
    }};
  }};
  const lateStart=await send("payments/start",second,{},interleaved);
  assert.equal(raced,true);
  assert.equal(lateStart.status,409);
  assert.deepEqual(await lateStart.json(),{error:"餐單已改用現場付款"});
  const counts=token=>db.sqlite.prepare(`SELECT payment_method,payment_due_at,status,
    (SELECT count(*) FROM payment_attempts WHERE order_id=orders.id) AS attempts FROM orders WHERE token=?`).get(token);
  assert.equal(counts(first).attempts,1);
  assert.equal(counts(second).attempts,0);
  assert.equal(counts(second).payment_method,"cash");
  assert.equal(counts(second).payment_due_at,null);
  const timed=await place(),legacy=await place();
  db.sqlite.prepare("UPDATE orders SET payment_due_at=NULL WHERE token=?").run(legacy);
  now+=900_000;
  assert.equal((await send("payments/cash",timed)).status,409);
  assert.equal(counts(timed).status,"cancelled");
  assert.equal((await send("payments/cash",legacy)).status,200);
});

test("staff payment lookup distinguishes verified records, missing attempts, mode, retries and failures",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=Date.parse("2026-11-25T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={...env,DB:db,STAFF_KEY:"fixture-staff"};
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created,payment_method,payment_env)
    VALUES (?,'pickup','completed','[]','',190,?,?,?)`);
  const order=(method="px_pay_plus",mode="sandbox")=>Number(insert.run(crypto.randomUUID(),now-60000,method,mode).lastInsertRowid);
  const noAttempt=order(),online=order(),production=order("px_pay_plus","production"),cash=order("cash","cash"),finished=order();
  const save=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,?,?,?)");
  save.run(online,ref,"fixture","authorized",now-60000);
  save.run(production,"alternate-reference","fixture","paid",now-60000);
  save.run(finished,"finished-reference","fixture","refunded",now-60000);
  let times=0,gatewayReply={status:0,trade_records:[{...data,rec_trade_id:"provider-id",record_status:0}]};
  t.mock.method(globalThis,"fetch",async()=>{
    times++;
    if(gatewayReply===null)throw new Error("temporary timeout");
    return Response.json(gatewayReply);
  });
  const check=(id,{key="fixture-staff",runtimeEnv=runtime}={})=>api(new Request("https://order.example/api/kitchen/payment",{
    method:"PATCH",headers:{"Content-Type":"application/json",Authorization:"Bearer "+key},body:JSON.stringify({id})
  }),runtimeEnv);
  const customerCheck=token=>api(new Request("https://order.example/api/payments/check",{
    method:"POST",headers:{"Content-Type":"application/json","X-Ticket":token},body:"{}",
  }),runtime);
  const tokenFor=id=>db.sqlite.prepare("SELECT token FROM orders WHERE id=?").get(id).token;
  const expectOutcome=async(id,outcome,paymentState,options)=>{
    const response=await check(id,options);
    assert.equal(response.status,200);
    assert.equal(response.headers.get("cache-control"),"no-store");
    assert.deepEqual(await response.json(),{ok:true,id,outcome,paymentState});
  };
  assert.equal((await check(online,{key:"guest"})).status,403);
  assert.equal((await check(0)).status,400);
  assert.equal((await check(cash)).status,404);
  await expectOutcome(noAttempt,"noAttempt","unpaid");
  assert.equal((await customerCheck(crypto.randomUUID())).status,404);
  const unpaid=await (await customerCheck(tokenFor(noAttempt))).json();
  assert.deepEqual({...unpaid,attempt:unpaid.attempt??null},{attempt:null,outcome:"noAttempt",paymentState:"unpaid"});
  await expectOutcome(production,"unavailable","paid");
  await expectOutcome(online,"unavailable","authorized",{runtimeEnv:{...runtime,TAPPAY_PARTNER_KEY:""}});
  await expectOutcome(finished,"notQueryable","refunded");
  assert.equal(times,0);
  await expectOutcome(online,"matched","authorized");
  await expectOutcome(online,"recent","authorized");
  assert.equal(times,1);
  now+=5000;
  gatewayReply={status:0,trade_records:[{...data,rec_trade_id:"provider-id",record_status:1,original_amount:1}]};
  const unmatched=await customerCheck(tokenFor(online));
  assert.equal(unmatched.headers.get("cache-control"),"no-store");
  assert.deepEqual(await unmatched.json(),{attempt:{ref,state:"authorized",redirect:null},outcome:"unconfirmed",paymentState:"authorized"});
  now+=5000;
  gatewayReply=null;
  const failure=await check(online);
  assert.equal(failure.status,503);
  assert.deepEqual(await failure.json(),{error:"無法查詢金流，請稍後再查"});
  now+=5000;
  gatewayReply={status:0,trade_records:[{...data,rec_trade_id:"provider-id",record_status:1}]};
  await expectOutcome(online,"matched","paid");
  assert.deepEqual(await (await customerCheck(tokenFor(online))).json(),
    {attempt:{ref,state:"paid",redirect:null},outcome:"recent",paymentState:"paid"});
  assert.equal(times,4);
});
test("payment attention pages unresolved latest attempts across dates without changing orders or exposing credentials",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const now=Date.parse("2026-11-26T00:15:00+08:00"),old=now-3_600_000;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"staff",TAPPAY_MODE:"sandbox",TAPPAY_PARTNER_KEY:"fixture-key"};
  const endpoint="https://order.example/api/kitchen/payment-attention";
  const read=(query="",headers={Authorization:"Bearer staff"})=>api(new Request(endpoint+query,{headers}),runtime);
  const order=db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created,status,payment_method,payment_env,payment_due_at)
    VALUES (?,?,'pickup','不在報表內','[]',45,?,?,?, ?,?)`);
  const attempt=db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,trade_id,redirect_url,state,created,checked)
    VALUES (?,?,'private-merchant',?,'https://example.com/private-payment-link',?,?,?)`);
  function seed(id,method,environment,status,state,at,checked=0){
    order.run(id,crypto.randomUUID(),at-60_000,status,method,environment,old+900_000);
    append(id,state,at,checked);
  }
  function append(id,state,at,checked=0){
    attempt.run(id,crypto.randomUUID(),crypto.randomUUID(),state,at,checked);
  }
  seed(1,"line_pay","sandbox","pending","pending",old);
  seed(2,"px_pay_plus","production","completed","authorized",old,now-5_000);
  seed(3,"line_pay","sandbox","ready","pending",old-1);
  append(3,"paid",old+1);
  seed(4,"cash","cash","pending","pending",old-2);
  seed(5,"jko_pay","demo","cancelled","pending",old+1);
  seed(6,"card","sandbox","pending","pending",now+1);
  for(let id=7;id<=33;id++)seed(id,"line_pay","sandbox","pending","authorized",old+id);

  assert.equal((await read("",{})).status,403);
  for(const filter of ["?state=paid","?state=pending&state=authorized","?method=cash","?environment=live",
    "?after=","?after=5:0","?after=1:9007199254740992","?after=9:3&after=10:3","?summary=0","?summary=1&summary=1"])
    assert.equal((await read(filter)).status,400);
  const first=await read("?summary=1");
  assert.equal(first.headers.get("Cache-Control"),"no-store");
  const page=await first.json();
  assert.equal(page.format,"hey-table.payment-attention.v1");
  assert.equal(page.capturedAt,now);
  assert.deepEqual(page.orders.slice(0,3).map(row=>row.id),[1,2,5]);
  assert.equal(page.orders.length,25);
  assert.equal(page.nextAfter,(old+28)+":28");
  assert.deepEqual(page.orders[0],{id:1,status:"pending",method:"line_pay",environment:"sandbox",total:45,
    paymentDueAt:old+900_000,state:"pending",startedAt:old,checkedAt:null,canCheck:true});
  assert.equal(page.orders[1].checkedAt,now-5_000);
  assert.equal(page.orders[1].canCheck,false);
  assert.equal(page.orders[2].canCheck,false);
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id=1").get().status,"pending");
  assert.deepEqual(page.summary.totals,{orders:30,amount:"1350",pending:2,authorized:28,overdue:2});
  assert.deepEqual(page.summary.filters,{state:null,environment:null,method:null});
  assert.equal(page.summary.capturedAt,page.capturedAt);
  assert.deepEqual(page.summary.groups.find(group=>group.method==="line_pay"),
    {method:"line_pay",environment:"sandbox",orders:28,amount:"1260",pending:1,authorized:27,overdue:1});

  const pending=await (await read("?state=pending&method=line_pay&environment=sandbox&summary=1")).json();
  assert.deepEqual(pending.orders.map(row=>row.id),[1]);
  assert.deepEqual(pending.summary.filters,{state:"pending",environment:"sandbox",method:"line_pay"});
  assert.deepEqual(pending.summary.totals,{orders:1,amount:"45",pending:1,authorized:0,overdue:1});
  append(29,"paid",now);
  const second=await (await read("?summary=1&after="+encodeURIComponent(page.nextAfter))).json();
  assert.deepEqual(second.orders.map(row=>row.id),[30,31,32,33]);
  assert.equal(second.nextAfter,null);
  assert.deepEqual(second.summary.totals,{orders:29,amount:"1305",pending:2,authorized:27,overdue:2});
  assert.equal((await (await read()).json()).summary,undefined);

  const plan=db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT created,order_id FROM payment_attempts
    WHERE state IN ('pending','authorized') AND created<=? AND (created,order_id)>(?,?)
    ORDER BY created,order_id LIMIT 26`).all(now,old,2);
  assert.ok(plan.some(row=>row.detail.includes("payment_attempts_attention_age")));
  assert.ok(plan.every(row=>!row.detail.includes("TEMP B-TREE")));
});

test("payment attention handoff totals remain exact even beyond the SQLite signed integer sum",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const amount=Number.MAX_SAFE_INTEGER,qty=1025,at=Date.parse("2026-11-26T11:00:00+08:00");
  t.mock.method(Date,"now",()=>at+60_000);
  const order=db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created,payment_method,payment_env)
    VALUES (?,?,'pickup','customer note','[]',?,?,'line_pay','demo')`);
  const attempt=db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,created)
    VALUES (?,?,'merchant secret','pending',?)`);
  db.sqlite.exec("BEGIN");
  for(let id=1;id<=qty;id++){
    order.run(id,"customer-token-"+id,amount,at);
    attempt.run(id,"bank-reference-"+id,at);
  }
  db.sqlite.exec("COMMIT");
  const response=await api(new Request("https://order.example/api/kitchen/payment-attention?summary=1",{
    headers:{Authorization:"Bearer staff"},
  }),{DB:db,STAFF_KEY:"staff"});
  const {summary}=await response.json();
  const expected=BigInt(amount)*BigInt(qty);
  assert.ok(expected>2n**63n-1n);
  assert.equal(summary.totals.amount,String(expected));
  assert.equal(summary.totals.orders,qty);
  assert.equal(summary.groups[0].amount,String(expected));
  assert.deepEqual(readPaymentHandoffSummary(summary),summary);
  assert.doesNotMatch(JSON.stringify(summary),/customer|merchant|bank-reference|orderId/);
});

test("payment handoff comparison validates the export and preserves exact differences across disappearing groups",()=>{
  const at=Date.parse("2026-11-26T11:00:00+08:00");
  const format="hey-table.payment-attention-summary.v1",timeZone="Asia/Taipei";
  const filters={method:null,state:null,environment:null};
  const pending={method:"line_pay",environment:"demo",orders:1,pending:1,authorized:0,overdue:1,amount:"9007199254740993"};
  const authorized={method:"unknown",environment:"unknown",orders:1,pending:0,authorized:1,overdue:0,amount:"9007199254740997"};
  function summary(group,capturedAt=at){
    const {orders,pending,authorized,overdue,amount}=group;
    const totals={orders,pending,authorized,overdue,amount};
    return {format,timeZone,capturedAt,filters,totals,groups:[group]};
  }
  const before=readPaymentHandoffSummary(summary(pending)),after=readPaymentHandoffSummary(summary(authorized,at+1));
  const difference=comparePaymentHandoffSummaries(before,after);
  assert.deepEqual(difference.totals.delta,{orders:0,pending:-1,authorized:1,overdue:-1,amount:"4"});
  assert.deepEqual(difference.groups.map(({method,delta})=>[method,delta.orders,delta.amount]),[
    ["line_pay",-1,"-9007199254740993"],["unknown",1,"9007199254740997"],
  ]);
  assert.deepEqual(comparePaymentHandoffSummaries(after,before),{kind:"time"});
  const filtered=readPaymentHandoffSummary({...summary(pending),filters:{...filters,method:"line_pay"}});
  assert.deepEqual(comparePaymentHandoffSummaries(filtered,after),{kind:"filters"});
  assert.deepEqual(comparePaymentHandoffSummaries(before,before).groups,[]);
  for(const bad of [
    {...before,filters:{}},
    {...before,groups:[pending,pending]},
    {...before,groups:[{...pending,method:{toString:null}}]},
    {...before,totals:{...before.totals,amount:"9007199254740992"}},
    {...before,groups:[{...pending,amount:"1.00"}]},
    {...before,groups:[{...pending,orders:2,pending:1,authorized:0}]},
  ])assert.throws(()=>readPaymentHandoffSummary(bad),/摘要資料不完整/);
});

test("staff payment notes follow one attempt, are retry-safe after settlement, and keep older notes readable",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const before=Date.parse("2026-11-25T23:55:00+08:00"),now=before+900_000;
  t.mock.method(Date,"now",()=>now);
  const url="https://order.example/api/kitchen/payment-attention-notes";
  const runtime={DB:db,STAFF_KEY:"staff"},headers={Authorization:"Bearer staff","Content-Type":"application/json"};
  const read=(query="?id=1",access=headers)=>api(new Request(url+query,{headers:access}),runtime);
  const submit=(data,access=headers)=>api(new Request(url,{method:"POST",headers:access,body:JSON.stringify(data)}),runtime);
  const addOrder=db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created,payment_method,payment_env)
    VALUES (?,?,'pickup','','[]',45,?,?,'demo')`);
  addOrder.run(1,crypto.randomUUID(),before-500,"line_pay");
  addOrder.run(2,crypto.randomUUID(),before-500,"cash");
  const attempt=db.sqlite.prepare(`INSERT INTO payment_attempts(id,order_id,reference,merchant,trade_id,state,created)
    VALUES (?,1,?,'private-merchant',?,'pending',?)`);
  attempt.run(101,crypto.randomUUID(),crypto.randomUUID(),before);
  const base={id:1,attemptId:101,state:"pending",note:"  已通知顧客等候  ",operationId:crypto.randomUUID()};
  assert.equal((await read("?id=1",{})).status,403);
  assert.equal((await submit(base,{"Content-Type":"application/json"})).status,403);
  for(const input of [{...base,note:" "},{...base,note:"x".repeat(241)},{...base,state:"paid"},{...base,attemptId:0}])
    assert.equal((await submit(input)).status,400);
  assert.equal((await read("?id=2")).status,404);
  assert.equal((await read("?id=1&before=invalid")).status,400);
  assert.deepEqual(await (await read()).json(),{id:1,target:{attemptId:101,state:"pending",startedAt:before},
    notes:[],nextBefore:null});

  const replies=await Promise.all([submit(base),submit(base)]);
  assert.deepEqual(replies.map(reply=>reply.status),[200,200]);
  const saved=await replies[0].json();
  assert.deepEqual(saved,{id:1,state:"pending",note:"已通知顧客等候",recordedAt:now,startedAt:before});
  assert.deepEqual(await replies[1].json(),saved);
  assert.equal((await submit({...base,note:"不同備註"})).status,409);
  async function queue(){
    const response=await api(new Request("https://order.example/api/kitchen/payment-attention",{headers}),runtime);
    return (await response.json()).orders[0];
  }
  assert.deepEqual((await queue()).latestNote,{note:saved.note,recordedAt:now});
  const transition=db.sqlite.prepare("UPDATE payment_attempts SET state=? WHERE id=101");
  transition.run("authorized");
  assert.equal((await submit({...base,operationId:crypto.randomUUID()})).status,409);
  for(let number=2;number<=21;number++){
    const response=await submit({...base,state:"authorized",note:"接續核對 "+number,operationId:crypto.randomUUID()});
    assert.equal(response.status,200);
  }
  const first=await read();
  assert.equal(first.headers.get("Cache-Control"),"no-store");
  const page=await first.json();
  assert.equal(page.notes.length,20);
  assert.equal(page.notes[0].note,"接續核對 21");
  assert.equal(page.notes.at(-1).note,"接續核對 2");
  assert.deepEqual((await (await read("?id=1&before="+page.nextBefore)).json()).notes,[saved]);
  transition.run("paid");
  assert.equal(await queue(),undefined);
  assert.equal((await (await read()).json()).target,null);
  assert.deepEqual(await (await submit(base)).json(),saved);
  transition.run("cancelled");
  attempt.run(102,crypto.randomUUID(),crypto.randomUUID(),now);
  assert.equal((await queue()).latestNote,undefined);
  assert.equal((await submit({...base,state:"pending",operationId:crypto.randomUUID()})).status,409);
  assert.deepEqual((await (await read()).json()).target,{attemptId:102,state:"pending",startedAt:now});
  assert.deepEqual((await (await read("?id=1&before="+page.nextBefore)).json()).notes,[saved]);
});

test("staff payment follow-up filters change at the deadline and concurrent edits preserve history",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const start=Date.parse("2026-11-25T23:55:00+08:00"),deadline=start+10*60_000;
  let now=deadline-1;
  t.mock.method(Date,"now",()=>now);
  const endpoint="https://order.example/api/kitchen/";
  const runtime={DB:db,STAFF_KEY:"staff"},headers={Authorization:"Bearer staff","Content-Type":"application/json"};
  const call=(path,options={})=>api(new Request(endpoint+path,{headers,...options}),runtime);
  const submit=data=>call("payment-attention-notes",{method:"POST",body:JSON.stringify(data)});
  const history=async()=>await (await call("payment-attention-notes?id=1")).json();
  const due=async()=>await (await call("payment-attention?method=line_pay&followUp=due&summary=1")).json();
  const all=async()=>await (await call("payment-attention?summary=1")).json();
  db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created,payment_method,payment_env)
    VALUES (1,?,'pickup','','[]',45,?,'line_pay','demo')`).run(crypto.randomUUID(),start-60_000);
  const addAttempt=db.sqlite.prepare(`INSERT INTO payment_attempts(id,order_id,reference,merchant,state,created)
    VALUES (?,1,?,'demo','pending',?)`);
  addAttempt.run(101,crypto.randomUUID(),start);
  const form={id:1,attemptId:101,state:"pending",note:"跨日追蹤",operationId:crypto.randomUUID()};
  const plan={...form,followUpAt:deadline,followUpVersion:null};
  for(const invalid of [{...form,followUpAt:deadline},{...plan,followUpAt:0},{...plan,followUpVersion:"1"}])
    assert.equal((await submit(invalid)).status,400);
  for(const query of ["followUp=all","followUp=due&followUp=due"])
    assert.equal((await call("payment-attention?"+query)).status,400);
  const [created,competing]=await Promise.all([submit(plan),submit({...plan,followUpAt:deadline+1000,operationId:crypto.randomUUID()})]);
  assert.equal(created.status,200);
  assert.equal(competing.status,409);
  const saved=await created.json();
  assert.equal(saved.followUpAt,deadline);
  assert.deepEqual(await (await submit(plan)).json(),saved);
  assert.equal((await submit({...plan,followUpAt:deadline+1000})).status,409);
  assert.equal((await all()).orders[0].followUpAt,deadline);
  assert.equal((await due()).summary.totals.orders,0);
  now=deadline;
  assert.equal((await submit({...form,note:"已通知值班同事",operationId:crypto.randomUUID()})).status,200);
  const report=await due();
  assert.deepEqual(report.orders.map(({id,followUpAt})=>[id,followUpAt]),[[1,deadline]]);
  assert.equal(report.summary.totals.amount,"45");
  const before=readPaymentHandoffSummary(report.summary);
  assert.equal(comparePaymentHandoffSummaries(before,(await all()).summary).kind,"filters");
  const cancel={...form,operationId:crypto.randomUUID(),followUpAt:null,followUpVersion:saved.id};
  assert.equal((await submit(cancel)).status,200);
  assert.equal((await due()).orders.length,0);
  assert.equal((await all()).orders[0].followUpAt,undefined);
  assert.equal(comparePaymentHandoffSummaries(before,readPaymentHandoffSummary((await due()).summary)).totals.delta.orders,-1);
  const updated=await history();
  assert.equal(updated.target.followUpAt,null);
  assert.deepEqual(updated.notes.map(note=>note.followUpAt),[null,undefined,deadline]);
  assert.equal((await submit({...plan,operationId:crypto.randomUUID()})).status,409);
  const rescheduled={...plan,operationId:crypto.randomUUID(),followUpVersion:updated.target.followUpVersion};
  assert.equal((await submit(rescheduled)).status,200);
  assert.equal((await due()).orders.length,1);
  db.sqlite.prepare("UPDATE payment_attempts SET state='failed' WHERE id=101").run();
  addAttempt.run(102,crypto.randomUUID(),now);
  assert.equal((await due()).orders.length,0);
  assert.equal((await history()).target.attemptId,102);
  assert.deepEqual(await (await submit(plan)).json(),saved);
});

test("staff payment attempt history paginates stable ordinals and isolates notes by order and attempt",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const startedAt=Date.parse("2026-11-25T23:55:00+08:00");
  const origin="https://order.example/api/kitchen/",headers={Authorization:"Bearer staff"};
  const runtime={DB:db,STAFF_KEY:"staff"};
  const get=(path,access=headers)=>api(new Request(origin+path,{headers:access}),runtime);
  const order=db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created,payment_method,payment_env)
    VALUES (?,?,'pickup','','[]',45,?,?,'demo')`);
  for(const [id,method] of [[1,"line_pay"],[2,"px_pay_plus"],[3,"cash"],[4,"line_pay"]])
    order.run(id,crypto.randomUUID(),startedAt-60_000,method);
  const attempt=db.sqlite.prepare(`INSERT INTO payment_attempts(id,order_id,reference,merchant,trade_id,redirect_url,state,
    created,checked,kitchen_payable_at) VALUES (?,?,?,'private-merchant',?,'https://pay.example/private',?,?,?,?)`);
  const add=(id,orderId,state,checked=0,firstPayable=null)=>
    attempt.run(id,orderId,crypto.randomUUID(),crypto.randomUUID(),state,startedAt,checked,firstPayable);
  for(let id=1;id<=11;id++)add(id,1,"failed");
  add(12,1,"pending",startedAt+60_000);
  add(50,2,"authorized",startedAt+30_000,startedAt+40_000);
  const note=db.sqlite.prepare(`INSERT INTO payment_attention_notes(attempt_id,operation_id,state,note,recorded_at)
    VALUES (?,?,'pending',?,?)`);
  note.run(1,crypto.randomUUID(),"第一筆的備註",startedAt+30_000);
  note.run(12,crypto.randomUUID(),"最新嘗試的備註",startedAt+40_000);
  note.run(50,crypto.randomUUID(),"另一張餐單的備註",startedAt+40_000);
  const path="payment-attempt-history?id=1";
  assert.equal((await get(path,{})).status,403);
  for(const query of ["?id=3","?id=999"])assert.equal((await get("payment-attempt-history"+query)).status,404);
  for(const query of ["?id=1&id=2","?id=1&attempt=1","?id=1&before=0","?id=1&before=1&before=2","?id=1&before=9007199254740992"])
    assert.equal((await get("payment-attempt-history"+query)).status,400);
  assert.deepEqual((await (await get("payment-attempt-history?id=4")).json()).attempts,[]);
  const first=await get(path);
  assert.equal(first.headers.get("Cache-Control"),"no-store");
  const page=await first.json();
  assert.equal(page.method,"line_pay");
  assert.equal(page.environment,"demo");
  assert.deepEqual(page.attempts.map(row=>row.number),[12,11,10,9,8,7,6,5,4,3]);
  assert.equal(page.nextBefore,3);
  assert.deepEqual(page.attempts[0],{attemptId:12,state:"pending",startedAt,lastCheckedAt:startedAt+60_000,
    firstPayableAt:null,noteCount:1,number:12,latest:true});
  const px=await (await get("payment-attempt-history?id=2")).json();
  assert.equal(px.attempts[0].firstPayableAt,startedAt+40_000);
  assert.doesNotMatch(JSON.stringify(page),/private-merchant|pay\.example|tradeId|reference|operationId/);
  const filter="payment-attention-notes?id=1&attempt=";
  const historical=await (await get(filter+"1")).json();
  assert.equal(historical.target,null);
  assert.deepEqual(historical.notes.map(row=>row.note),["第一筆的備註"]);
  assert.equal((await get(filter+"50")).status,404);
  assert.equal((await get(filter+"0")).status,400);
  assert.equal((await get(filter+"1&attempt=12")).status,400);
  assert.deepEqual((await (await get(filter+"12")).json()).target,{attemptId:12,state:"pending",startedAt});
  db.sqlite.prepare("UPDATE payment_attempts SET state='failed' WHERE id=12").run();
  add(13,1,"pending");
  const next=await (await get(path+"&before="+page.nextBefore)).json();
  assert.deepEqual(next.attempts.map(row=>[row.attemptId,row.number,row.latest]),[[2,2,false],[1,1,false]]);
  assert.equal(next.nextBefore,null);
  assert.equal((await (await get(path)).json()).attempts[0].number,13);
  assert.deepEqual((await (await get(filter+"12")).json()).notes.map(row=>row.note),["最新嘗試的備註"]);
  assert.equal((await (await get(filter+"12")).json()).target,null);
});

test("browser prep readiness and purchasing match Python for recipe revisions and shared batches",()=>{
  const cwd=fileURLToPath(new URL("../modules/prep-sheet/",import.meta.url));
  const example=name=>JSON.parse(readFileSync(join(cwd,"examples",name+".json"),"utf8"));
  const book=example("recipes"),orders=example("orders");
  const input=[];
  for(const includePreparing of [false,true]){
    input.push({orders,book,stock:example("stock"),includePreparing});
    for(let step=0;step<18;step++){
      const stock={grain:step*45,water:step*100,soy:20,kombu:5,cutlet:3,eggs:8,chicken:step*40,rice:step*15};
      input.push({orders:[...orders].reverse(),book,stock,includePreparing});
    }
  }
  const maximum=Number.MAX_SAFE_INTEGER;
  input.push({
    orders:[{id:1,created:0,status:"pending",items:[{id:"meal",qty:maximum}]}],
    book:{components:{dishBase:{unit:"g",yield:3,inputs:{water:1}},water:{unit:"ml",pack:1}},
      dishes:{meal:[{from_ms:0,uses:{dishBase:1}}]}},
    stock:{water:maximum},
    includePreparing:false,
  });
  const python=spawnSync(process.env.PYTHON||"python",["-B","-c",[
    "import json, sys",
    "from prep import readiness, plan",
    "def compare(orders, book, stock, preparing):",
    "    full = plan(orders, book, stock, preparing)",
    '    keys = ("component", "name", "unit", "action", "needed", "available")',
    '    purchase = {"orderCount": len(full["included_orders"]), "lines": [{key: row[key] for key in keys} for row in full["lines"] if row["action"] == "purchase"]}',
    '    return [readiness(orders, book, stock, preparing), purchase]',
    'print(json.dumps([compare(case["orders"], case["book"], case["stock"], case["includePreparing"]) for case in json.load(sys.stdin)]))',
  ].join("\n")],{cwd,input:JSON.stringify(input),encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}});
  assert.equal(python.status,0,python.stderr);
  assert.deepEqual(input.map(({orders,book,stock,includePreparing})=>{
    const planner=prepReadinessPlanner(book,stock);
    return [planner.forecast(orders,includePreparing),planner.purchaseInput(orders,includePreparing)];
  }),JSON.parse(python.stdout));
  const pantry=join(cwd,"..","pantry-freight");
  const purchase=prepReadinessPlanner(book,example("stock")).purchaseInput(orders);
  const offerReport=spawnSync(process.env.PYTHON||"python",["-B","-c",[
    "import json, sys",
    "from pathlib import Path",
    "from purchase import purchase, read_json",
    'print(json.dumps(purchase(json.load(sys.stdin), read_json(Path("examples/suppliers.json")))))',
  ].join("\n")],{cwd:pantry,input:JSON.stringify(purchase),encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}});
  assert.equal(offerReport.status,0,offerReport.stderr);
  const offers=JSON.parse(offerReport.stdout);
  assert.deepEqual([offers.status,offers.packs,offers.total_twd,offers.shipping_twd],["ok",7,165,0]);
  assert.throws(()=>forecastPrepReadiness(orders,book,{cutlet:maximum+1}),/整數/);
  const cyclic=structuredClone(book);
  cyclic.components.dashi.inputs.sauce=1;
  assert.throws(()=>forecastPrepReadiness(orders,cyclic,{}),/循環相依/);
});

test("browser supplier quotes match Python across freight, pack limits, stock and ties",()=>{
  const cwd=fileURLToPath(new URL("../modules/pantry-freight/",import.meta.url));
  const command=[
    "import json, random",
    "from test_purchase import PLAN, CAT",
    "from purchase import purchase",
    'examples = [(PLAN, CAT), (PLAN, dict(CAT, max_surplus={"chicken":10})), ({"lines":[]}, CAT)]',
    "rng = random.Random(19874)",
    "for case in range(320):",
    '    gaps = {key:rng.randint(1,6) for key in "xy"}',
    '    lines = [dict(action="purchase",component=key,needed=gap+1,available=1,unit="g") for key,gap in gaps.items()]',
    '    vendors = [dict(id=key,shipping=rng.randrange(9),free_at=rng.choice([None,0,5,10,15])) for key in "ab"]',
    '    offers = [dict(sku=str(i),supplier=rng.choice("ab"),component=key,pack=rng.randint(1,4),stock=rng.randint(0,3),price=rng.randint(1,7),unit="g") for i,key in enumerate("xyxy")]',
    '    limits = {key:rng.randrange(5) for key in gaps if rng.randrange(2)}',
    '    catalog = dict(currency="TWD",suppliers=vendors,offers=offers,max_surplus=limits)',
    '    rng.shuffle(offers)',
    '    examples.append((dict(lines=lines),catalog))',
    "print(json.dumps([[plan,catalog,purchase(plan,catalog)] for plan,catalog in examples]))",
  ];
  const python=spawnSync(process.env.PYTHON||"python",["-B","-c",command.join("\n")],
    {cwd,encoding:"utf8",env:{...process.env,PYTHONUTF8:"1"}});
  assert.equal(python.status,0,python.stderr);
  const examples=JSON.parse(python.stdout);
  assert.equal(examples.length,323);
  for(const [index,[plan,catalog,expected]] of examples.entries()){
    assert.deepEqual(quotePantryPurchase(plan,catalog),expected,`catalog ${index}`);
  }
  const [[plan,catalog]]=examples;
  const invalid=structuredClone(catalog);
  invalid.offers[0].unit="lb";
  assert.throws(()=>quotePantryPurchase(plan,invalid),/供應單位/);
  invalid.offers[0].unit=catalog.offers[0].unit;
  invalid.offers[0].price=Number.MAX_SAFE_INTEGER+1;
  assert.throws(()=>quotePantryPurchase(plan,invalid),/整數範圍/);
  const large={lines:[{component:"salt",action:"purchase",unit:"g",needed:1_000_000,available:0}]};
  const suppliers=[{id:"vendor",shipping:1,free_at:1_000_000}];
  const offers=[{sku:"salt",supplier:"vendor",component:"salt",unit:"g",pack:1,price:1,stock:1_000_000}];
  assert.throws(()=>quotePantryPurchase(large,{currency:"TWD",suppliers,offers}),/試算上限/);
});

test("procurement detail reconciles each order with the aggregate and retains legacy snapshots",()=>{
  const first={supplier:"a",sku:"X",component:"soy",unit:"ml",pack:25,remaining_packs:2};
  const second={...first,supplier:"b",pack:15,remaining_packs:1};
  const legacy={format:"prep-sheet.procurement.v1",stock:{soy:5},incoming:{soy:65},units:{soy:"ml"},
    purchase_orders:["P","Q"],issued:[]};
  assert.equal(readProcurementSnapshot(legacy).incomingOrders,null);
  const value={...legacy,incoming_orders:[{purchase_order:"P",lines:[first]},{purchase_order:"Q",lines:[second]}]};
  const parsed=readProcurementSnapshot(value);
  const all=summarizeIncomingOrders(parsed.incomingOrders);
  assert.deepEqual(all.incoming,{soy:65});
  assert.deepEqual([...all.sources.get("soy")],[["P",50],["Q",15]]);
  assert.deepEqual(summarizeIncomingOrders(parsed.incomingOrders.slice(1)).incoming,{soy:15});
  for(const mutate of [
    item=>{item.incoming.soy++;},
    item=>{item.incoming_orders.reverse();},
    item=>{item.incoming_orders[0].lines.push(first);},
    item=>{item.incoming_orders[1].lines[0].unit="L";},
    item=>{item.incoming_orders[1].lines[0].pack=Number.MAX_SAFE_INTEGER;},
  ]){
    const changed=structuredClone(value);
    mutate(changed);
    assert.throws(()=>readProcurementSnapshot(changed),/無法讀取採購快照/);
  }
});

test("purchase input counts shared batches once across orders that individually lack stock",()=>{
  const book={
    components:{rice:{unit:"g",yield:400,inputs:{grain:180}},grain:{unit:"g",pack:400}},
    dishes:{bowl:[{from_ms:0,uses:{rice:200}}]},
  };
  const orders=[1,2].map(id=>({id,created:1000,status:id===1?"pending":"preparing",items:[{id:"bowl",qty:1}]}));
  const planner=prepReadinessPlanner(book,{grain:100});
  const report=planner.forecast(orders,true);
  assert.deepEqual(report.orders.map(row=>row.missing[0].quantity),[80,80]);
  const grain={component:"grain",name:"grain",unit:"g",action:"purchase",needed:180,available:100};
  assert.deepEqual(planner.purchaseInput(orders,true),{orderCount:2,lines:[grain]});
  assert.deepEqual(planner.purchaseInput(orders),{orderCount:1,lines:[grain]});
  assert.deepEqual(planner.forecast(orders,true),report);
});

test("forecast delivery trials rerun FIFO from the same physical stock and expose displaced orders",()=>{
  const components={chicken:{name:"雞肉",unit:"g",pack:500},rice:{name:"白飯",unit:"g",pack:200}};
  const book={components,dishes:{
    combo:[{from_ms:0,uses:{chicken:200,rice:200}}],
    rice:[{from_ms:0,uses:{rice:200}}],
    chicken:[{from_ms:0,uses:{chicken:100}}],
  }};
  const orders=["combo","rice","chicken"].map((id,index)=>({
    id:index+1,created:1000,status:index===2?"preparing":"pending",items:[{id,qty:1}],
  })).reverse();
  const stock={rice:200};
  const planner=prepReadinessPlanner(book,stock);
  const baseline=planner.forecast(orders,true);
  assert.deepEqual(baseline.orders.map(row=>row.status),["shortage","ready","shortage"]);
  const delivery={component:"chicken",quantity:300};
  const after=planner.forecast(orders,true,[delivery]);
  assert.deepEqual(after.orders.map(row=>[row.order_id,row.status]),[[1,"ready"],[2,"shortage"],[3,"ready"]]);
  assert.deepEqual(after.orders[1].missing,[{component:"rice",name:"白飯",unit:"g",quantity:200}]);
  assert.deepEqual(after.remaining_stock,{chicken:0,rice:0});
  const second=planner.forecast(orders,true,[delivery,{component:"rice",quantity:200}]);
  assert.deepEqual(second.orders.map(row=>row.status),["ready","ready","ready"]);
  assert.deepEqual(planner.forecast(orders,false,[delivery]).orders.map(row=>row.order_id),[1,2]);
  assert.throws(()=>planner.forecast(orders,true,[delivery,delivery]),/請合併 雞肉/);
  assert.throws(()=>planner.forecast(orders,true,[{component:"unknown",quantity:1}]),/請選擇食譜/);
  for(const quantity of [0,-1,1.5,NaN,Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>planner.forecast(orders,true,[{component:"chicken",quantity}]),/正整數/);
  }
  assert.throws(()=>planner.forecast(orders,true,[{component:"rice",quantity:Number.MAX_SAFE_INTEGER}]),
    /現有庫存加到貨量/);
  assert.deepEqual(planner.forecast(orders,true),baseline);
  assert.deepEqual(stock,{rice:200});
});

test("arrival handoff validates both results against one complete scoped order set",()=>{
  const order=(id,status)=>({id,status,created:1000,items:[{id:"edamame",qty:1}]});
  const source=prepOrderSource({date:"2026-11-26",capturedAt:1500,station:"cold",scope:"remaining",
    orders:[order(4,"preparing"),order(2,"pending")]});
  const missing={component:"beans",name:"毛豆",unit:"g",quantity:100};
  const short={status:"shortage",missing:[missing],prep:[]},ready={status:"ready",missing:[],prep:[]};
  const row=(order_id,before,after)=>({order_id,portions:[{dish:"edamame",from_ms:0,quantity:1}],before,after});
  const input={format:prepArrivalReportFormat,source,includePreparing:true,arrivals:[missing],
    orders:[row(4,ready,short),row(2,short,ready)]};
  const report=readPrepArrivalReport(structuredClone(input));
  assert.deepEqual(report.arrivals,[missing]);
  assert.deepEqual(report.before.map(({order_id,status})=>[order_id,status]),[[2,"shortage"],[4,"ready"]]);
  assert.deepEqual(report.after.map(({order_id,status})=>[order_id,status]),[[2,"ready"],[4,"shortage"]]);
  assert.ok(matchesPrepOrderSource({...source,capturedAt:2000},report.source));
  assert.ok(!matchesPrepOrderSource({...source,station:"all"},report.source));
  for(const modify of [
    value=>value.orders.pop(),
    value=>value.orders.push(value.orders[0]),
    value=>{value.includePreparing=false;},
    value=>{value.arrivals=[];},
    value=>{value.arrivals.push(value.arrivals[0]);},
    value=>{value.arrivals[0].quantity=Number.MAX_SAFE_INTEGER+1;},
    value=>{value.orders[0].portions[0].quantity=2;},
    value=>{value.orders[0].after.status="ready";},
    value=>{delete value.orders[0].after;},
  ]){
    const changed=structuredClone(input);
    modify(changed);
    assert.throws(()=>readPrepArrivalReport(changed),/無法讀取/);
  }
});

test("prep report compares date, station and source quantities independently of capture time or item order",()=>{
  const snapshot={date:"2026-11-25",station:"hot",scope:"all",capturedAt:1000,
    orders:[{id:4,created:900,status:"pending",items:[{id:"katsudon",qty:2},{id:"sencha",qty:1}]}]};
  const source=prepOrderSource(snapshot);
  const matching=prepOrderSource({...snapshot,capturedAt:1200,orders:[{...snapshot.orders[0],items:[...snapshot.orders[0].items].reverse()}]});
  assert.ok(matchesPrepOrderSource(matching,source));
  for(const diff of [{date:"2026-11-26"},{station:"cold"},{scope:"remaining"},
    {orders:[{...snapshot.orders[0],status:"preparing"}]},{orders:[{...snapshot.orders[0],items:[{id:"katsudon",qty:2}]}]}]){
    assert.equal(matchesPrepOrderSource(prepOrderSource({...snapshot,...diff}),source),false);
  }
  const order={order_id:4,status:"shortage",portions:[{dish:"katsudon",from_ms:100,quantity:2},{dish:"sencha",from_ms:0,quantity:1}],
    missing:[{component:"tea",name:"茶葉",unit:"g",quantity:4}],prep:[]};
  const report={format:"hey-table.prep-readiness.v1",source,orders:[order]};
  assert.deepEqual(readPrepReadinessReport(report).orders[0].missing,order.missing);
  assert.throws(()=>readPrepReadinessReport({...report,orders:[order,order]}),/無法讀取/);
  assert.throws(()=>readPrepReadinessReport({...report,orders:[{...order,status:"ready"}]}),/無法讀取/);
});

test("cart replacement preview counts existing portions and overlapping choices against the same limit",()=>{
  const cart={gyoza:2,karaage:1,edamame:2,sencha:1};
  const maxFor=id=>({gyoza:1,edamame:3}[id]??20);
  const rows=supplyReviewRows(dishes,cart,["karaage"],maxFor);
  assert.deepEqual(rows.map(({id,from,to,alternatives})=>[id,from,to,alternatives.map(dish=>dish.id)]),
    [["karaage",1,0,["edamame"]],["gyoza",2,1,["edamame"]]]);
  assert.equal(planSupplyReview(cart,rows,{gyoza:"edamame",karaage:"edamame"}),null);
  assert.equal(planSupplyReview(cart,rows,{gyoza:"sencha"}),null);
  assert.deepEqual(planSupplyReview(cart,rows,{gyoza:"edamame"}),{gyoza:1,karaage:0,edamame:3,sencha:1});
  assert.equal(planSupplyReview({...cart,edamame:3},rows,{gyoza:"edamame"}),null);
  assert.deepEqual(cart,{gyoza:2,karaage:1,edamame:2,sencha:1});
});

test("the cart supply fixture reproduces current alternatives, a stale rejection and the accepted receipt",async()=>{
  const stored=JSON.parse(readFileSync(new URL("../examples/cart-supply-review-demo.json",import.meta.url),"utf8"));
  const demo=await buildCartSupplyReviewDemo();
  assert.deepEqual(stored,demo);
  assert.deepEqual(demo.before.options.map(({id,total})=>[id,total]),[["karaage",240],["edamame",185]]);
  assert.deepEqual(demo.after.options.map(({id})=>id),["edamame"]);
  assert.equal(demo.rejected,"portion_limit");
  assert.equal(demo.receipt.total,demo.after.options[0].total);
  assert.equal(demo.receipt.paymentMethod,demo.original.paymentMethod);
  assert.doesNotMatch(JSON.stringify(demo),/"(?:token|reference|note|merchant)"/);
});

test("the receipt recovery fixture is generated from actual order, check and payment APIs",async()=>{
  const saved=JSON.parse(readFileSync(new URL("../examples/customer-payment-recovery-demo.json",import.meta.url),"utf8"));
  const demo=await buildCustomerPaymentRecoveryDemo();
  assert.deepEqual(demo,saved);
  const [reached,notReached]=demo.scenarios;
  assert.notEqual(reached.orderId,notReached.orderId);
  assert.deepEqual(reached.scenes.map(scene=>[scene.clientStarts,scene.storedAttempts]),
    [[0,0],[1,null],[1,1],[1,1],[1,1]]);
  assert.deepEqual(notReached.scenes.map(scene=>[scene.clientStarts,scene.storedAttempts]),
    [[0,0],[1,null],[1,0],[2,1],[2,1]]);
  assert.ok(demo.scenarios.every(scenario=>scenario.scenes.at(-1).paymentState==="paid"));
  assert.doesNotMatch(JSON.stringify(demo),/"(?:token|ref|reference|redirect|tradeId|merchant)"/);
});

test("the payment handoff fixture comes from the queue, idempotent notes and simulated settlement",async()=>{
  const saved=JSON.parse(readFileSync(new URL("../examples/payment-attention-demo.json",import.meta.url),"utf8"));
  const demo=await buildPaymentAttentionDemo();
  assert.deepEqual(demo,saved);
  const [waiting,written,retried,settled]=demo.scenes;
  assert.deepEqual(demo.scenes.map(({stage})=>stage),["waiting","saved","retried","settled"]);
  assert.deepEqual(waiting.queue.orders.map(({method,state})=>[method,state]),[["line_pay","pending"],["px_pay_plus","authorized"]]);
  assert.equal(waiting.history.notes.length,0);
  assert.deepEqual(written.history.notes,retried.history.notes);
  assert.equal(retried.history.notes.length,1);
  assert.deepEqual(settled.history.notes,written.history.notes);
  assert.equal(settled.history.target,null);
  assert.deepEqual(settled.queue.orders.map(({method})=>method),["px_pay_plus"]);
  assert.doesNotMatch(JSON.stringify(demo),/"(?:token|reference|tradeId|merchant|attemptId|operationId)"/);
});

test("a delayed payment lookup cannot overwrite a newer verification for the same recorded state",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=Date.parse("2026-11-25T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const id=Number(db.sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created,payment_method,payment_env)
    VALUES (?,'pickup','completed','[]','',190,?,'px_pay_plus','sandbox')`).run(crypto.randomUUID(),now-60000).lastInsertRowid);
  db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,trade_id,created)
    VALUES (?,?,'fixture','authorized','known',?)`).run(id,ref,now-60000);
  const started=Promise.withResolvers(),firstReply=Promise.withResolvers();
  let times=0;
  t.mock.method(globalThis,"fetch",async()=>{
    if(++times===1){started.resolve();return firstReply.promise;}
    return reply({...data,record_status:0})();
  });
  const check=()=>api(new Request("https://order.example/api/kitchen/payment",{
    method:"PATCH",headers:{"Content-Type":"application/json",Authorization:"Bearer fixture-staff"},body:JSON.stringify({id})
  }),{...env,DB:db,STAFF_KEY:"fixture-staff"});
  const older=check();
  await started.promise;
  const recent=await (await check()).json();
  assert.equal(recent.outcome,"recent");
  assert.equal(times,1);
  now+=5000;
  const newer=await (await check()).json();
  firstReply.resolve(await reply({...data,record_status:1})());
  assert.deepEqual(newer,{ok:true,id,paymentState:"authorized",outcome:"matched"});
  assert.deepEqual(await (await older).json(),{ok:true,id,paymentState:"authorized",outcome:"changed"});
  const stored=db.sqlite.prepare("SELECT state,trade_id,checked FROM payment_attempts WHERE order_id=?").get(id);
  assert.equal(stored.state,"authorized");
  assert.equal(stored.trade_id,"known");
  assert.equal(stored.checked,now);
});
test("staff restock history pages by revision without exposing operation IDs or crossing dates and dishes",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",dish="gyoza";
  const insert=db.sqlite.prepare(`INSERT INTO daily_portion_restocks
    (date,dish,revision,operation_id,quantity,previous_capacity,used,capacity,restocked_at)
    VALUES (?,?,?,?,1,0,0,1,1)`);
  const add=(revision,day=date,item=dish)=>insert.run(day,item,revision,crypto.randomUUID());
  for(let revision=2;revision<=53;revision++)add(revision);
  add(88,"2026-11-26");
  add(89,date,"sencha");
  const query="date="+date+"&dish="+dish;
  const read=(params,staff=true)=>api(new Request("https://order.example/api/kitchen/daily-limits/restock?"+params,{
    headers:staff?{Authorization:"Bearer test-staff"}:{},
  }),{DB:db,STAFF_KEY:"test-staff"});
  assert.equal((await read(query,false)).status,403);
  for(const invalid of ["",query+"&date="+date,query+"&dish=sencha",query+"&before=1",query+"&before=1e3",
    query+"&before=9007199254740992",query+"&before=28&before=29","date=2026-11-31&dish=gyoza",
    "date="+date+"&dish=unknown"]){
    assert.equal((await read(invalid)).status,400);
  }
  const response=await read(query);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const first=await response.json();
  assert.equal(first.records.length,25);
  assert.equal(first.nextBefore,29);
  assert.deepEqual(first.records[0],{date,dish,revision:53,quantity:1,previousCapacity:0,used:0,capacity:1,restockedAt:1});
  add(54);
  const second=await (await read(query+"&before="+first.nextBefore)).json();
  assert.equal(second.records.length,25);
  assert.equal(second.nextBefore,4);
  const last=await (await read(query+"&before="+second.nextBefore)).json();
  assert.equal(last.nextBefore,null);
  assert.deepEqual([...first.records,...second.records,...last.records].map(row=>row.revision),
    Array.from({length:52},(_,index)=>53-index));
  assert.equal((await (await read(query)).json()).records[0].revision,54);
  const empty=await (await read("date=2026-11-24&dish="+dish)).json();
  assert.deepEqual(empty.records,[]);
  assert.equal(empty.nextBefore,null);
});
test("supply migration retains old limits and merges existing restocks with new manual and copy history",async t=>{
  const sourceDate="2026-11-24",date="2026-11-25",dish="gyoza";
  const db=database((tag,sqlite)=>{
    if(tag!=="0025_daily_portion_limit_changes")return;
    const limit=sqlite.prepare("INSERT INTO daily_portion_limits(date,dish,capacity,revision) VALUES (?,?,?,?)");
    limit.run(sourceDate,dish,11,1);
    limit.run(date,dish,9,5);
    sqlite.prepare(`INSERT INTO daily_portion_restocks
      (date,dish,revision,operation_id,quantity,previous_capacity,used,capacity,restocked_at)
      VALUES (?,?,4,?,2,5,1,7,1000)`).run(date,dish,crypto.randomUUID());
  });
  t.after(()=>db.sqlite.close());
  const query="?date="+date+"&dish="+dish;
  const call=(suffix,method="GET",data,staff=true)=>api(new Request("https://order.example/api/kitchen/daily-limits"+suffix,{
    method,headers:staff?{Authorization:"Bearer test-staff","Content-Type":"application/json"}:{},
    ...(data?{body:JSON.stringify(data)}:{}),
  }),{DB:db,STAFF_KEY:"test-staff"});
  assert.equal((await call("/history"+query,"GET",undefined,false)).status,403);
  assert.equal((await (await call("?date="+date)).json()).limits[dish].capacity,9);
  const manual=await call("","PATCH",{date,dish,capacity:null,revision:5});
  assert.deepEqual(await manual.json(),{date,dish,capacity:null,revision:6});
  const payload={sourceDate,date,items:[{dish,sourceRevision:1,targetRevision:6}]};
  const copy=await call("/copy","POST",payload);
  assert.deepEqual(await copy.json(),{sourceDate,date,limits:[{dish,capacity:11,revision:7}]});
  assert.equal((await call("/copy","POST",payload)).status,409);
  const {records,nextBefore}=await (await call("/history"+query)).json();
  assert.ok(records.every(record=>Number.isSafeInteger(record.changedAt)));
  assert.deepEqual(records.map(({changedAt,...record})=>record),[
    {revision:7,kind:"copy",previousCapacity:null,capacity:11,sourceDate,quantity:null,used:null},
    {revision:6,kind:"manual",previousCapacity:9,capacity:null,sourceDate:null,quantity:null,used:null},
    {revision:4,kind:"restock",previousCapacity:5,capacity:7,sourceDate:null,quantity:2,used:1},
  ]);
  assert.equal(nextBefore,null);
  const older=await (await call("/history"+query+"&before=7")).json();
  assert.deepEqual(older.records,records.slice(1));
  assert.equal((await (await call("/restock"+query)).json()).records[0].restockedAt,1000);
  const restore={date,dish,revision:7,fromRevision:4};
  assert.equal((await call("/restore","POST",restore,false)).status,403);
  assert.equal((await call("/restore","POST",{...restore,fromRevision:8})).status,400);
  assert.equal((await call("/restore","POST",{...restore,fromRevision:5})).status,409);
  const restored=await call("/restore","POST",restore);
  assert.deepEqual(await restored.json(),{date,dish,revision:8,capacity:5,restoredFromRevision:4});
  assert.equal((await call("/restore","POST",restore)).status,409);
  assert.equal((await call("/restore","POST",{...restore,revision:8})).status,409);
  const after=await (await call("/history"+query)).json();
  const {changedAt,...revision}=after.records[0];
  assert.ok(Number.isSafeInteger(changedAt));
  assert.deepEqual(revision,{revision:8,kind:"restore",previousCapacity:11,capacity:5,
    sourceDate:null,quantity:null,used:null,restoredFromRevision:4});
  assert.deepEqual(after.records.slice(1),records);
});
test("staff payment export matches both reconciliation tools without exporting customer fields",async t=>{
  const temp=mkdtempSync(join(tmpdir(),"hey-table-payment-snapshot-"));
  t.after(()=>rmSync(temp,{recursive:true,force:true}));
  const root=fileURLToPath(new URL("../",import.meta.url));
  const ledger=join(root,"modules","payout-ledger");
  const fixture=join(temp,"fixture");
  const python=process.env.PYTHON || (process.platform==="win32" ? "python" : "python3");
  execFileSync(python,[join(ledger,"examples","restaurant_demo.py"),fixture,"--bank-activity","--migrations",join(root,"drizzle")]);
  const database=join(fixture,"restaurant.db");
  const sqlite=new DatabaseSync(database);
  try {
    sqlite.exec("UPDATE orders SET note='private-order-note'");
    sqlite.exec("UPDATE payment_attempts SET redirect_url='https://example.test/private-checkout'");
    const runtime={DB:sqliteD1(sqlite),STAFF_KEY:"fixture-staff"};
    const auth={Authorization:"Bearer fixture-staff"};
    const get=(query,headers={})=>api(new Request("https://order.example/api/kitchen/payment-snapshot"+query,{headers}),runtime);
    assert.equal((await get("?environment=sandbox")).status,403);
    assert.equal((await get("?environment=sandbox",{"X-Ticket":"private-ticket-2"})).status,403);
    for(const query of ["","?environment=demo","?environment=sandbox&environment=production"])
      assert.equal((await get(query,auth)).status,400);
    const response=await get("?environment=sandbox",auth);
    assert.equal(response.status,200);
    assert.equal(response.headers.get("Cache-Control"),"no-store");
    const snapshot=await response.json();
    assert.deepEqual(snapshot.attempts.map(row=>row.reference),["C1","L1","L2","P1","J1"]);
    assert.deepEqual(Object.keys(snapshot.attempts[0]).sort(),
      ["created","merchant","order_id","payment_method","reference","state","total","trade_id"]);
    assert.doesNotMatch(JSON.stringify(snapshot),/private-ticket|private-order-note|private-checkout/);
    const production=await (await get("?environment=production",auth)).json();
    assert.deepEqual(production.attempts.map(row=>row.reference),["LIVE"]);
    const snapshotFile=join(temp,"payments.json");
    writeFileSync(snapshotFile,JSON.stringify(snapshot));

    const run=(script,local,flags)=>spawnSync(python,["-X","utf8",join(ledger,script),...local,...flags],{encoding:"utf8"});
    const base=["--day","2026-11-23","--environment","sandbox","--merchant","demo-restaurant"];
    for(const [script,name,more] of [["restaurant_close.py","records.json",[]],
      ["bank_activity.py","bank-activity.json",["--merchant","demo-wallet"]]]) {
      const flags=[...base,...more,"--snapshot",join(fixture,name),"--strict"];
      const fromBackup=run(script,[database],flags);
      const fromExport=run(script,["--restaurant-snapshot",snapshotFile],flags);
      assert.equal(fromBackup.status,3,fromBackup.stderr);
      assert.equal(fromExport.status,fromBackup.status,fromExport.stderr);
      assert.deepEqual(JSON.parse(fromExport.stdout),JSON.parse(fromBackup.stdout));
      if(script==="bank_activity.py") assert.equal(JSON.parse(fromExport.stdout).net_twd,30);
    }
    writeFileSync(snapshotFile,JSON.stringify({...snapshot,environment:"production"}));
    const mismatch=run("restaurant_close.py",["--restaurant-snapshot",snapshotFile],
      [...base,"--snapshot",join(fixture,"records.json")]);
    assert.equal(mismatch.status,2);
    assert.equal(mismatch.stdout,"");
    assert.match(mismatch.stderr,/restaurant snapshot or payment environment/);

    sqlite.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4996)
      INSERT INTO payment_attempts(order_id,reference,merchant,created)
      SELECT 1,'extra-'||x,'demo-restaurant',1 FROM n`);
    const limited=await get("?environment=sandbox",auth);
    assert.equal(limited.status,409);
    assert.equal(Object.hasOwn(await limited.json(),"attempts"),false);
  } finally {
    sqlite.close();
  }
});
test("migrate a historic price and recover accepted demo orders after a change of payment environment",async t=>{
  const oldToken=crypto.randomUUID(),newToken=crypto.randomUUID();
  const db=database((tag,sqlite)=>{
    if(tag==="0004_combo_pricing")
      sqlite.prepare("INSERT INTO orders(token,mode,note,items,total,created) VALUES (?,'pickup','',?,180,1)")
        .run(oldToken,JSON.stringify([{id:"katsudon",name:"豬排丼",price:180,qty:1}]));
  });
  t.after(()=>db.sqlite.close());
  const post=(mode,body)=>api(new Request("https://order.example/api/orders",{method:"POST",
    headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),{DB:db,TAPPAY_MODE:mode});
  const old={mode:"pickup",note:"",token:oldToken,items:[{id:"katsudon",qty:1}]};
  const recovered=await (await post("production",old)).json();
  assert.equal(recovered.total,180);
  assert.equal(recovered.items[0].price,180);
  assert.equal(Object.hasOwn(recovered,"combo"),false);
  const deal={...old,token:newToken,items:[...old.items,{id:"sencha",qty:1}],comboVersion:"demo-v1",expectedTotal:200};
  for(const mode of ["production","sandbox"])assert.equal((await post(mode,deal)).status,409);
  const first=await (await post("demo",deal)).json();
  assert.equal(first.total,200);
  assert.deepEqual(await (await post("production",deal)).json(),first);
  const menu=()=>api(new Request("https://order.example/api/menu"),{DB:db});
  assert.deepEqual((await (await menu()).json()).accepting,{pickup:true,table:true});
  const pause=await api(new Request("https://order.example/api/kitchen/intake",{method:"PATCH",headers:{
    Authorization:"Bearer local-test-key","Content-Type":"application/json"},
    body:JSON.stringify({mode:"pickup",accepting:false,revision:0})}),{DB:db,STAFF_KEY:"local-test-key"});
  assert.equal(pause.status,200);
  assert.deepEqual((await (await menu()).json()).accepting,{pickup:false,table:true});
  assert.deepEqual(await (await post("production",old)).json(),recovered);
});
test("upgrade old receipt progress without making up transition times",async t=>{
  const token=crypto.randomUUID();
  const db=database((tag,sqlite)=>{
    if(tag==="0007_receipt_progress")sqlite.prepare(`INSERT INTO orders
      (token,mode,note,items,total,created,status) VALUES (?,'pickup','','[]',45,1,'preparing')`).run(token);
  });
  t.after(()=>db.sqlite.close());
  const env={DB:db,STAFF_KEY:"local-test-key"};
  const get=async(suffix="?progress=1")=>{
    const response=await api(new Request("https://order.example/api/ticket"+suffix,{headers:{"X-Ticket":token}}),env);
    assert.equal(response.status,200);
    return response.json();
  };
  const old=await get();
  assert.deepEqual(old.statusHistory,[{status:"pending",at:1},{status:"preparing",at:null}]);
  assert.deepEqual(await get("?progress=1&timing=1"),old);
  const moved=await api(new Request("https://order.example/api/kitchen/status",{method:"PATCH",
    headers:{Authorization:"Bearer local-test-key","Content-Type":"application/json"},
    body:JSON.stringify({id:old.id,from:"preparing",to:"ready"})}),env);
  assert.equal(moved.status,200);
  const ready=await get();
  assert.equal(ready.status,"ready");
  const {statusHistory,...standardReceipt}=ready;
  assert.deepEqual(await get(""),standardReceipt);
  assert.deepEqual(statusHistory.slice(0,2),old.statusHistory);
  const last=statusHistory.at(-1);
  assert.ok(Number.isSafeInteger(last.at)&&last.at>1);
  const sample=JSON.parse(readFileSync(new URL("../examples/receipt-progress.json",import.meta.url),"utf8"));
  const milestones=history=>history.map(({status,at})=>[status,at===null]);
  assert.deepEqual(milestones(statusHistory),milestones(sample.find(row=>row.scenario==="legacy").statusHistory));
});
test("daily operations uses Taipei midnight and aggregates completed purchase snapshots",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const start=Date.parse("2026-11-24T16:00:00Z"),end=Date.parse("2026-11-25T16:00:00Z");
  const insert=db.sqlite.prepare(`INSERT INTO orders
    (token,mode,table_no,note,items,total,created,status,combo_quote) VALUES (?,?,?,?,?,?,?,?,?)`);
  function add(when,mode,status,total,items,discount=null){
    insert.run(crypto.randomUUID(),mode,mode==="table"?"A03":null,"僅廚房閱讀",JSON.stringify(items),total,when,status,discount);
  }
  const tea=qty=>({id:"sencha",name:"舊名煎茶",qty,price:45});
  add(start-1,"pickup","completed",999,[tea(10)]);
  add(start,"pickup","completed",80,[tea(2)],'{"version":"fixture"}');
  add(start+1,"pickup","pending",90,[tea(2)]);
  add(start+2,"pickup","preparing",90,[tea(2)]);
  add(start+3,"table","ready",90,[tea(2)]);
  add(start+4,"table","cancelled",90,[tea(2)]);
  add(end-1,"table","completed",220,[tea(1),{id:"old-tofu",name:"舊菜單豆腐",qty:4,price:45}]);
  add(end,"table","completed",999,[tea(10)]);
  const query=(params,staff=true)=>api(new Request("https://order.example/api/kitchen/daily?"+params,{
    headers:staff?{Authorization:"Bearer local-test-key"}:{},
  }),{DB:db,STAFF_KEY:"local-test-key"});
  assert.equal((await query("date=2026-11-25",false)).status,403);
  for(const invalid of ["","date=2026-02-29","date=2026-11-25&date=2026-11-26"])
    assert.equal((await query(invalid)).status,400);
  const response=await query("date=2026-11-25");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const {capturedAt,...report}=await response.json();
  assert.ok(Number.isSafeInteger(capturedAt));
  assert.deepEqual(report,{format:"hey-table.daily-operations.v1",date:"2026-11-25",timeZone:"Asia/Taipei",channels:{
    pickup:{orders:3,pending:1,preparing:1,ready:0,completed:1,cancelled:0,completedTotal:80},
    table:{orders:3,pending:0,preparing:0,ready:1,completed:1,cancelled:1,completedTotal:220},
  },items:[{id:"old-tofu",name:"舊菜單豆腐",qty:4},{id:"sencha",name:"日式熱煎茶",qty:3}]});
  const byChannel=await (await query("date=2026-11-25&itemChannels=1")).json();
  assert.deepEqual(byChannel.items,[
    {id:"old-tofu",name:"舊菜單豆腐",qty:4,pickupQty:0,tableQty:4},
    {id:"sencha",name:"日式熱煎茶",qty:3,pickupQty:2,tableQty:1},
  ]);
  const next=await (await query("date=2026-11-26")).json();
  assert.equal(next.channels.table.completedTotal,999);
  assert.equal(next.channels.pickup.orders,0);
});
test("daily timings use visible samples and keep cross-midnight orders on their creation date",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const start=Date.parse("2026-11-22T16:00:00Z"),end=start+86400000;
  const insert=db.sqlite.prepare(`INSERT INTO orders
    (token,mode,table_no,note,items,total,created,status,status_history) VALUES (?,?,?,?,?,0,?,?,?)`);
  const transition=(from,status,at)=>({from,status,at});
  function add(mode,created,status,transitions){
    insert.run(crypto.randomUUID(),mode,mode==="table"?"A03":null,"避免匯出這段備註","[]",created,status,
      transitions===null?null:JSON.stringify(transitions));
  }
  function durations(mode,created,preparation,wait){
    const accepted=created+5000,ready=accepted+preparation;
    add(mode,created,wait===null?"ready":"completed",[
      transition("pending","preparing",accepted),transition("preparing","ready",ready),
      ...(wait===null?[]:[transition("ready","completed",ready+wait)]),
    ]);
  }
  durations("pickup",start,60000,30000);
  durations("pickup",start+1,120000,60000);
  durations("pickup",start+2,300000,null);
  add("pickup",start+3,"completed",null);
  add("pickup",start+4,"ready",[
    "malformed legacy event",
    transition("pending","preparing",start+10000),transition("preparing","ready",start+5000),
  ]);
  durations("table",start+5,30000,null);
  durations("table",end-1,90000,null);
  add("table",start+6,"completed",[
    transition("preparing","ready",start+40000),transition("ready","completed",start+95000),
  ]);
  durations("pickup",end,1000000,5000);
  const call=async(date,timing="")=>api(new Request(`https://order.example/api/kitchen/daily?date=${date}${timing}`,{
    headers:{Authorization:"Bearer local-test-key"},
  }),{DB:db,STAFF_KEY:"local-test-key"}).then(response=>response.json());
  const report=await call("2026-11-23","&timing=1");
  assert.deepEqual(report.timing,{
    pickup:{preparation:{eligible:5,samples:3,medianMs:120000,p90Ms:300000},
      handoff:{eligible:3,samples:2,medianMs:45000,p90Ms:60000}},
    table:{preparation:{eligible:3,samples:2,medianMs:60000,p90Ms:90000},
      handoff:{eligible:1,samples:1,medianMs:55000,p90Ms:55000}},
  });
  assert.ok(!JSON.stringify(report).includes("避免匯出"));
  assert.equal((await call("2026-11-23")).timing,undefined);
  const following=await call("2026-11-24","&timing=1");
  assert.deepEqual(following.timing.table.preparation,{eligible:0,samples:0,medianMs:null,p90Ms:null});
  assert.equal(following.timing.pickup.preparation.medianMs,1000000);
});
test("receipt timing and remaining prep use completed station work while legacy items still reach the board",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const token=crypto.randomUUID();
  const items=[{id:"katsudon",name:"滑蛋豬排丼",qty:1,price:190},{id:"sencha",name:"日式熱煎茶",qty:2,price:45}];
  const insert=db.sqlite.prepare(`INSERT INTO orders
    (token,mode,note,items,total,created,status) VALUES (?,'pickup','',?,280,?,'preparing')`);
  const {lastInsertRowid:id}=insert.run(token,JSON.stringify(items),Date.now()-1000);
  const runtime={DB:db,STAFF_KEY:"local-test-key"};
  const cook=async(order,station)=>api(new Request("https://order.example/api/kitchen/station-work",{
    method:"PATCH",headers:{Authorization:"Bearer local-test-key","Content-Type":"application/json"},
    body:JSON.stringify({id:order,station}),
  }),runtime);
  const read=async()=>api(new Request("https://order.example/api/ticket?timing=1",{
    headers:{"X-Ticket":token},
  }),runtime).then(response=>response.json());
  const prep=async(query="")=>api(new Request("https://order.example/api/kitchen/prep"+query,{
    headers:{Authorization:"Bearer local-test-key"},
  }),runtime).then(response=>response.json());
  const orderItems=response=>response.orders.find(order=>order.id===id).items;
  const allItems=[{id:"katsudon",qty:1},{id:"sencha",qty:2}];
  const before=await prep("?stationProgress=1");
  assert.deepEqual(before.orders,before.remainingOrders);
  assert.deepEqual((await read()).kitchenQuote.seconds,[300,420]);
  assert.equal((await cook(id,"hot")).status,200);
  assert.deepEqual((await read()).kitchenQuote.seconds,[60,90]);
  const partial=await prep("?stationProgress=1");
  assert.deepEqual(orderItems(partial),allItems);
  assert.deepEqual(partial.remainingOrders,[{...partial.orders[0],items:[{id:"sencha",qty:2}]}]);
  const standard=await prep();
  assert.equal(standard.remainingOrders,undefined);
  assert.deepEqual(orderItems(standard),allItems);
  assert.equal((await cook(id,"bar")).status,200);
  assert.equal((await read()).status,"ready");
  assert.equal((await read()).kitchenQuote,undefined);

  const {lastInsertRowid:older}=insert.run(crypto.randomUUID(),JSON.stringify([{id:"old-tofu",name:"舊菜單豆腐",qty:1,price:60}]),1);
  const board=await api(new Request("https://order.example/api/kitchen/station-work?station=other",{
    headers:{Authorization:"Bearer local-test-key"},
  }),runtime);
  assert.deepEqual((await board.json()).orders,[{id:older,table:null,note:"",created:1,
    items:[{id:"old-tofu",name:"舊菜單豆腐",qty:1}],doneAt:null,doneStations:0,stations:1}]);
  const legacy=await prep("?stationProgress=1");
  assert.deepEqual(legacy.remainingOrders,[{id:older,created:1,status:"preparing",items:[{id:"old-tofu",qty:1}]}]);
  assert.equal((await (await cook(older,"other")).json()).status,"ready");
  assert.deepEqual((await prep("?stationProgress=1")).remainingOrders,[]);
});
test("station batches reject stale and unpaid orders without writes and preserve other stations",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"staff"};
  const headers={Authorization:"Bearer staff","Content-Type":"application/json"};
  const call=(path,data,staff=headers)=>api(new Request("https://order.example/api/kitchen/station-work"+path,{
    headers:staff,...(data?{method:"PATCH",body:JSON.stringify(data)}:{}),
  }),runtime);
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,table_no,note,items,total,created,status,payment_method)
    VALUES (?,'table','A03','',?,250,?,'preparing',?)`);
  const hot={id:"katsudon",name:"滑蛋豬排丼",qty:1,note:"不要蔥"},bar={id:"sencha",name:"日式熱煎茶",qty:2};
  const add=(items,method="cash")=>Number(insert.run(crypto.randomUUID(),JSON.stringify(items),Date.now(),method).lastInsertRowid);
  const one=add([hot,bar]),two=add([hot,bar]),unpaid=add([hot],"line_pay");
  const get=async()=>(await (await call("?station=hot")).json()).orders.map(order=>({id:order.id,review:stationReview(order)}));
  const batch=(orders,staff)=>call("/batch",{station:"hot",orders},staff);
  const row=id=>db.sqlite.prepare("SELECT status,station_progress,status_history FROM orders WHERE id=?").get(id);
  const orders=await get();
  assert.deepEqual(orders.map(order=>order.id),[one,two]);
  assert.equal((await batch(orders,{})).status,403);
  assert.equal((await batch([orders[0],orders[0]])).status,400);
  assert.equal((await batch([orders[0],{id:unpaid,review:orders[0].review}])).status,409);
  assert.equal(row(one).station_progress,null);
  db.sqlite.prepare("UPDATE orders SET table_no='A04' WHERE id=?").run(two);
  assert.equal((await batch(orders)).status,409);
  assert.equal(row(one).station_progress,null);
  assert.equal((await call("",{id:two,station:"bar"})).status,200);
  const current=await get();
  assert.deepEqual(await (await batch(current)).json(),{station:"hot",completed:2});
  assert.equal(row(one).status,"preparing");
  assert.equal(row(two).status,"ready");
  const {done}=JSON.parse(row(two).station_progress);
  assert.equal(typeof done.bar,"number");
  assert.equal(done.hot,JSON.parse(row(one).station_progress).done.hot);
  assert.deepEqual(JSON.parse(row(two).status_history),[{from:"preparing",status:"ready",at:done.hot}]);
  assert.equal((await batch(current)).status,409);
});
test("station batch receipts survive same-key retries and roll back with order updates",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"staff"};
  const headers={Authorization:"Bearer staff","Content-Type":"application/json"};
  const path="https://order.example/api/kitchen/station-work";
  const call=(suffix,data,staff=headers)=>api(new Request(path+suffix,{
    headers:staff,...(data?{method:"PATCH",body:JSON.stringify(data)}:{}),
  }),runtime);
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status)
    VALUES (?,'pickup','private batch fixture',?,190,?,'preparing')`);
  for(let index=0;index<4;index++)insert.run(crypto.randomUUID(),
    JSON.stringify([{id:"katsudon",name:"滑蛋豬排丼",qty:1}]),Date.now());
  const queue=(await (await call("?station=hot")).json()).orders;
  const reviews=await Promise.all(queue.map(async order=>({id:order.id,review:await stationReviewDigest(stationReview(order))})));
  const payload={operationId:crypto.randomUUID(),station:"hot",orders:reviews.slice(0,2)};
  const read="/batch?operationId="+payload.operationId;
  assert.equal((await call(read,undefined,{})).status,403);
  assert.equal((await call(read)).status,404);
  db.sqlite.exec(`CREATE TRIGGER reject_second_batch_order BEFORE UPDATE ON orders WHEN NEW.id=${reviews[1].id}
    BEGIN SELECT RAISE(ABORT, 'fixture late failure'); END`);
  await assert.rejects(()=>call("/batch",payload),/fixture late failure/);
  assert.equal((await call(read)).status,404);
  assert.deepEqual(db.sqlite.prepare("SELECT DISTINCT status FROM orders").all().map(row=>row.status),["preparing"]);
  db.sqlite.exec("DROP TRIGGER reject_second_batch_order");
  const [first,retry]=await Promise.all([call("/batch",payload),call("/batch",{...payload,orders:[...payload.orders].reverse()})]);
  assert.equal(first.status,200);
  assert.equal(retry.status,200);
  const receipt=await first.json();
  assert.deepEqual(receipt,{operationId:payload.operationId,station:"hot",completed:2,
    orderIds:reviews.slice(0,2).map(order=>order.id),recordedAt:receipt.recordedAt});
  assert.equal(Number.isInteger(receipt.recordedAt),true);
  assert.deepEqual(await retry.json(),receipt);
  db.sqlite.prepare("UPDATE orders SET status='completed' WHERE id=?").run(reviews[0].id);
  assert.deepEqual(await (await call(read)).json(),receipt);
  assert.equal((await call("/batch",{...payload,orders:reviews.slice(2)})).status,409);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM orders WHERE status='preparing'").get().count,2);
  const persisted=db.sqlite.prepare("SELECT * FROM station_batch_receipts").all();
  assert.equal(persisted.length,1);
  assert.ok(!JSON.stringify(persisted).includes("private batch fixture"));
});

test("station batch history isolates Taipei days, station and order filters, and pages through tied times",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const start=Date.parse("2026-11-25T00:00:00+08:00"),end=Date.parse("2026-11-26T00:00:00+08:00");
  t.mock.method(Date,"now",()=>start);
  const runtime={DB:db,STAFF_KEY:"staff"};
  const list=(query="",staff=true)=>api(new Request("https://order.example/api/kitchen/station-work/history"+query,{
    headers:staff?{Authorization:"Bearer staff"}:{},
  }),runtime);
  const insert=db.sqlite.prepare(`INSERT INTO station_batch_receipts
    (operation_id,write_id,station,fingerprint,order_ids,recorded_at) VALUES (?,'private write','hot','private digest',?,?)`);
  const key=value=>"00000000-0000-4000-8000-"+String(value).padStart(12,"0");
  for(let i=1;i<=27;i++)insert.run(key(i),JSON.stringify([i,101]),start);
  insert.run(key(100),"[101,102]",start-1);
  insert.run(key(101),"[101,102]",end);
  db.sqlite.prepare(`INSERT INTO station_batch_receipts
    (operation_id,write_id,station,fingerprint,order_ids,recorded_at) VALUES (?,'private write','bar','private digest','[101,102]',?)`)
    .run(key(102),start+1);
  assert.equal((await list("",false)).status,403);
  for(const invalid of ["?date=2026-02-29","?id=-1","?station=bogus","?station=hot&station=bar","?before=1:"+key(1)])
    assert.equal((await list(invalid)).status,400);
  const first=await (await list("?station=hot&id=0101")).json();
  assert.equal(first.date,"2026-11-25");
  assert.equal(first.id,101);
  assert.equal(first.station,"hot");
  assert.deepEqual(first.batches.map(row=>row.operationId),Array.from({length:25},(_,index)=>key(27-index)));
  assert.equal(first.nextBefore,start+":"+key(3));
  assert.deepEqual(Object.keys(first.batches[0]).sort(),["completed","operationId","orderIds","recordedAt","station"]);
  assert.deepEqual(first.batches[0].orderIds,[27,101]);
  insert.run(key(103),"[101,102]",start+2);
  const second=await (await list("?station=hot&id=101&before="+encodeURIComponent(first.nextBefore))).json();
  assert.deepEqual(second.batches.map(row=>row.operationId),[key(2),key(1)]);
  assert.equal(second.nextBefore,null);
  const bar=await (await list("?station=bar&id=0101")).json();
  assert.deepEqual(bar.batches.map(row=>row.operationId),[key(102)]);
  const only=await (await list("?id=027")).json();
  assert.deepEqual(only.batches.map(row=>row.operationId),[key(27)]);
  const nextDay=await (await list("?date=2026-11-26&id=101")).json();
  assert.deepEqual(nextDay.batches.map(row=>row.operationId),[key(101)]);
  const plan=db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT operation_id FROM station_batch_receipts
    WHERE station=? AND recorded_at>=? AND recorded_at<? ORDER BY recorded_at DESC,operation_id DESC LIMIT 26`)
    .all("hot",start,end);
  assert.ok(plan.some(row=>row.detail.includes("station_batch_receipts_station_day")));
});

test("return ledger report groups cross-day corrections by Taipei event date and keeps audit fields private",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const start=Date.parse("2026-11-25T00:00:00+08:00"),end=Date.parse("2026-11-26T00:00:00+08:00");
  let now=start+50;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"staff"};
  const report=(query,staff=true)=>api(new Request("https://order.example/api/kitchen/return-ledger-report"+query,{
    headers:staff?{Authorization:"Bearer staff"}:{},
  }),runtime);
  for(let id=1;id<=3;id++)db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created)
    VALUES (?,?,'pickup','private customer note','[]',345,?)`).run(id,crypto.randomUUID(),start-100);
  const add=db.sqlite.prepare(`INSERT INTO return_quote_entries
    (order_id,revision,operation_id,selection,quote,recorded_at) VALUES (?,?,?,'private selection',?,?)`);
  const addAt=(id,revision,amount,at)=>add.run(id,revision,crypto.randomUUID(),JSON.stringify({amount,lines:[],remainingValue:0}),at);
  addAt(1,1,85,start-1);addAt(1,2,72,start);addAt(2,1,0,start);addAt(3,1,45,end);addAt(3,2,167,start+51);
  db.sqlite.prepare(`INSERT INTO return_quote_voids
    (order_id,revision,target_revision,operation_id,reason,restored_amount,remaining_value,recorded_at)
    VALUES (1,3,1,?,'更正昨日登記',85,273,?)`).run(crypto.randomUUID(),start+5);
  assert.equal((await report("?date=2026-11-25",false)).status,403);
  for(const query of ["","?date=2026-02-30","?date=2026-11-25&date=2026-11-26"])
    assert.equal((await report(query)).status,400);
  const response=await report("?date=2026-11-25");
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const {fingerprint,...data}=await response.json();
  assert.match(fingerprint,/^[a-f0-9]{64}$/);
  assert.deepEqual(data,{format:"hey-table.return-ledger-report.v1",timeZone:"Asia/Taipei",date:"2026-11-25",capturedAt:now,
    totals:{recordedCount:2,recordedAmount:72,voidedCount:1,restoredAmount:85,netAmount:-13},
    events:[
      {orderId:1,revision:3,recordedAt:start+5,kind:"voided",amount:85,targetRevision:1,reason:"更正昨日登記"},
      {orderId:2,revision:1,recordedAt:start,kind:"recorded",amount:0},
      {orderId:1,revision:2,recordedAt:start,kind:"recorded",amount:72},
    ],reviews:[]});
  const yesterday=await (await report("?date=2026-11-24")).json();
  assert.deepEqual(yesterday.events,[{orderId:1,revision:1,recordedAt:start-1,kind:"recorded",amount:85}]);
  now=end;
  const tomorrow=await (await report("?date=2026-11-26")).json();
  assert.deepEqual(tomorrow.events,[{orderId:3,revision:1,recordedAt:end,kind:"recorded",amount:45}]);
});

test("return ledger confirmation archives exact activity and rolls back incomplete or stale writes",async t=>{
  const db=database(),date="2026-11-25";
  t.after(()=>db.sqlite.close());
  const start=Date.parse(date+"T00:00:00+08:00");
  let now=start+50;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"staff"},url="https://order.example/api/kitchen/return-ledger-report";
  const headers={Authorization:"Bearer staff","Content-Type":"application/json"};
  const get=async(day=date)=>(await api(new Request(url+"?date="+day,{headers}),runtime)).json();
  const confirm=(fingerprint,note,day=date,access=headers,capturedAt)=>api(new Request(url,{
    method:"POST",headers:access,body:JSON.stringify({fingerprint,note,date:day,capturedAt}),
  }),runtime);
  const archive=(fingerprint,day=date,access=headers)=>api(new Request(url+"?"+new URLSearchParams({
    date:day,review:fingerprint,
  }),{headers:access}),runtime);
  db.sqlite.prepare(`INSERT INTO orders(id,token,mode,note,items,total,created) VALUES (1,?,'pickup','','[]',200,?)`)
    .run(crypto.randomUUID(),start-1);
  const insert=db.sqlite.prepare(`INSERT INTO return_quote_entries (order_id,revision,operation_id,selection,quote,recorded_at)
    VALUES (1,?,?,'[]',?,?)`);
  const append=(revision,amount,at=now)=>insert.run(revision,crypto.randomUUID(),JSON.stringify({amount}),at);
  append(1,35);

  const original=await get();
  assert.equal((await confirm(original.fingerprint,"",date,{"Content-Type":"application/json"})).status,403);
  for(const [fingerprint,note,day] of [["invalid","",date],[original.fingerprint,"a".repeat(161),date],
    [original.fingerprint,"",{toString:1}],[original.fingerprint,"","2026-11-26"]])
    assert.equal((await confirm(fingerprint,note,day)).status,400);
  for(const capture of [null,start-1,now+1])assert.equal((await confirm(original.fingerprint,"",date,headers,capture)).status,400);
  assert.equal((await archive(original.fingerprint,date,{})).status,403);
  assert.equal((await archive("unverified")).status,400);
  assert.equal((await archive(original.fingerprint)).status,404);
  now++;
  const competing=await Promise.all(["  晚班核對  ","另一份備註"].map(note=>
    confirm(original.fingerprint,note,date,headers,original.capturedAt)));
  assert.deepEqual(competing.map(response=>response.status).sort(),[200,409]);
  const first=await competing.find(response=>response.ok).json();
  assert.equal(first.reviewedAt,now);
  assert.equal(first.netAmount,35);
  assert.equal(first.eventCount,1);
  assert.ok(["晚班核對","另一份備註"].includes(first.note));
  now++;
  assert.equal((await get()).fingerprint,original.fingerprint);
  assert.deepEqual(await (await confirm(original.fingerprint,first.note)).json(),first);

  append(2,0,original.capturedAt);
  const newer=await get();
  assert.notEqual(newer.fingerprint,original.fingerprint);
  assert.deepEqual(newer.reviews,[first]);
  assert.equal(newer.totals.netAmount,original.totals.netAmount);
  const batch=db.batch.bind(db),race=t.mock.method(db,"batch",statements=>{
    append(3,80,now+1);
    return batch(statements);
  });
  assert.equal((await confirm(newer.fingerprint,"核對兩筆")).status,409);
  assert.equal(race.mock.callCount(),1);
  race.mock.restore();
  assert.deepEqual((await get()).reviews,[first]);
  now++;
  const latest=await get();
  assert.equal(latest.events.length,3);
  db.sqlite.exec(`CREATE TEMP TRIGGER block_archived_review_events BEFORE INSERT ON return_ledger_review_events
    BEGIN SELECT RAISE(ABORT,'simulated archive write failure'); END;`);
  await assert.rejects(confirm(latest.fingerprint,"完成交班"),/simulated archive write failure/);
  db.sqlite.exec("DROP TRIGGER block_archived_review_events");
  assert.deepEqual((await get()).reviews,[first]);
  assert.equal((await archive(latest.fingerprint)).status,404);
  const responses=await Promise.all([confirm(latest.fingerprint,"完成交班"),confirm(latest.fingerprint,"完成交班")]);
  const second=await responses[0].json();
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  assert.deepEqual(await responses[1].json(),second);
  assert.deepEqual(second,{fingerprint:latest.fingerprint,note:"完成交班",reviewedAt:now,eventCount:3,netAmount:115});
  assert.deepEqual((await get()).reviews,[second,first]);
  assert.deepEqual(await (await confirm(original.fingerprint,first.note)).json(),first);
  assert.deepEqual((await get("2026-11-24")).reviews,[]);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM return_ledger_reviews").get().count,2);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM return_ledger_review_events").get().count,4);
  const response=await archive(original.fingerprint);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const {reviews,...snapshot}=original;
  assert.deepEqual(reviews,[]);
  assert.deepEqual(await response.json(),{...snapshot,review:first,captureSource:"saved"});
  assert.equal((await archive(original.fingerprint,"2026-11-24")).status,404);
});

test("older return-ledger confirmations only reopen when the original event fingerprint is provable",async t=>{
  const date="2026-11-25",now=Date.parse(date+"T12:00:00+08:00");
  const oldEvents=[[1,1,now-100,"recorded",75,null,null]];
  const hash=async rows=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(["hey-table.return-ledger-review.v1",date,rows])))),
  byte=>byte.toString(16).padStart(2,"0")).join("");
  const fingerprint=await hash(oldEvents),emptyFingerprint=await hash([]);
  const db=database((tag,sqlite)=>{
    if(tag!=="0043_return_ledger_review_events")return;
    sqlite.prepare("INSERT INTO orders(id,token,mode,note,items,total,created) VALUES (1,?,'pickup','','[]',200,?)")
      .run(crypto.randomUUID(),now-1000);
    sqlite.prepare(`INSERT INTO return_quote_entries(order_id,revision,operation_id,selection,quote,recorded_at)
      VALUES (1,1,?,'[]','{"amount":75}',?)`).run(crypto.randomUUID(),now-100);
    const review=sqlite.prepare(`INSERT INTO return_ledger_reviews(date,fingerprint,event_count,net_amount,reviewed_at,note)
      VALUES (?,?,?,?,?,?)`);
    review.run(date,emptyFingerprint,0,0,now-200,"空班");
    review.run(date,fingerprint,1,75,now,"舊班備註");
  });
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"staff"};
  const archive=value=>api(new Request("https://order.example/api/kitchen/return-ledger-report?"+
    new URLSearchParams({date,review:value}),{headers:{Authorization:"Bearer staff"}}),runtime);
  const insert=db.sqlite.prepare(`INSERT INTO return_quote_entries(order_id,revision,operation_id,selection,quote,recorded_at)
    VALUES (1,?,?,'[]','{"amount":25}',?)`);
  insert.run(2,crypto.randomUUID(),now+1);
  const archived=await (await archive(fingerprint)).json();
  assert.equal(archived.captureSource,"reconstructed");
  assert.equal(archived.capturedAt,now);
  assert.equal(archived.review.note,"舊班備註");
  assert.deepEqual(archived.events,[{orderId:1,revision:1,recordedAt:now-100,kind:"recorded",amount:75}]);
  assert.deepEqual((await (await archive(emptyFingerprint)).json()).events,[]);
  insert.run(3,crypto.randomUUID(),now-110);
  const unsafe=await archive(fingerprint);
  assert.equal(unsafe.status,409);
  assert.match((await unsafe.json()).error,/無法完整核對/);
});

test("return review history pages by a stable date-scoped boundary across newer writes and tied counts",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",otherDate="2026-11-24",stamp=Date.parse(date+"T12:00:00+08:00");
  const runtime={DB:db,STAFF_KEY:"staff"};
  const url="https://order.example/api/kitchen/return-ledger-review-history?";
  const staff={Authorization:"Bearer staff"};
  const read=(query,headers=staff)=>api(new Request(url+query,{headers}),runtime);
  const insert=db.sqlite.prepare(`INSERT INTO return_ledger_reviews(date,fingerprint,event_count,net_amount,reviewed_at,note)
    VALUES (?,?,?,?,?,?)`);
  const key=n=>n.toString(16).padStart(64,"0");
  for(let n=1;n<=23;n++)insert.run(date,key(n),Math.floor(n/3),n-10,stamp,"確認 "+n);
  insert.run(otherDate,key(40),999,32,stamp,"隔日獨立");
  const query=new URLSearchParams({date});
  const first=await read(query);
  assert.equal(first.headers.get("Cache-Control"),"no-store");
  const firstPage=await first.json();
  assert.equal(firstPage.date,date);
  assert.deepEqual(firstPage.reviews.map(row=>row.fingerprint),[23,22,21,20,19,18,17,16,15,14].map(key));
  assert.equal(firstPage.nextBefore,key(14));
  assert.deepEqual(firstPage.reviews[0],{fingerprint:key(23),eventCount:7,netAmount:13,reviewedAt:stamp,note:"確認 23"});
  insert.run(date,key(24),8,14,stamp,"同時新增");
  query.set("before",firstPage.nextBefore);
  const second=await (await read(query)).json();
  assert.deepEqual(second.reviews.map(row=>row.fingerprint),[13,12,11,10,9,8,7,6,5,4].map(key));
  assert.equal(second.nextBefore,key(4));
  query.set("before",second.nextBefore);
  const third=await (await read(query)).json();
  assert.deepEqual(third.reviews.map(row=>row.fingerprint),[3,2,1].map(key));
  assert.equal(third.nextBefore,null);
  assert.equal((await (await read("date="+date)).json()).reviews[0].fingerprint,key(24));
  assert.equal((await (await read("date="+otherDate)).json()).reviews[0].fingerprint,key(40));
  assert.equal((await read("date="+date+"&before="+key(40))).status,404);
  assert.equal((await read("date="+date+"&before="+key(999))).status,404);
  for(const invalid of ["date=2026-02-30","date="+date+"&date="+otherDate,
    "date="+date+"&before=","date="+date+"&before=invalid","date="+date+"&before="+key(4)+"&before="+key(5)])
    assert.equal((await read(invalid)).status,400);
  assert.equal((await read("date="+date,{})).status,403);
  assert.deepEqual(await (await read("date=2026-11-23")).json(),{date:"2026-11-23",reviews:[],nextBefore:null});

  const plan=db.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT note FROM return_ledger_reviews WHERE date=?
    AND (event_count,reviewed_at,fingerprint) < (?,?,?) ORDER BY event_count DESC,reviewed_at DESC,fingerprint DESC LIMIT 11`)
    .all(date,4,stamp,key(14));
  assert.ok(plan.some(row=>row.detail.includes("return_ledger_reviews_by_day")));
  assert.ok(plan.every(row=>!row.detail.includes("TEMP B-TREE")));
});

test("the return handoff demo reproduces the real report, cross-day void and archive from synthetic data",async()=>{
  const checkedIn=JSON.parse(readFileSync(new URL("../examples/return-ledger-demo.json",import.meta.url),"utf8"));
  const sample=await buildReturnLedgerDemo();
  assert.deepEqual(sample,checkedIn);
  assert.deepEqual([sample.before.totals.netAmount,sample.after.totals.netAmount,sample.archived.totals.netAmount],[45,-40,45]);
  assert.equal(sample.after.events[0].kind,"voided");
  assert.equal(sample.before.fingerprint,sample.archived.fingerprint);
  assert.notEqual(sample.after.fingerprint,sample.archived.fingerprint);
});

test("staff can read orders beyond the recent board without exposing checkout references or changing state",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"staff"};
  const headers={Authorization:"Bearer staff"};
  const call=(path,staff=headers)=>api(new Request("https://order.example"+path,{headers:staff}),runtime);
  const detail="/api/kitchen/order-detail";
  const now=Date.parse("2026-11-25T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const item={id:"katsudon",name:"滑蛋豬排丼",qty:1,price:190,note:"醬汁另外放",internal:"private item field"};
  const day=86400000;
  const insert=db.sqlite.prepare(`INSERT INTO orders
    (token,mode,table_no,note,items,total,created,status,payment_method,payment_env,status_history)
    VALUES (?,'table','A04','',?,190,?,?,?,?,?)`);
  const add=(created,status="completed",method="cash",environment="cash",history=null)=>{
    const token=crypto.randomUUID(),{lastInsertRowid}=insert.run(token,JSON.stringify([item]),created,status,method,environment,history);
    return {id:Number(lastInsertRowid),token};
  };
  const old=add(now-day);
  for(let i=0;i<21;i++)add(now+i);
  const cancellation=JSON.stringify([{from:"pending",status:"cancelled",at:now,actor:"demo_refund"}]);
  const refunded=add(now-1000,"cancelled","line_pay","demo",cancellation);
  db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,trade_id,redirect_url,created)
    VALUES (?,'private reference','private merchant','refunded','private trace','https://example.com/private',?)`).run(refunded.id,now);
  assert.equal((await call(detail+"?id="+old.id,{})).status,403);
  assert.equal((await call(detail+"?id=0")).status,400);
  assert.equal((await call(detail+"?id=1&id=1")).status,400);
  assert.equal((await call(detail+"?id=9999")).status,404);
  const board=await (await call("/api/kitchen")).json();
  assert.equal(board.some(order=>order.id===old.id),false);
  const response=await call(detail+"?id="+String(old.id).padStart(4,"0"));
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const order=await response.json();
  assert.equal(order.id,old.id);
  assert.equal(order.table,"A04");
  assert.deepEqual(order.statusHistory,[{status:"pending",at:now-day},{status:"completed",at:null}]);
  assert.deepEqual(order.stations,[]);
  assert.deepEqual(order.items,[{id:item.id,name:item.name,qty:1,price:190,note:item.note}]);
  assert.ok(!JSON.stringify(order).includes(old.token));
  const refund=await (await call(detail+"?id="+refunded.id)).json();
  assert.deepEqual(refund.demoRefund,{amount:190,refundedAt:now});
  assert.equal(refund.statusHistory.at(-1).actor,"demo_refund");
  assert.ok(!JSON.stringify(refund).includes("private"));
  const pending=add(now-day,"pending","line_pay","demo");
  db.sqlite.prepare("UPDATE orders SET payment_due_at=? WHERE id=?").run(now-1,pending.id);
  assert.equal((await (await call(detail+"?id="+pending.id)).json()).status,"pending");
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id=?").get(pending.id).status,"pending");
});

test("prep station views use saved assignments and group old stations without exposing order notes",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",now=Date.parse(date+"T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"staff"},staff={Authorization:"Bearer staff"};
  const item=(id,qty)=>({id,qty,note:"private fixture note"});
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status,station_progress)
    VALUES (?,'pickup','private guest note',?,100,?,?,?)`);
  const add=(status,items,progress=null)=>Number(insert.run(crypto.randomUUID(),JSON.stringify(items),now,status,
    progress&&JSON.stringify(progress)).lastInsertRowid);
  const current=add("pending",[item("katsudon",1),item("sencha",1)]);
  const groups={hot:[item("katsudon",3)],cold:[item("sencha",2)],legacy:[item("old-tofu",4)]};
  const existing=add("preparing",Object.values(groups).flat(),{groups,done:{hot:now-1000}});
  const ready=add("ready",[item("sencha",1)]);
  const read=(params,headers=staff)=>api(new Request("https://order.example/api/kitchen/prep?date="+date+params,{headers}),runtime);
  assert.equal((await read("&stationBreakdown=1",{})).status,403);
  const response=await read("&stationBreakdown=1&stationProgress=1");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("private"));
  const report=JSON.parse(raw);
  assert.equal(report.capturedAt,now);
  const order=(id,status,dish,qty)=>({id,created:now,status,items:[{id:dish,qty}]});
  const hot=order(current,"pending","katsudon",1),bar=order(current,"pending","sencha",1);
  const hotDone=order(existing,"preparing","katsudon",3),cold=order(existing,"preparing","sencha",2);
  const other=order(existing,"preparing","old-tofu",4);
  assert.deepEqual(report.stationOrders,{
    hot:{orders:[hot,hotDone],remainingOrders:[hot]},cold:{orders:[cold],remainingOrders:[cold]},
    bar:{orders:[bar],remainingOrders:[bar]},other:{orders:[other],remainingOrders:[other]},
  });
  assert.ok(report.orders.every(row=>row.id!==ready));
  const portions=rows=>rows.flatMap(row=>row.items).reduce((count,item)=>count+item.qty,0);
  for(const key of ["orders","remainingOrders"])
    assert.equal(Object.values(report.stationOrders).reduce((sum,station)=>sum+portions(station[key]),0),portions(report[key]));
  const standard=await (await read("")).json();
  assert.equal(standard.stationOrders,undefined);
  assert.equal(standard.remainingOrders,undefined);
  const stationsOnly=await (await read("&stationBreakdown=1")).json();
  assert.equal(stationsOnly.remainingOrders,undefined);
  assert.deepEqual(stationsOnly.stationOrders,report.stationOrders);
});

test("staff demo refunds commit with cancellation, release a booking, preserve completed orders and roll back on failure",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",now=Date.parse(date+"T11:00:00+08:00"),slot=Date.parse(date+"T12:00:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const shop={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,{method="GET",headers={},data}={},override={})=>api(new Request("https://order.example"+path,{
    method,headers:{...headers,...(data?{"Content-Type":"application/json"}:{})},...(data?{body:JSON.stringify(data)}:{}),
  }),{...shop,...override});
  const place=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,payment_method,payment_env,status,created,pickup_slot)
    VALUES (?,'pickup','','[{"id":"sencha","qty":2}]',90,'line_pay',?,?,?,?)`);
  const pay=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,'fixture',?,?)");
  function purchase({mode="demo",status="pending",start=null,state="paid"}={}){
    const token=crypto.randomUUID();
    const id=Number(place.run(token,mode,status,now-1000,start).lastInsertRowid);
    pay.run(id,"fixture-"+id,state,now-900);
    return {token,id};
  }
  const pending=purchase({start:slot}),completed=purchase({status:"completed"});
  const live=purchase({mode:"production"}),unpaid=purchase({state:"pending"});
  const refund=(order,expectedStatus,expectedTotal=90,headers=staff,override)=>call("/api/kitchen/demo-refund",{
    method:"PATCH",headers,data:{id:order.id,expectedStatus,expectedTotal},
  },override);
  const receipt=async order=>(await (await call("/api/ticket?progress=1",{headers:{"X-Ticket":order.token}})).json());
  const remaining=async()=>(await (await call("/api/pickup-slots?date="+date)).json()).slots.find(entry=>entry.start===slot).remaining;
  assert.equal(await remaining(),10);
  assert.equal((await refund(pending,"pending",90,{})).status,403);
  assert.equal((await refund(pending,"pending",90,staff,{TAPPAY_MODE:"sandbox"})).status,403);
  assert.equal((await refund(live,"pending")).status,403);
  assert.equal((await refund(unpaid,"pending")).status,409);
  assert.equal((await refund(pending,"ready")).status,409);
  assert.equal((await refund(pending,"pending",89)).status,409);
  db.sqlite.exec(`CREATE TRIGGER reject_cancel BEFORE UPDATE OF status ON orders WHEN NEW.status='cancelled'
    BEGIN SELECT RAISE(ABORT,'simulated cancellation failure'); END;`);
  await assert.rejects(refund(pending,"pending"),/simulated cancellation failure/);
  assert.equal((await receipt(pending)).paymentState,"paid");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM demo_refunds").get().count,0);
  assert.equal(await remaining(),10);
  db.sqlite.exec("DROP TRIGGER reject_cancel");
  const done={id:pending.id,total:90,status:"cancelled",paymentState:"refunded"};
  assert.deepEqual(await (await refund(pending,"pending")).json(),done);
  assert.deepEqual(await (await refund(pending,"pending")).json(),done);
  assert.equal(await remaining(),12);
  const after=await receipt(pending);
  assert.equal(after.paymentState,"refunded");
  assert.deepEqual(after.statusHistory.filter(event=>event.status==="cancelled"),[{status:"cancelled",at:now,actor:"demo_refund"}]);
  assert.deepEqual(await (await refund(completed,"completed")).json(),
    {id:completed.id,total:90,status:"completed",paymentState:"refunded"});
  assert.equal((await receipt(completed)).status,"completed");
  assert.equal((await receipt(live)).paymentState,"paid");
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM demo_refunds").get().count,2);
});

test("refund handoff uses Taiwan transaction dates, preserves the first refund time and reads timed legacy cancellations",async t=>{
  const day="2026-11-25",boundary=Date.parse(day+"T00:00:00+08:00");
  let now=boundary-1;
  t.mock.method(Date,"now",()=>now);
  let cancelledId,undatedId;
  const db=database((tag,sqlite)=>{
    if(tag!=="0027_demo_refunds")return;
    const add=sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,payment_method,payment_env,status,created,status_history)
      VALUES (?,'table','不應匯出的備註','[]',45,'line_pay','demo',?,?,?)`);
    cancelledId=Number(add.run(crypto.randomUUID(),"cancelled",boundary-10000,
      JSON.stringify([{from:"ready",status:"cancelled",at:boundary,actor:"demo_refund"}])).lastInsertRowid);
    undatedId=Number(add.run(crypto.randomUUID(),"completed",boundary-20000,null).lastInsertRowid);
    const pay=sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,'demo','refunded',?)`);
    for(const id of [cancelledId,undatedId])pay.run(id,"older-"+id,boundary-10000);
  });
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const endpoint="/api/kitchen/demo-refunds";
  const call=(path,headers=staff)=>api(new Request("https://order.example"+path,{headers}),runtime);
  const place=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,payment_method,payment_env,status,created)
    VALUES (?,'pickup','不應匯出的備註','[]',90,'px_pay_plus','demo','completed',?)`);
  const pay=db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,'demo','paid',?)`);
  const purchase=()=>{
    const id=Number(place.run(crypto.randomUUID(),boundary-86_400_000).lastInsertRowid);
    pay.run(id,"newer-"+id,boundary-10000);
    return id;
  };
  const refund=id=>api(new Request("https://order.example/api/kitchen/demo-refund",{method:"PATCH",
    headers:{...staff,"Content-Type":"application/json"},body:JSON.stringify({id,expectedTotal:90,expectedStatus:"completed"}),
  }),runtime);
  const yesterday=purchase(),today=purchase();
  assert.equal((await refund(yesterday)).status,200);
  now=boundary;
  assert.equal((await refund(today)).status,200);
  now+=10_000;
  assert.equal((await refund(yesterday)).status,200);
  assert.equal((await refund(today)).status,200);
  assert.equal((await call(endpoint,{})).status,403);
  assert.equal((await call(endpoint+"?date=2026-02-30")).status,400);
  const response=await call(endpoint);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("不應匯出的備註"));
  assert.deepEqual(JSON.parse(raw),{format:"hey-table.demo-refunds.v1",date:day,timeZone:"Asia/Taipei",capturedAt:now,
    refunds:[
      {orderId:today,mode:"pickup",paymentMethod:"px_pay_plus",amount:90,previousStatus:"completed",refundedAt:boundary,source:"recorded"},
      {orderId:cancelledId,mode:"table",paymentMethod:"line_pay",amount:45,previousStatus:"ready",refundedAt:boundary,source:"cancellation_history"},
    ],totals:{count:2,amount:135,completed:1}});
  const previous=await (await call(endpoint+"?date=2026-11-24")).json();
  assert.deepEqual(previous.refunds,[
    {orderId:yesterday,mode:"pickup",paymentMethod:"px_pay_plus",amount:90,previousStatus:"completed",refundedAt:boundary-1,source:"recorded"},
  ]);
  assert.deepEqual((await (await call(endpoint+"?date=2026-11-26")).json()).refunds,[]);

  const tokenFor=id=>db.sqlite.prepare("SELECT token FROM orders WHERE id=?").get(id).token;
  const privateReceipt="/api/ticket/refund-receipt";
  const readRefund=(path,id)=>call(path,{"X-Ticket":tokenFor(id)});
  assert.equal((await call(privateReceipt,{})).status,404);
  assert.equal((await call(privateReceipt,{"X-Ticket":crypto.randomUUID()})).status,404);
  assert.equal((await readRefund(privateReceipt,purchase())).status,409);
  const production=purchase();
  db.sqlite.prepare("UPDATE orders SET payment_env='production' WHERE id=?").run(production);
  db.sqlite.prepare("UPDATE payment_attempts SET state='refunded' WHERE order_id=?").run(production);
  assert.equal((await readRefund(privateReceipt,production)).status,409);
  assert.ok(!Object.hasOwn(await (await readRefund("/api/ticket",production)).json(),"demoRefund"));
  for(const [id,amount,at] of [[today,90,boundary],[cancelledId,45,boundary],[undatedId,45,null]]){
    const ticket=await (await readRefund("/api/ticket?progress=1",id)).json();
    assert.deepEqual(ticket.demoRefund,{amount,refundedAt:at});
    const file=await readRefund(privateReceipt,id);
    assert.equal(file.status,200);
    assert.equal(file.headers.get("Content-Type"),"text/plain; charset=utf-8");
    assert.equal(file.headers.get("Cache-Control"),"private, no-store");
    assert.equal(file.headers.get("X-Content-Type-Options"),"nosniff");
    const padded=String(id).padStart(4,"0");
    assert.equal(file.headers.get("Content-Disposition"),`attachment; filename="hey-table-refund-${padded}.txt"`);
    const contents=await file.text();
    assert.ok(contents.includes("取餐號碼 "+padded));
    assert.ok(contents.includes(`退款金額 NT$ ${amount}`));
    assert.ok(contents.includes(id===today?"支付方式 全支付":"支付方式 LINE Pay"));
    assert.equal(contents.includes("退款時間（台灣） 未記錄"),at===null);
    assert.ok(!contents.includes(tokenFor(id))&&!contents.includes("不應匯出的備註")&&!contents.includes("older-"));
  }
  const detail="/api/kitchen/demo-refund-detail?id=";
  assert.equal((await call(detail+today,{})).status,403);
  for(const invalid of ["","1e3","0","1&id=2","9007199254740992"])
    assert.equal((await call(detail+invalid)).status,400);
  for(const id of [purchase(),production,10000])assert.equal((await call(detail+id)).status,404);
  const items=[{name:"日式熱煎茶",qty:2,price:45,note:"不應匯出的單品備註"}];
  db.sqlite.prepare("UPDATE orders SET items=? WHERE id=?").run(JSON.stringify(items),today);
  const current=await call(detail+String(today).padStart(4,"0"));
  assert.equal(current.status,200);
  assert.equal(current.headers.get("cache-control"),"no-store");
  const currentRaw=await current.text();
  assert.ok(!currentRaw.includes(tokenFor(today))&&!currentRaw.includes("不應匯出")&&!currentRaw.includes("newer-"));
  assert.deepEqual(JSON.parse(currentRaw),{format:"hey-table.demo-refund-detail.v1",timeZone:"Asia/Taipei",capturedAt:now,
    order:{id:today,mode:"pickup",createdAt:boundary-86_400_000,status:"completed",total:90,paymentMethod:"px_pay_plus",
      paymentState:"refunded",items:[{name:"日式熱煎茶",qty:2}]},
    refund:{amount:90,refundedAt:boundary,previousStatus:"completed",source:"recorded"}});
  const historic=await (await call(detail+cancelledId)).json();
  assert.deepEqual(historic.refund,{amount:45,refundedAt:boundary,previousStatus:"ready",source:"cancellation_history"});
  assert.equal(historic.order.status,"cancelled");
  db.sqlite.prepare("UPDATE orders SET status='cancelled',status_history=? WHERE id=?").run("damaged legacy history",undatedId);
  const unknown=await (await call(detail+undatedId)).json();
  assert.deepEqual(unknown.refund,{amount:45,refundedAt:null,previousStatus:null,source:"legacy_payment"});
  assert.ok((await call(endpoint)).ok);
});

test("pickup display omits refunded orders even if their kitchen status is still ready",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const add=db.sqlite.prepare(`INSERT INTO orders
    (token,mode,note,items,total,created,status,payment_method,payment_env)
    VALUES (?,'pickup','只在店員餐單','[]',100,1,'ready','line_pay','sandbox')`);
  const {lastInsertRowid:paid}=add.run(crypto.randomUUID());
  const {lastInsertRowid:refunded}=add.run(crypto.randomUUID());
  const attempt=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,?,?,1)");
  attempt.run(paid,"fixture-paid","fixture","paid");
  attempt.run(refunded,"fixture-refunded","fixture","refunded");
  const result=await api(new Request("https://order.example/api/kitchen/pickup-display",{
    headers:{Authorization:"Bearer local-test-key"},
  }),{DB:db,STAFF_KEY:"local-test-key"});
  assert.equal(result.status,200);
  const {capturedAt,...numbers}=await result.json();
  assert.ok(Number.isSafeInteger(capturedAt));
  assert.deepEqual(numbers,{ready:[paid],preparing:[]});
});
test("a payment refund blocks the entire reviewed table handoff",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const add=db.sqlite.prepare(`INSERT INTO orders
    (token,mode,table_no,note,items,total,created,status,payment_method,payment_env)
    VALUES (?,'table','A05','','[]',100,1,'ready',?,?)`);
  const {lastInsertRowid:wallet}=add.run(crypto.randomUUID(),"line_pay","sandbox");
  const {lastInsertRowid:cash}=add.run(crypto.randomUUID(),"cash","cash");
  db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,?,?,1)")
    .run(wallet,"fixture-handoff","fixture","refunded");
  const orders=[wallet,cash].map(id=>({id,tableRevision:0}));
  const handoff=()=>api(new Request("https://order.example/api/kitchen/table-handoff",{method:"PATCH",
    headers:{Authorization:"Bearer local-test-key","Content-Type":"application/json"},body:JSON.stringify({table:"A05",orders}),
  }),{DB:db,STAFF_KEY:"local-test-key"});
  const statuses=()=>db.sqlite.prepare("SELECT status FROM orders ORDER BY id").all().map(row=>row.status);
  assert.equal((await handoff()).status,409);
  assert.deepEqual(statuses(),["ready","ready"]);
  db.sqlite.prepare("UPDATE payment_attempts SET state='partial' WHERE order_id=?").run(wallet);
  assert.equal((await handoff()).status,200);
  assert.deepEqual(statuses(),["completed","completed"]);
});
test("same-day pickup slots use Taipei opening, notice and closing boundaries",()=>{
  const taipei=time=>Date.parse("2026-11-25T"+time+"+08:00");
  const early=bookablePickupSlots(taipei("10:30:00"));
  assert.equal(early.length,36);
  assert.equal(early[0],taipei("11:00:00"));
  assert.equal(early.at(-1),taipei("19:45:00"));
  assert.equal(bookablePickupSlots(taipei("10:30:00")+1)[0],taipei("11:15:00"));
  assert.deepEqual(bookablePickupSlots(taipei("19:15:00")),[taipei("19:45:00")]);
  assert.deepEqual(bookablePickupSlots(taipei("19:15:00")+1),[]);
  assert.deepEqual(bookablePickupSlots(taipei("23:59:59")),[]);
});
async function pickupWorkerOrigin(t){
  const {build}=await import("esbuild");
  const {Miniflare}=await import("miniflare");
  const root=fileURLToPath(new URL("../",import.meta.url));
  const bundle=await build({stdin:{resolveDir:root,contents:`
    import {api} from './server/api.mjs';
    Date.now=()=>Date.parse('2026-11-25T10:45:00+08:00');
    export default {fetch:api};`},bundle:true,format:"esm",write:false});
  const worker=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-15",
    host:"127.0.0.1",d1Databases:["DB"],bindings:{STAFF_KEY:"fixture-staff"}});
  t.after(()=>worker.dispose());
  await applyDemoMigrations(await worker.getD1Database("DB"),root);
  return (await worker.ready).origin;
}

test("D1 serializes shared bookings, capacity edits and competing staff and customer reschedules",async t=>{
  const host=await pickupWorkerOrigin(t);
  const pickupSlot=Date.parse("2026-11-25T12:00:00+08:00");
  const requests=Array.from({length:8},()=>({token:crypto.randomUUID(),mode:"pickup",note:"",items:[{id:"sencha",qty:3}],pickupSlot,expectedTotal:135}));
  const post=(path,data,headers={})=>fetch(host+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const staff={Authorization:"Bearer fixture-staff"};
  const submit=(data,index)=>index%2===0?post("/api/kitchen/create-pickup",data,staff):post("/api/orders",data);
  const responses=await Promise.all(requests.map(submit));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,200,200,200,409,409,409,409]);
  const results=await Promise.all(responses.map(response=>response.json()));
  assert.equal(new Set(results.filter(result=>result.pickupSlot===pickupSlot).map(result=>result.id)).size,4);
  assert.equal(results.filter(result=>result.code==="pickup_slot_full").length,4);
  results.forEach((result,index)=>{
    if(responses[index].ok)assert.equal(result.source??null,index%2===0?"staff":null);
  });
  const remaining=async start=>(await fetch(host+"/api/pickup-slots").then(response=>response.json())).slots.find(slot=>slot.start===start).remaining;
  assert.equal(await remaining(pickupSlot),0);
  const index=responses.findIndex(response=>response.ok),original=requests[index];
  const targets=[pickupSlot+900_000,pickupSlot+1_800_000];
  const acceptedId=results[index].id;
  const reschedule=(to,channel)=>channel===0?post("/api/ticket/reschedule",{from:pickupSlot,to,revision:0},{"X-Ticket":original.token}):
    fetch(host+"/api/kitchen/pickup-reschedule",{method:"PATCH",headers:{"Content-Type":"application/json",...staff},
      body:JSON.stringify({id:acceptedId,from:pickupSlot,to,revision:0})});
  const moved=await Promise.all(targets.map(reschedule));
  assert.deepEqual(moved.map(response=>response.status).sort(),[200,409]);
  const winner=moved.findIndex(response=>response.ok),changed=await moved[winner].json();
  assert.equal(changed.pickupSlot,targets[winner]);
  assert.equal(changed.pickupChanges.length,1);
  assert.equal(changed.pickupChanges[0].actor,winner===1?"staff":undefined);
  assert.deepEqual(await (await reschedule(changed.pickupSlot,winner)).json(),changed);
  assert.equal(await remaining(pickupSlot),3);
  assert.equal(await remaining(changed.pickupSlot),9);
  assert.equal(await remaining(targets[1-winner]),12);
  assert.deepEqual(await (await submit(original,index)).json(),{...results[index],pickupSlot:changed.pickupSlot});
  assert.equal((await submit({...original,pickupSlot:changed.pickupSlot},index)).status,409);

  const date="2026-11-25",endpoint="/api/kitchen/pickup-slots",start=targets[1-winner];
  const headers={"Content-Type":"application/json",Authorization:"Bearer fixture-staff"};
  const save=(capacity,revision)=>fetch(host+endpoint,{method:"PATCH",headers,body:JSON.stringify({date,start,capacity,revision})});
  const catchUp={...original,token:crypto.randomUUID(),pickupSlot:start};
  const [closed,booking]=await Promise.all([save(0,0),submit(catchUp,0)]);
  assert.equal(closed.status,200);
  assert.ok([200,409].includes(booking.status));
  assert.equal(await remaining(start),0);
  const snapshot=await fetch(host+endpoint+"?date="+date,{headers}).then(response=>response.json());
  const slot=snapshot.slots.find(slot=>slot.start===start);
  assert.deepEqual(slot,{start,end:start+900_000,capacity:0,used:booking.ok?3:0,remaining:0,revision:1,editable:true});
  assert.equal((await submit(catchUp,0)).status,booking.status);
  const competing=await Promise.all([save(3,1),save(6,1)]);
  assert.deepEqual(competing.map(response=>response.status).sort(),[200,409]);
});
test("D1 reserves supply by pickup day and moves that supply atomically across days",async t=>{
  const host=await pickupWorkerOrigin(t);
  const staff={Authorization:"Bearer fixture-staff"};
  const call=(path,headers={})=>fetch(host+path,{headers});
  const write=(path,body,headers={},method="POST")=>fetch(host+path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const setSupply=(date,capacity,revision=0)=>write("/api/kitchen/daily-limits",{date,dish:"sencha",capacity,revision},staff,"PATCH");
  const supply=async date=>(await (await call("/api/kitchen/daily-limits?date="+date,staff)).json()).limits.sencha;
  const prep=async(date="")=>(await (await call("/api/kitchen/prep"+(date?"?date="+date:""),staff)).json()).orders.map(order=>order.id);
  const start=(day,hour="12:00")=>Date.parse(day+"T"+hour+":00+08:00");
  const booking=pickupSlot=>({token:crypto.randomUUID(),mode:"pickup",pickupSlot,note:"",
    items:[{id:"sencha",qty:2}],expectedTotal:90});
  const today="2026-11-25",tomorrow="2026-11-26",dayAfter="2026-11-27";
  const last="2026-12-01",outside="2026-12-02";
  assert.equal((await call("/api/pickup-slots?date="+last)).status,200);
  assert.equal((await call("/api/pickup-slots?date="+outside)).status,400);
  assert.equal((await call("/api/menu?date=2026-11-24")).status,400);
  assert.equal((await (await write("/api/orders",booking(start(outside)))).json()).code,"pickup_slot_closed");
  assert.equal((await setSupply(today,0)).status,200);
  assert.equal((await setSupply(tomorrow,2)).status,200);
  assert.equal((await setSupply(dayAfter,1)).status,200);
  assert.equal((await (await call("/api/menu")).json()).remaining.sencha,0);
  assert.equal((await (await call("/api/menu?date="+tomorrow)).json()).remaining.sencha,2);

  const originals=[booking(start(tomorrow)),booking(start(tomorrow,"12:15"))];
  const submit=(order,channel)=>channel===0?write("/api/orders",order):write("/api/kitchen/create-pickup",order,staff);
  const offered=await Promise.all(originals.map(submit));
  assert.deepEqual(offered.map(response=>response.status).sort(),[200,409]);
  const index=offered.findIndex(response=>response.ok);
  const accepted=await offered[index].json();
  assert.equal((await offered[1-index].json()).code,"portion_limit");
  assert.equal((await supply(today)).used,0);
  assert.equal((await supply(tomorrow)).used,2);
  assert.deepEqual(await prep(),[]);
  assert.deepEqual(await prep(tomorrow),[accepted.id]);

  const guest={"X-Ticket":originals[index].token};
  const options="/api/ticket/reschedule-options?date=";
  const staffOptions=`/api/kitchen/pickup-reschedule-options?id=${accepted.id}&date=`;
  assert.equal((await call(options+dayAfter)).status,404);
  assert.equal((await call(options+dayAfter,{"X-Ticket":originals[1-index].token})).status,404);
  assert.equal((await call(staffOptions+dayAfter)).status,403);
  assert.equal((await call(options+outside,guest)).status,400);
  const sameOptions=await (await call(options+tomorrow,guest)).json();
  assert.deepEqual(sameOptions.shortages,[]);
  const guestOptions=await call(options+dayAfter,guest);
  assert.equal(guestOptions.headers.get("Cache-Control"),"no-store");
  const shortage=await guestOptions.json();
  assert.deepEqual(shortage.shortages,["sencha"]);
  assert.ok(shortage.slots.some(slot=>slot.remaining>=2));
  assert.deepEqual(await (await call(staffOptions+dayAfter,staff)).json(),shortage);
  const paused="2026-11-28",alternative="2026-11-29",closed=start(alternative,"11:00");
  assert.equal((await write("/api/kitchen/pickup-day",{date:paused,accepting:false,revision:0},staff,"PATCH")).status,200);
  assert.equal((await write("/api/kitchen/pickup-slots",{date:alternative,start:closed,capacity:1,revision:0},staff,"PATCH")).status,200);
  const suggest=day=>options+day+"&suggest=1";
  const suggested=await call(suggest(tomorrow),guest);
  assert.equal(suggested.headers.get("Cache-Control"),"no-store");
  assert.deepEqual(await suggested.json(),{suggestion:{date:alternative,start:closed+900_000}});
  assert.deepEqual(await (await call(staffOptions+tomorrow+"&suggest=1",staff)).json(),
    {suggestion:{date:alternative,start:closed+900_000}});
  assert.deepEqual(await (await call(suggest(last),guest)).json(),{suggestion:null});
  assert.equal((await call(suggest(tomorrow))).status,404);
  const cart={afterDate:tomorrow,items:[{id:"sencha",qty:2}]};
  const findCart=(input=cart)=>write("/api/pickup-suggestion",input);
  const findStaff=(headers=staff)=>write("/api/kitchen/pickup-suggestion",cart,headers);
  assert.equal((await findStaff({})).status,403);
  assert.equal((await findCart({...cart,items:[]})).status,400);
  assert.equal((await findCart({...cart,afterDate:outside})).status,400);
  const found=await findCart();
  assert.equal(found.headers.get("Cache-Control"),"no-store");
  assert.deepEqual(await found.json(),{suggestion:{date:alternative,start:closed+900_000}});
  assert.deepEqual(await (await findStaff()).json(),{suggestion:{date:alternative,start:closed+900_000}});
  assert.equal((await write("/api/kitchen/availability",{id:"sencha",available:false},staff,"PATCH")).status,200);
  assert.deepEqual(await (await findCart()).json(),{suggestion:null});
  assert.equal((await write("/api/kitchen/availability",{id:"sencha",available:true},staff,"PATCH")).status,200);
  assert.deepEqual(await (await findCart({...cart,afterDate:last})).json(),{suggestion:null});
  assert.equal((await supply(alternative)).used,0);
  const move=(from,to,revision)=>write("/api/kitchen/pickup-reschedule",{id:accepted.id,from,to,revision},staff,"PATCH");
  const receipt=async()=>(await (await call("/api/ticket?progress=1",guest)).json());
  const sameDay=start(tomorrow,"12:30"),nextDay=start(dayAfter);
  assert.equal((await move(accepted.pickupSlot,sameDay,0)).status,200);
  const full=await move(sameDay,nextDay,1);
  assert.equal(full.status,409);
  assert.equal((await full.json()).code,"portion_limit");
  assert.equal((await receipt()).pickupSlot,sameDay);
  assert.equal((await supply(tomorrow)).used,2);
  assert.equal((await supply(dayAfter)).used,0);

  assert.equal((await setSupply(dayAfter,2,1)).status,200);
  assert.deepEqual((await (await call(options+dayAfter,guest)).json()).shortages,[]);
  const competing=booking(start(dayAfter,"12:15"));
  const [moved,newBooking]=await Promise.all([move(sameDay,nextDay,1),submit(competing,0)]);
  assert.deepEqual([moved.status,newBooking.status].sort(),[200,409]);
  assert.equal((await (moved.ok?newBooking:moved).json()).code,"portion_limit");
  if(newBooking.ok){
    assert.equal((await write("/api/ticket/cancel",{},{"X-Ticket":competing.token})).status,200);
    assert.equal((await move(sameDay,nextDay,1)).status,200);
  }
  assert.equal((await receipt()).pickupSlot,nextDay);
  assert.equal((await (await submit(originals[index],index)).json()).id,accepted.id);
  assert.equal((await supply(tomorrow)).used,0);
  assert.equal((await supply(dayAfter)).used,2);
  assert.deepEqual(await prep(tomorrow),[]);
  assert.deepEqual(await prep(dayAfter),[accepted.id]);
  assert.equal((await write("/api/kitchen/status",{id:accepted.id,from:"pending",to:"preparing",pickupRevision:2},staff,"PATCH")).status,409);
  const calendar=await call("/api/ticket/calendar",guest);
  assert.equal(calendar.status,200);
  assert.match(await calendar.text(),/DTSTART:20261127T040000Z/);
});

test("D1 serializes date pauses with bookings and retains existing orders and slot presets",async t=>{
  const host=await pickupWorkerOrigin(t);
  const staff={Authorization:"Bearer fixture-staff"};
  const call=(path,headers={})=>fetch(host+path,{headers});
  const write=(path,body,headers={},method="POST")=>fetch(host+path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const date="2026-11-26",today="2026-11-25",other="2026-11-27";
  const start=Date.parse(date+"T12:00:00+08:00"),next=start+900_000;
  const setter="/api/kitchen/pickup-day",limits="/api/kitchen/pickup-slots";
  const setDay=(accepting,revision,day=date,headers=staff)=>write(setter,{date:day,accepting,revision},headers,"PATCH");
  const snapshot=async(day=date)=>(await (await call(limits+"?date="+day,staff)).json());
  const menu=async(day)=>(await (await call("/api/menu?date="+day)).json());
  const slots=async(day)=>(await (await call("/api/pickup-slots?date="+day)).json());
  const booking=(pickupSlot,fields={})=>({token:crypto.randomUUID(),mode:"pickup",pickupSlot,note:"",
    items:[{id:"sencha",qty:2}],expectedTotal:90,...fields});
  const guestOrder=order=>write("/api/orders",order);
  const staffOrder=order=>write("/api/kitchen/create-pickup",order,staff);
  assert.deepEqual((await snapshot()).intake,{accepting:true,revision:0,editable:true});
  assert.equal((await setDay(false,0,date,{})).status,403);
  assert.equal((await setDay(false,0,"2026-11-24")).status,409);
  assert.equal((await setDay("false",0)).status,400);
  assert.equal((await write(limits,{date,start,capacity:5,revision:0},staff,"PATCH")).status,200);
  const original=booking(start,{paymentMethod:"line_pay"});
  const saved=await guestOrder(original);
  assert.equal(saved.status,200);
  const originalId=(await saved.json()).id;
  const originalTicket={"X-Ticket":original.token};

  const concurrentBooking=booking(next);
  const [closed,racing]=await Promise.all([setDay(false,0),staffOrder(concurrentBooking)]);
  assert.equal(closed.status,200);
  assert.ok([200,409].includes(racing.status));
  if(!racing.ok)assert.equal((await racing.json()).code,"pickup_day_paused");
  assert.deepEqual(await slots(date),{slots:[],paused:true});
  assert.equal((await menu(date)).pickupPaused,true);
  assert.equal((await staffOrder(concurrentBooking)).status,racing.status);
  assert.equal((await (await staffOrder(booking(start))).json()).code,"pickup_day_paused");
  assert.equal((await (await guestOrder(booking(next))).json()).code,"pickup_day_paused");
  assert.equal((await guestOrder(original)).status,200);
  const closedDashboard=await snapshot();
  assert.deepEqual(closedDashboard.intake,{accepting:false,revision:1,editable:true});
  assert.deepEqual(closedDashboard.slots.find(slot=>slot.start===start),
    {start,end:next,capacity:5,used:2,remaining:0,revision:1,editable:true});
  assert.equal((await slots(other)).slots.length,36);

  const {attempt}=await (await write("/api/payments/start",{},originalTicket)).json();
  assert.equal((await write("/api/payments/demo",{ref:attempt.ref,outcome:"paid"},originalTicket)).status,200);
  assert.equal((await call("/api/ticket/calendar",originalTicket)).status,200);
  const incoming=booking(Date.parse(other+"T12:00:00+08:00"));
  const incomingReceipt=await (await guestOrder(incoming)).json();
  const fromAnotherDay=await write("/api/kitchen/pickup-reschedule",
    {id:incomingReceipt.id,from:incoming.pickupSlot,to:start,revision:0},staff,"PATCH");
  assert.equal(fromAnotherDay.status,409);
  assert.equal((await fromAnotherDay.json()).code,"pickup_day_paused");
  const {pickupSlot}=await (await call("/api/ticket",{"X-Ticket":incoming.token})).json();
  assert.equal(pickupSlot,incoming.pickupSlot);
  const prep=await (await call("/api/kitchen/prep?date="+date,staff)).json();
  assert.ok(prep.orders.some(order=>order.id===originalId));

  const reopen=await Promise.all([setDay(true,1),setDay(true,1)]);
  assert.deepEqual(reopen.map(response=>response.status).sort(),[200,409]);
  const reopened=await snapshot();
  assert.deepEqual(reopened.intake,{accepting:true,revision:2,editable:true});
  assert.equal(reopened.slots.find(slot=>slot.start===start).remaining,3);
  assert.equal((await slots(date)).slots.find(slot=>slot.start===start).remaining,3);
  assert.equal((await setDay(false,0,today)).status,200);
  assert.equal((await guestOrder(booking(null))).status,200);
  assert.equal((await staffOrder(booking(null))).status,200);
});

test("pickup slots reserve portions atomically, release expired payments and gate kitchen preparation",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const taipei=time=>Date.parse("2026-11-25T"+time+"+08:00");
  let now=taipei("10:45:00");
  const pickupSlot=taipei("12:00:00"),later=taipei("12:15:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff",TAPPAY_MODE:"demo"};
  const staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const send=(method,path,data,headers={})=>call(path,{method,headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const post=data=>send("POST","/api/orders",data);
  const order=(qty,fields={})=>({token:crypto.randomUUID(),mode:"pickup",note:"",items:[{id:"sencha",qty}],pickupSlot,...fields});
  const remaining=async()=>{
    const response=await call("/api/pickup-slots");
    assert.equal(response.status,200);
    const slot=(await response.json()).slots.find(slot=>slot.start===pickupSlot);
    assert.equal(slot.end,later);
    assert.deepEqual(Object.keys(slot).sort(),["end","remaining","start"]);
    return slot.remaining;
  };
  assert.equal(await remaining(),12);
  assert.equal((await post(order(1,{mode:"table",table:"A03"}))).status,400);
  assert.equal((await (await post(order(1,{pickupSlot:pickupSlot+1}))).json()).code,"pickup_slot_closed");
  const requests=[order(7),order(7)];
  const responses=await Promise.all(requests.map(post));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const won=responses.findIndex(response=>response.ok),accepted=await responses[won].json();
  assert.equal(accepted.pickupSlot,pickupSlot);
  assert.equal((await responses[1-won].json()).code,"pickup_slot_full");
  assert.equal(await remaining(),5);
  db.sqlite.exec("INSERT INTO daily_portion_limits(date,dish,capacity,revision) VALUES('2026-11-25','sencha',7,1)");
  assert.equal((await (await post(order(1,{pickupSlot:null}))).json()).code,"portion_limit");
  db.sqlite.exec("DELETE FROM daily_portion_limits");
  const unpaid=order(5,{paymentMethod:"line_pay"});
  assert.equal((await post(unpaid)).status,200);
  assert.equal(await remaining(),0);
  now=taipei("11:00:00");
  assert.equal(await remaining(),5);
  const expired=await (await call("/api/ticket?progress=1",{headers:{"X-Ticket":unpaid.token}})).json();
  assert.equal(expired.statusHistory.at(-1).actor,"payment_expiry");
  const cash=order(5);
  assert.equal((await post(cash)).status,200);
  assert.equal(await remaining(),0);
  assert.equal((await send("POST","/api/ticket/cancel",{},{"X-Ticket":cash.token})).status,200);
  assert.equal(await remaining(),5);

  const advance=(from,to)=>send("PATCH","/api/kitchen/status",{id:accepted.id,from,to},staff);
  const board=async()=> (await (await call("/api/kitchen",{headers:staff})).json()).find(row=>row.id===accepted.id);
  now=taipei("11:44:59");
  assert.equal((await (await post(requests[won])).json()).id,accepted.id);
  assert.equal((await post({...requests[won],pickupSlot:later})).status,409);
  assert.equal((await (await post(order(1))).json()).code,"pickup_slot_closed");
  assert.equal((await board()).pickupUpcoming,true);
  assert.equal((await board()).overdue,undefined);
  assert.equal((await advance("pending","preparing")).status,409);
  now=taipei("11:45:00");
  assert.equal((await board()).pickupUpcoming,undefined);
  assert.equal((await advance("pending","preparing")).status,200);
  const work=await (await call("/api/kitchen/station-work?station=bar",{headers:staff})).json();
  assert.equal(work.orders.find(row=>row.id===accepted.id).pickupSlot,pickupSlot);
  assert.equal((await advance("preparing","ready")).status,200);
  now=taipei("11:59:59");
  assert.equal((await board()).overdue,undefined);
  now=taipei("12:10:00");
  assert.deepEqual((await board()).overdue,{elapsedMs:600_000,overByMs:0});
  const handoff=await (await call("/api/kitchen/handoff?id="+accepted.id,{headers:staff})).json();
  assert.equal(handoff.pickupSlot,pickupSlot);
});
test("staff pickup rescheduling preserves receipt and payment and requires the new version to prepare",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const taipei=time=>Date.parse("2026-11-25T"+time+"+08:00");
  let now=taipei("10:45:00");
  const first=taipei("12:00:00"),next=taipei("12:15:00"),full=taipei("12:30:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff",TAPPAY_MODE:"demo"};
  const staff={Authorization:"Bearer fixture-staff"};
  const token=crypto.randomUUID(),guest={"X-Ticket":token};
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const send=(method,path,data,headers={})=>call(path,{method,headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const booking=(pickupSlot,qty,fields={})=>({token:crypto.randomUUID(),mode:"pickup",note:"",items:[{id:"sencha",qty}],pickupSlot,...fields});
  const post=data=>send("POST","/api/orders",data);
  const input=booking(first,4,{token,paymentMethod:"line_pay"});
  const original=await (await post(input)).json();
  const shift=(from,to,revision=0,headers=guest)=>send("POST","/api/ticket/reschedule",{from,to,revision},headers);
  const staffShift=(from,to,revision=0,headers=staff,id=original.id)=>
    send("PATCH","/api/kitchen/pickup-reschedule",{id,from,to,revision},headers);
  const ticket=async()=> (await call("/api/ticket?progress=1",{headers:guest})).json();
  const advance=pickupRevision=>send("PATCH","/api/kitchen/status",{id:original.id,from:"pending",to:"preparing",pickupRevision},staff);
  assert.equal(await (await ticket()).canReschedulePickup,true);
  assert.equal((await shift(first,next,0,{})).status,404);
  assert.equal((await shift(first,next,0,{"X-Ticket":crypto.randomUUID()})).status,404);
  assert.equal((await staffShift(first,next,0,guest)).status,403);
  assert.equal((await staffShift(first,next,0,staff,"1")).status,400);
  assert.equal((await staffShift(first,next,0,staff,999)).status,404);
  const {attempt}=await (await send("POST","/api/payments/start",{},guest)).json();
  assert.equal((await send("POST","/api/payments/demo",{ref:attempt.ref,outcome:"paid"},guest)).status,200);
  const paid=await ticket();
  assert.equal((await post(booking(full,9))).status,200);
  const blocked=await staffShift(first,full);
  assert.equal(blocked.status,409);
  assert.equal((await blocked.json()).code,"pickup_slot_full");
  assert.deepEqual(await ticket(),paid);
  const newTime=await (await staffShift(first,next)).json();
  assert.deepEqual(newTime,{pickupSlot:next,pickupChanges:[{from:first,to:next,at:now,actor:"staff"}],canReschedulePickup:true});
  assert.deepEqual(await ticket(),{...paid,...newTime});
  const payment=await (await send("POST","/api/payments/check",{},guest)).json();
  assert.equal(payment.attempt.ref,attempt.ref);
  assert.equal(payment.attempt.state,"paid");

  now=taipei("12:00:00");
  assert.equal((await ticket()).canReschedulePickup,false);
  assert.equal((await shift(next,taipei("13:00:00"),1)).status,409);
  assert.equal((await staffShift(next,taipei("13:00:00"),1)).status,409);
  assert.equal((await advance(0)).status,409);
  assert.equal((await advance()).status,409);
  const board=await (await call("/api/kitchen",{headers:staff})).json();
  const card=board.find(row=>row.id===original.id);
  assert.equal(card.pickupRevision,1);
  assert.deepEqual(card.latestPickupChange,newTime.pickupChanges[0]);
  assert.equal((await advance(1)).status,200);
  assert.equal((await ticket()).status,"preparing");
  assert.deepEqual(await (await shift(first,next)).json(),{...newTime,canReschedulePickup:false});
  assert.deepEqual(await (await staffShift(first,next)).json(),{...newTime,canReschedulePickup:false});
});
test("staff reservations share slot capacity, survive a lost response and keep the kitchen lead time",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const day="2026-11-25",time=value=>Date.parse(day+"T"+value+"+08:00");
  let now=time("10:45:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff",TAPPAY_MODE:"demo"};
  const staff={Authorization:"Bearer fixture-staff"},endpoint="/api/kitchen/create-pickup";
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const write=(path,body,headers={},method="POST")=>call(path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const order=pickupSlot=>({token:crypto.randomUUID(),mode:"pickup",pickupSlot,note:"",
    items:[{id:"sencha",qty:1}],expectedTotal:45});
  const prepare=id=>write("/api/kitchen/status",{id,from:"pending",to:"preparing"},staff,"PATCH");
  const capacity=(start,limit,revision)=>write("/api/kitchen/pickup-slots",{date:day,start,capacity:limit,revision},staff,"PATCH");
  const toggle=(accepting,revision)=>write("/api/kitchen/intake",{mode:"pickup",accepting,revision},staff,"PATCH");
  const remaining=async start=>(await (await call("/api/pickup-slots")).json()).slots.find(slot=>slot.start===start).remaining;
  const first=time("12:00:00"),second=time("12:15:00");
  assert.equal((await capacity(first,1,0)).status,200);
  assert.equal((await write(endpoint,order(first))).status,403);
  assert.equal(await remaining(first),1);

  const channels=[{path:endpoint,headers:staff},{path:"/api/orders",headers:{}}];
  const racing=channels.map(()=>order(first));
  const responses=await Promise.all(channels.map(({path,headers},index)=>write(path,racing[index],headers)));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  assert.equal((await responses.find(response=>!response.ok).json()).code,"pickup_slot_full");
  assert.equal(await remaining(first),0);

  assert.equal((await toggle(false,0)).status,200);
  assert.equal((await capacity(second,1,0)).status,200);
  const booking={...order(second),mode:"table",table:"A01",paymentMethod:"line_pay"};
  assert.equal((await write("/api/orders",order(second))).status,409);
  const response=await write(endpoint,booking,staff);
  assert.equal(response.status,200);
  const accepted=await response.json();
  assert.equal(accepted.source,"staff");
  assert.equal(accepted.mode,"pickup");
  assert.equal(accepted.paymentMethod,"cash");
  assert.equal(accepted.pickupSlot,second);
  assert.equal(await remaining(second),0);
  assert.equal((await prepare(accepted.id)).status,409);
  assert.equal((await capacity(second,0,1)).status,200);
  assert.equal((await (await write(endpoint,order(second),staff)).json()).code,"pickup_slot_full");
  assert.equal((await write(endpoint,{...booking,pickupSlot:first},staff)).status,409);

  now=time("12:00:00");
  assert.deepEqual(await (await write(endpoint,booking,staff)).json(),accepted);
  const calendar=await call("/api/ticket/calendar",{headers:{"X-Ticket":booking.token}});
  assert.equal(calendar.status,200);
  assert.match(await calendar.text(),/DTSTART:20261125T041500Z/);
  assert.equal((await prepare(accepted.id)).status,200);
});

test("D1 records cash once, returns the original result on replay and protects the other payment methods",async t=>{
  const host=await pickupWorkerOrigin(t);
  const staff={Authorization:"Bearer fixture-staff"},cashEndpoint="/api/kitchen/cash-receipt";
  const write=(path,body,headers={},method="POST")=>fetch(host+path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const makeOrder=async(method="cash")=>{
    const token=crypto.randomUUID();
    const response=await write("/api/orders",{token,mode:"pickup",note:"",paymentMethod:method,items:[{id:"sencha",qty:1}]});
    assert.equal(response.status,200);
    return {id:(await response.json()).id,token};
  };
  const move=(id,from,to)=>write("/api/kitchen/status",{id,from,to},staff,"PATCH");
  const collect=(params,headers=staff)=>write(cashEndpoint,params,headers);
  const receipt=async token=>await (await fetch(host+"/api/ticket",{headers:{"X-Ticket":token}})).json();
  const {id,token}=await makeOrder();
  const base={id,expectedTotal:45,tendered:100,operationId:crypto.randomUUID()};
  assert.equal((await collect(base,{})).status,403);
  assert.equal((await collect({...base,id:0})).status,400);
  assert.equal((await collect({...base,tendered:44})).status,400);
  assert.equal((await collect({...base,tendered:50.25})).status,400);
  assert.equal((await collect({...base,tendered:Number.MAX_SAFE_INTEGER+1})).status,400);
  assert.equal((await collect(base)).status,409);
  assert.equal((await move(id,"pending","preparing")).status,200);
  assert.equal((await move(id,"preparing","ready")).status,200);
  assert.equal((await collect({...base,expectedTotal:40})).status,409);
  const attempts=[base,{...base,tendered:200,operationId:crypto.randomUUID()}];
  const results=await Promise.all(attempts.map(params=>collect(params)));
  assert.deepEqual(results.map(result=>result.status).sort(),[200,409]);
  const winner=results.findIndex(result=>result.ok),saved=await results[winner].json();
  assert.deepEqual(saved,{id,cashReceipt:{amount:45,tendered:attempts[winner].tendered,change:attempts[winner].tendered-45,
    collectedAt:Date.parse("2026-11-25T10:45:00+08:00")}});
  assert.equal((await collect({...attempts[winner],operationId:crypto.randomUUID()})).status,409);
  assert.equal((await collect({...attempts[winner],tendered:1000})).status,409);
  assert.equal((await move(id,"ready","completed")).status,200);
  assert.deepEqual(await (await collect(attempts[winner])).json(),saved);
  const original=await receipt(token);
  assert.equal(original.status,"completed");
  assert.deepEqual(original.cashReceipt,saved.cashReceipt);
  assert.ok(!JSON.stringify(original).includes(attempts[winner].operationId));

  const second=await makeOrder();
  assert.equal((await move(second.id,"pending","preparing")).status,200);
  assert.equal((await move(second.id,"preparing","ready")).status,200);
  assert.equal((await move(second.id,"ready","completed")).status,200);
  assert.equal((await receipt(second.token)).cashReceipt,undefined);
  assert.equal((await collect({...attempts[winner],id:second.id})).status,409);
  const exact=await (await collect({...base,id:second.id,operationId:crypto.randomUUID(),tendered:45})).json();
  assert.equal(exact.cashReceipt.change,0);
  const online=await makeOrder("line_pay");
  const guest={"X-Ticket":online.token};
  const {attempt}=await (await write("/api/payments/start",{},guest)).json();
  assert.equal((await write("/api/payments/demo",{ref:attempt.ref,outcome:"paid"},guest)).status,200);
  assert.equal((await move(online.id,"pending","preparing")).status,200);
  assert.equal((await move(online.id,"preparing","ready")).status,200);
  assert.equal((await collect({...base,id:online.id,operationId:crypto.randomUUID()})).status,409);
  assert.equal((await receipt(online.token)).cashReceipt,undefined);
});

test("customer order details are scoped to the receipt and reflect committed money and expiry",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const now=Date.parse("2026-11-25T12:02:00+08:00");
  t.mock.method(Date,"now",()=>now);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api"+path,options),env);
  const write=(path,input,method="POST")=>call(path,{method,body:JSON.stringify(input),
    headers:{...staff,"Content-Type":"application/json"}});
  const details=(token)=>call("/ticket/order-details",token?{headers:{"X-Ticket":token}}:undefined);
  const introduce=db.sqlite.prepare(`INSERT INTO orders(token,mode,table_no,items,note,total,status,created,pickup_slot,
    payment_method,payment_env,payment_due_at,combo_quote) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const add=({table=null,status="ready",method="cash",environment="cash",deadline=null,total=90,slot=null,combo=null}={})=>{
    const token=crypto.randomUUID(),items=[{id:"sencha",name:"日式熱煎茶",qty:2,price:45,note:"private line note"}];
    const id=Number(introduce.run(token,table?"table":"pickup",table,JSON.stringify(items),"private order note",
      total,status,now-600_000,slot,method,environment,deadline,combo&&JSON.stringify(combo)).lastInsertRowid);
    return {id,token};
  };
  const slot=Date.parse("2026-11-25T12:00:00+08:00"),cash=add({slot});
  const receiptNo=String(cash.id).padStart(4,"0");
  for(const unauthorized of [undefined,"malformed",crypto.randomUUID()])assert.equal((await details(unauthorized)).status,404);
  assert.equal((await call("/ticket/order-details?token="+cash.token)).status,404);
  assert.equal((await call("/ticket/order-details",{headers:{"X-Pickup-Pass":cash.token}})).status,404);
  const before=await details(cash.token);
  assert.equal(before.headers.get("Content-Disposition"),`attachment; filename="hey-table-order-${receiptNo}.txt"`);
  assert.equal(before.headers.get("Cache-Control"),"private, no-store");
  assert.equal(before.headers.get("Content-Type"),"text/plain; charset=utf-8");
  assert.match(await before.text(),/付款狀態 未登記現金收款/);
  const operationId=crypto.randomUUID();
  assert.equal((await write("/kitchen/cash-receipt",{id:cash.id,operationId,expectedTotal:90,tendered:100})).status,200);
  assert.equal((await write("/kitchen/cash-corrections",{id:cash.id,revision:0,operationId:crypto.randomUUID(),
    tendered:120,reason:"private correction reason"})).status,200);
  const bytes=Buffer.from(await (await details(cash.token)).arrayBuffer());
  assert.equal(bytes.subarray(0,3).toString("hex"),"efbbbf");
  const text=bytes.toString("utf8");
  for(const line of [`取餐號碼 ${receiptNo}`,"預約取餐 11/25 12:00～12:15","日式熱煎茶 × 2 · 單價 NT$ 45 · 小計 NT$ 90",
    "付款狀態 已登記現金收款","原餐單金額 NT$ 90","現金實收 NT$ 120 · 找零 NT$ 30"])
    assert.ok(text.includes(line+"\r\n"),line);
  for(const excluded of [cash.token,operationId,"private order note","private line note","private correction reason","現金實收 NT$ 100"])
    assert.ok(!text.includes(excluded));

  const unpaid=add({status:"pending",method:"line_pay",environment:"demo",deadline:now});
  const expired=await (await details(unpaid.token)).text();
  assert.match(expired,/餐單狀態 已取消/);
  assert.match(expired,/付款狀態 待付款/);
  const online=add({table:"A03",method:"px_pay_plus",environment:"demo",total:80,combo:{quote:{subtotal:90,discount:10}}});
  db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,created)
    VALUES (?,'private-ref','fixture','paid',?)`).run(online.id,now-1000);
  const paid=await (await details(online.token)).text();
  for(const line of ["用餐方式 A03 桌內用","付款方式 全支付","付款狀態 已付款","餐點原價 NT$ 90","套餐折抵 NT$ 10","原餐單金額 NT$ 80"])
    assert.ok(paid.includes(line+"\r\n"),line);
  assert.equal((await write("/kitchen/demo-refund",{id:online.id,expectedStatus:"ready",expectedTotal:80},"PATCH")).status,200);
  const refunded=await (await details(online.token)).text();
  assert.match(refunded,/付款狀態 已退款/);
  assert.match(refunded,/示範退款金額 NT\$ 80/);
  assert.match(refunded,/退款時間（台灣） /);
  assert.ok(!refunded.includes("private-ref")&&!refunded.includes(online.token));
});

test("cash close uses Taipei registration dates and returns exact totals from the same ledger rows",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const start=Date.parse("2026-11-25T00:00:00+08:00"),end=start+86_400_000;
  t.mock.method(Date,"now",()=>end);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const get=(query,headers=staff)=>api(new Request("https://order.example/api/kitchen/cash-close"+query,{headers}),runtime);
  const order=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status)
    VALUES (?,?,'private order detail','[]',1,?,'completed')`);
  const insert=db.sqlite.prepare("INSERT INTO cash_receipts(order_id,operation_id,amount,tendered,collected_at) VALUES (?,?,?,?,?)");
  const log=(mode,amount,tendered,at)=>{
    const {lastInsertRowid:id}=order.run(crypto.randomUUID(),mode,start-180_000);
    insert.run(id,"private-operation-"+id,amount,tendered,at);
    return id;
  };
  const large=Number.MAX_SAFE_INTEGER;
  log("pickup",1,2,start-1);
  const first=log("pickup",45,large,start),second=log("table",55,large,start);
  const last=log("table",90,90,end-1),next=log("pickup",3,3,end);
  log("pickup",4,5,end+1);
  order.run(crypto.randomUUID(),"pickup",start);
  assert.equal((await get("?date=2026-11-25",{})).status,403);
  for(const query of ["","?date=2026-02-30","?date=2026-11-25&date=2026-11-26"]){
    assert.equal((await get(query)).status,400);
  }
  const response=await get("?date=2026-11-25");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("private"));
  const report=JSON.parse(raw);
  assert.deepEqual(report,{
    format:"hey-table.daily-cash.v1",date:"2026-11-25",timeZone:"Asia/Taipei",capturedAt:end,
    totals:{receipts:3,net:"190",tendered:String(2n*BigInt(large)+90n),change:String(2n*BigInt(large)-100n)},
    receipts:[
      {orderId:first,mode:"pickup",amount:45,tendered:large,change:large-45,recordedAt:start},
      {orderId:second,mode:"table",amount:55,tendered:large,change:large-55,recordedAt:start},
      {orderId:last,mode:"table",amount:90,tendered:90,change:0,recordedAt:end-1},
    ],
  });
  const nextReport=await (await get("?date=2026-11-26")).json();
  assert.deepEqual(nextReport.receipts,[{orderId:next,mode:"pickup",amount:3,tendered:3,change:0,recordedAt:end}]);
  const empty=await (await get("?date=2026-11-29")).json();
  assert.deepEqual(empty.totals,{receipts:0,net:"0",tendered:"0",change:"0"});
  assert.deepEqual(empty.receipts,[]);
});

test("cash activity distinguishes cross-day collection, known post-handoff registration and current-day corrections",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const day="2026-11-25",start=Date.parse(day+"T00:00:00+08:00"),end=start+86_400_000;
  t.mock.method(Date,"now",()=>end-10);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const order=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status,status_history)
    VALUES (?,'pickup','private-order-note','[]',45,?,?,?)`);
  const cash=db.sqlite.prepare("INSERT INTO cash_receipts(order_id,operation_id,amount,tendered,collected_at) VALUES (?,?,45,100,?)");
  const add=(created,recordedAt,history,status="completed")=>{
    const id=Number(order.run(crypto.randomUUID(),created,status,history).lastInsertRowid);
    cash.run(id,"private-cash-"+id,recordedAt);
    return id;
  };
  const transitions=at=>JSON.stringify([false,"legacy",[1],{from:"ready",status:"completed",at}]);
  const previous=add(start-6000,start-1000,transitions(start-2000));
  const missing=add(start-3000,start,null);
  const late=add(start-3000,start,transitions(start-10));
  const booked=add(start-3000,start+1000,transitions(start+2000));
  const sameTime=add(start,start+1000,transitions(start+1000));
  const invalid=add(start,start+2000,'["not a transition"]');
  const ready=add(start,start+2500,transitions(start+2000),"ready");
  const addCorrection=db.sqlite.prepare(`INSERT INTO cash_receipt_corrections
    (order_id,revision,operation_id,previous_tendered,tendered,reason,corrected_at) VALUES (?,?,?,?,?,'private-correction-reason',?)`);
  addCorrection.run(previous,1,"private-old",100,90,start-5);
  addCorrection.run(previous,2,"private-start",90,80,start);
  addCorrection.run(previous,3,"private-mid",80,70,end-10);
  addCorrection.run(previous,4,"private-future",70,60,end-9);
  addCorrection.run(previous,5,"private-next",60,50,end);
  addCorrection.run(late,1,"private-current",100,60,start);
  const get=(date,scope="&activity=1",headers=staff)=>api(new Request("https://order.example/api/kitchen/cash-close?date="+date+scope,{headers}),env);
  assert.equal((await get(day,"&activity=1",{})).status,403);
  const response=await get(day);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("private"));
  const report=JSON.parse(raw);
  assert.deepEqual(report.activity,{earlierOrders:3,afterHandoff:1,corrections:[
    {orderId:previous,revision:2,previousTendered:90,tendered:80,correctedAt:start,recordedAt:start-1000,recordedDate:"2026-11-24"},
    {orderId:late,revision:1,previousTendered:100,tendered:60,correctedAt:start,recordedAt:start,recordedDate:day},
    {orderId:previous,revision:3,previousTendered:80,tendered:70,correctedAt:end-10,recordedAt:start-1000,recordedDate:"2026-11-24"},
  ]});
  assert.deepEqual(report.receipts.map(row=>[row.orderId,row.orderDate,row.completedAt]),
    [[missing,"2026-11-24",undefined],[late,"2026-11-24",start-10],[booked,"2026-11-24",undefined],
      [sameTime,day,undefined],[invalid,day,undefined],[ready,day,undefined]]);
  assert.deepEqual(report.totals,{receipts:6,net:"270",tendered:"560",change:"290"});
  const original=await (await get("2026-11-24")).json();
  assert.equal(original.receipts[0].tendered,70);
  assert.equal(original.activity.corrections.length,1);
  const unchanged=await (await get(day,"")).json();
  assert.equal(unchanged.activity,undefined);
  assert.ok(unchanged.receipts.every(row=>row.orderDate===undefined&&row.completedAt===undefined));
  assert.deepEqual(unchanged.totals,report.totals);
});

test("D1 saves immutable cash close versions, rejects stale receipts and replays a committed operation",async t=>{
  const host=await pickupWorkerOrigin(t);
  const staff={Authorization:"Bearer fixture-staff"},date="2026-11-25";
  const endpoint="/api/kitchen/cash-close-versions",query="?date="+date;
  const call=(path,headers=staff)=>fetch(host+path,{headers});
  const write=(path,body,headers=staff,method="POST")=>fetch(host+path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const capture=async()=>await (await call("/api/kitchen/cash-close"+query)).json();
  const collect=async()=>{
    const created=await write("/api/orders",{token:crypto.randomUUID(),mode:"pickup",note:"",items:[{id:"sencha",qty:1}]},{});
    assert.equal(created.status,200);
    const {id}=await created.json();
    assert.equal((await write("/api/kitchen/status",{id,from:"pending",to:"preparing"},staff,"PATCH")).status,200);
    assert.equal((await write("/api/kitchen/status",{id,from:"preparing",to:"ready"},staff,"PATCH")).status,200);
    assert.equal((await write("/api/kitchen/cash-receipt",{id,operationId:crypto.randomUUID(),expectedTotal:45,tendered:100})).status,200);
  };
  const input=(report,revision,counted)=>({date,revision,operationId:crypto.randomUUID(),capturedAt:report.capturedAt,
    receiptCount:report.totals.receipts,opening:"200",adjustments:"-20",counted});
  const empty=await capture(),stale=input(empty,0,"180");
  assert.equal((await call(endpoint+query,{})).status,403);
  assert.equal((await write(endpoint,stale,{})).status,403);
  assert.equal((await write(endpoint,{...stale,counted:"-1"})).status,400);
  assert.equal((await write(endpoint,{...stale,date:"2026-11-26"})).status,400);
  assert.equal((await call(endpoint+query+"&revision=0")).status,400);
  assert.equal((await call(endpoint+query+"&revision=1")).status,404);
  await collect();
  assert.equal((await write(endpoint,stale)).status,409);
  const live=await capture();
  const attempts=[input(live,0,"221"),input(live,0,"222")];
  const responses=await Promise.all(attempts.map(attempt=>write(endpoint,attempt)));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const winner=responses.findIndex(response=>response.ok),saved=await responses[winner].json();
  assert.equal(saved.revision,1);
  assert.deepEqual(saved.report.receipts,live.receipts);
  assert.equal(saved.report.reconciliation.expected,"225");
  assert.equal(saved.report.reconciliation.counted,attempts[winner].counted);
  assert.ok(!JSON.stringify(saved).includes(attempts[winner].operationId));
  await collect();
  assert.equal((await write(endpoint,input(live,1,"270"))).status,409);
  const correction=await (await write(endpoint,input(await capture(),1,"270"))).json();
  assert.equal(correction.revision,2);
  assert.equal(correction.report.reconciliation.difference,"0");
  assert.equal(correction.report.receipts.length,2);
  assert.deepEqual(await (await write(endpoint,attempts[winner])).json(),saved);
  assert.equal((await write(endpoint,{...attempts[winner],counted:"225"})).status,409);
  assert.deepEqual(await (await call(endpoint+query+"&revision=1")).json(),saved);
  const history=await (await call(endpoint+query)).json();
  assert.deepEqual(history.versions.map(version=>[version.revision,version.receipts]),[[2,2],[1,1]]);
});

test("cash corrections preserve net and old close versions and reject concurrently edited receipts",async t=>{
  const host=await pickupWorkerOrigin(t);
  const staff={Authorization:"Bearer fixture-staff"},token=crypto.randomUUID(),ticket={"X-Ticket":token};
  const date="2026-11-25",query="?date="+date,corrections="/api/kitchen/cash-corrections",versions="/api/kitchen/cash-close-versions";
  const call=(path,headers=staff)=>fetch(host+path,{headers});
  const write=(path,body,headers=staff,method="POST")=>fetch(host+path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const captured=async()=>await (await call("/api/kitchen/cash-close"+query)).json();
  const order=await (await write("/api/orders",{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}]},{})).json();
  const id=order.id;
  const advance=(from,to)=>write("/api/kitchen/status",{id,from,to},staff,"PATCH");
  assert.equal((await advance("pending","preparing")).status,200);
  assert.equal((await advance("preparing","ready")).status,200);
  const collect={id,operationId:crypto.randomUUID(),expectedTotal:45,tendered:100};
  const original=await (await write("/api/kitchen/cash-receipt",collect)).json();
  assert.equal(original.cashReceipt.change,55);
  const before=await captured();
  const close=(report,revision)=>({date,revision,operationId:crypto.randomUUID(),capturedAt:report.capturedAt,
    receiptCount:report.totals.receipts,correctionCount:report.correctionCount??0,opening:"20",adjustments:"0",counted:"65"});
  const frozen=await (await write(versions,close(before,0))).json();
  const correct=(tendered,revision=0)=>({id,tendered,revision,operationId:crypto.randomUUID(),reason:"覆核實收金額"});
  assert.equal((await write(corrections,correct(50),{})).status,403);
  assert.equal((await call(corrections+"?id="+id,{})).status,403);
  assert.equal((await write(corrections,{...correct(50),reason:" "})).status,400);
  assert.equal((await write(corrections,correct(40))).status,400);
  assert.equal((await write(corrections,correct(100))).status,409);
  assert.equal((await advance("ready","completed")).status,200);
  const attempts=[correct(50),correct(200)];
  const responses=await Promise.all(attempts.map(input=>write(corrections,input)));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,409]);
  const winner=responses.findIndex(response=>response.ok),first=await responses[winner].json();
  assert.equal(first.cashReceipt.revision,1);
  assert.equal(first.cashReceipt.tendered,attempts[winner].tendered);
  const second=await (await write(corrections,correct(150,1))).json();
  assert.equal(second.cashReceipt.change,105);
  assert.deepEqual(await (await write(corrections,attempts[winner])).json(),first);
  assert.deepEqual(await (await write("/api/kitchen/cash-receipt",collect)).json(),original);
  const reader=await (await call("/api/ticket",ticket)).text();
  assert.ok(!reader.includes("覆核實收金額"));
  assert.deepEqual(JSON.parse(reader).cashReceipt,second.cashReceipt);
  const history=await (await call(corrections+"?id="+id)).json();
  assert.deepEqual(history.corrections.map(row=>[row.revision,row.previousTendered,row.tendered,row.reason]),
    [[2,first.cashReceipt.tendered,150,"覆核實收金額"],[1,100,first.cashReceipt.tendered,"覆核實收金額"]]);
  assert.equal((await write(versions,close(before,1))).status,409);
  const latest=await captured();
  assert.equal(latest.correctionCount,2);
  assert.deepEqual(latest.totals,{receipts:1,net:"45",tendered:"150",change:"105"});
  assert.equal(latest.receipts[0].correctionRevision,2);
  assert.equal((await write(versions,close(latest,1))).status,200);
  assert.deepEqual(await (await call(versions+query+"&revision=1")).json(),frozen);
  assert.equal(frozen.report.totals.tendered,"100");
});

test("staff pickup roster groups one Taipei day and excludes private receipt and payment fields",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",now=Date.parse(date+"T10:45:00+08:00");
  const first=Date.parse(date+"T11:30:00+08:00"),later=first+900_000;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,headers={})=>api(new Request("https://order.example"+path,{headers}),runtime);
  const endpoint="/api/kitchen/pickup-roster";
  const add=db.sqlite.prepare(`INSERT INTO orders(token,mode,source,pickup_slot,note,items,total,created,status,payment_method,payment_due_at)
    VALUES (?,?,?,?, 'private kitchen note', ?,90,?,?,?,?)`);
  const insert=({slot,source=null,method="cash",mode="pickup",status="pending",due=null})=>
    add.run(crypto.randomUUID(),mode,source,slot,JSON.stringify([{id:"sencha",qty:2,note:"private item note"}]),now-900_000,status,method,due).lastInsertRowid;
  const late=insert({slot:later,source:"staff"});
  db.sqlite.prepare("INSERT INTO cash_receipts(order_id,operation_id,amount,tendered,collected_at) VALUES (?,'private operation',90,100,?)").run(late,now-1000);
  const paid=insert({slot:first,method:"px_pay_plus",status:"ready"});
  const expired=insert({slot:first,method:"line_pay",due:now-1});
  const immediate=insert({slot:null});
  const table=insert({slot:first,mode:"table"});
  insert({slot:Date.parse("2026-11-24T23:59:59.999+08:00")});
  insert({slot:Date.parse("2026-11-26T00:00:00+08:00")});
  const attempt=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?, 'private merchant', ?,?)");
  attempt.run(paid,"earlier-private-ref","pending",now-2000);
  attempt.run(paid,"latest-private-ref","paid",now-1000);
  db.sqlite.prepare("INSERT INTO pickup_day_intake(date,accepting,revision) VALUES (?,0,1)").run(date);
  const detail="/api/kitchen/pickup-booking?id=";
  assert.equal((await call(detail+late)).status,403);
  assert.equal((await call(detail+"0",staff)).status,400);
  for(const id of [immediate,table,99_999])assert.equal((await call(detail+id,staff)).status,404);
  const readBooking=await call(detail+String(late).padStart(4,"0"),staff);
  assert.equal(readBooking.headers.get("Cache-Control"),"no-store");
  const booking=await readBooking.json();
  assert.equal(booking.pickupUpcoming,true);
  assert.equal(booking.pickupRevision,0);
  assert.equal(booking.pickupSlot,later);
  const expiredBooking=await (await call(detail+expired,staff)).json();
  assert.equal(expiredBooking.status,"cancelled");
  assert.ok(!Object.hasOwn(expiredBooking,"pickupUpcoming"));
  const board=await (await call("/api/kitchen",staff)).json();
  assert.deepEqual(booking,board.find(order=>order.id===late));
  assert.equal((await call(endpoint)).status,403);
  assert.equal((await call(endpoint+"?date=2026-02-30",staff)).status,400);
  const response=await call(endpoint,staff);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("private"));
  assert.deepEqual(JSON.parse(raw),{
    date,capturedAt:now,accepting:false,totals:{bookings:2,portions:4,cancelled:1},windows:[
      {start:first,portions:2,orders:[
        {id:paid,source:"online",status:"ready",paymentMethod:"px_pay_plus",paymentState:"paid",portions:2},
        {id:expired,source:"online",status:"cancelled",paymentMethod:"line_pay",paymentState:"unpaid",portions:2},
      ]},
      {start:later,portions:2,orders:[
        {id:late,source:"staff",status:"pending",paymentMethod:"cash",paymentState:"unpaid",portions:2,cashCollected:true},
      ]},
    ],
  });
  assert.deepEqual((await (await call(endpoint+"?date=2026-11-27",staff)).json()).windows,[]);
  const selected=endpoint+"?date="+date+"&slot="+first;
  assert.equal((await call(selected)).status,403);
  const filtered=await call(selected,staff);
  assert.equal(filtered.status,200);
  assert.equal(filtered.headers.get("Cache-Control"),"no-store");
  const day=JSON.parse(raw);
  assert.deepEqual(await filtered.json(),{...day,totals:{bookings:1,portions:2,cancelled:1},windows:[day.windows[0]]});
  assert.deepEqual(await (await call(endpoint+"?date="+date+"&slot="+(later+900_000),staff)).json(),
    {...day,totals:{bookings:0,portions:0,cancelled:0},windows:[]});
  for(const slot of ["",first+1,first+86_400_000,"NaN"]){
    assert.equal((await call(endpoint+"?date="+date+"&slot="+slot,staff)).status,400);
  }
});

test("daily payment summary groups delivered orders by stored method and environment",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",start=Date.parse(date+"T00:00:00+08:00"),end=start+86_400_000;
  t.mock.method(Date,"now",()=>end+60_000);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(query="",headers=staff)=>api(new Request("https://order.example/api/kitchen/daily?date="+date+query,{headers}),env);
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created,payment_method,payment_env)
    VALUES (?,?,?,'[]','private receipt note',?,?,?,?)`);
  const add=({method="cash",environment="cash",created=start,mode="pickup",status="completed",total=45}={})=>
    Number(insert.run(crypto.randomUUID(),mode,status,total,created,method,environment).lastInsertRowid);
  const pay=db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,created)
    VALUES (?,?,'private merchant',?,?)`);
  const cash=add(),missing=add({mode:"table",total:90});
  db.sqlite.prepare("INSERT INTO cash_receipts(order_id,operation_id,amount,tendered,collected_at) VALUES (?,?,?,?,?)")
    .run(cash,crypto.randomUUID(),45,50,end+1000);
  const wallet=(method,environment,options={})=>add({method,environment,...options});
  const production=wallet("line_pay","production"),authorization=wallet("line_pay","production",{total:90,created:end-1});
  const demo=wallet("line_pay","demo"),refunded=wallet("px_pay_plus","demo");
  const unrecorded=wallet("card","sandbox");
  const legacy=wallet("line_pay","obsolete");
  const cancelled=wallet("line_pay","production",{status:"cancelled"});
  const ready=wallet("line_pay","production",{status:"ready"});
  for(const [id,states] of [[production,["pending","paid"]],[authorization,["failed","authorized"]],
    [demo,["paid"]],[refunded,["paid","refunded"]],[legacy,["paid"]],[cancelled,["paid"]],[ready,["paid"]]]){
    for(const state of states)pay.run(id,`private-${id}-${state}`,state,start+1000);
  }
  add({created:start-1,total:999});
  add({created:end,total:999});
  assert.equal((await call("&paymentSummary=1",{})).status,403);
  assert.equal(Object.hasOwn(await (await call("&timing=1&pickupPunctuality=1")).json(),"paymentSummary"),false);
  const response=await call("&timing=1&pickupPunctuality=1&paymentSummary=1");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("private"));
  const report=JSON.parse(raw);
  assert.deepEqual(report.pickupPunctuality.windows,[]);
  const {completed,needsReview,groups}=report.paymentSummary;
  assert.equal(completed,8);
  assert.equal(needsReview,4);
  const byKey=new Map(groups.map(group=>[group.method+":"+group.environment,group]));
  const check=(method,environment,completedTotal,statuses,review=[])=>{
    const orders=Object.values(statuses).reduce((sum,count)=>sum+count,0);
    assert.deepEqual(byKey.get(method+":"+environment),{method,environment,completedTotal,statuses,review,orders});
  };
  check("cash","cash","135",{cashRecorded:1,cashMissing:1},[{id:missing,state:"cashMissing"}]);
  check("line_pay","production","135",{paid:1,authorized:1},[{id:authorization,state:"authorized"}]);
  check("line_pay","demo","45",{paid:1});
  check("px_pay_plus","demo","45",{refunded:1});
  check("card","sandbox","45",{unpaid:1},[{id:unrecorded,state:"unpaid"}]);
  check("line_pay","unknown","45",{paid:1},[{id:legacy,state:"paid"}]);
  assert.equal(groups.reduce((sum,group)=>sum+Number(group.completedTotal),0),
    report.channels.pickup.completedTotal+report.channels.table.completedTotal);
});

test("staff payment review resolves old completed orders by Taipei creation date without exposing payment references",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const day="2024-02-29",start=Date.parse(day+"T00:00:00+08:00"),token=crypto.randomUUID();
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created,payment_method,payment_env)
    VALUES (?,'pickup',?,'[]','',45,?,?,?)`);
  const add=(created,status="completed",method="cash",environment="cash",proof=crypto.randomUUID())=>
    Number(insert.run(proof,status,created,method,environment).lastInsertRowid);
  const online=add(start,"completed","line_pay","sandbox",token);
  const cash=add(start+86_400_000-1);
  const ready=add(start,"ready"),tomorrow=add(start+86_400_000);
  for(let i=0;i<21;i++)add(start+86_400_000+i);
  const pay=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,'internal-merchant',?,?)");
  pay.run(online,"previous-attempt","paid",start);
  pay.run(online,"latest-attempt","authorized",start);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,headers=staff,options={})=>api(new Request("https://order.example/api/kitchen"+path,{headers,...options}),env);
  const review=(id,date=day,headers=staff)=>call("/payment-review?id="+id+"&date="+date,headers);
  assert.equal((await review(online,day,{})).status,403);
  for(const params of ["","?id=1e3&date="+day,"?id=1&id=2&date="+day,"?id=1&date="+day+"&date="+day,"?id=1&date=2023-02-29"])
    assert.equal((await call("/payment-review"+params)).status,400);
  for(const id of [ready,tomorrow,10000])assert.equal((await review(id)).status,404);
  assert.equal((await review(online,"2024-02-28")).status,404);
  const queue=await (await call("")).json();
  assert.ok(queue.every(order=>order.id!==online&&order.id!==cash));
  const response=await review("000"+online);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("cache-control"),"no-store");
  const raw=await response.text();
  assert.ok([token,"previous-attempt","latest-attempt","internal-merchant"].every(value=>!raw.includes(value)));
  const {id,paymentMethod,paymentEnv,paymentState,total}=JSON.parse(raw);
  assert.deepEqual({id,paymentMethod,paymentEnv,paymentState,total},{id:online,paymentMethod:"line_pay",paymentEnv:"sandbox",paymentState:"authorized",total:45});
  const original=await (await review(cash)).json();
  assert.equal(original.cashReceipt,undefined);
  const receipt=await call("/cash-receipt",{...staff,"Content-Type":"application/json"},{method:"POST",
    body:JSON.stringify({id:cash,operationId:crypto.randomUUID(),expectedTotal:45,tendered:50})});
  assert.equal(receipt.status,200);
  assert.deepEqual((await (await review(cash)).json()).cashReceipt,(await receipt.json()).cashReceipt);
  const report=await (await call("/daily?date="+day+"&paymentSummary=1")).json();
  assert.deepEqual(report.paymentSummary.groups.find(group=>group.method==="cash").review,[]);
});

test("pickup roster follows booked slot, kitchen readiness and customer arrival in one capture",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",slot=Date.parse(date+"T11:30:00+08:00"),minute=60_000;
  const cutoff=slot+15*minute;
  let now=cutoff-1;
  t.mock.method(Date,"now",()=>now);
  const headers={Authorization:"Bearer fixture-staff"};
  const endpoint="https://order.example/api/kitchen/pickup-roster?date="+date;
  const call=(suffix="",access=headers)=>api(new Request(endpoint+suffix,{headers:access}),{DB:db,STAFF_KEY:"fixture-staff"});
  const add=db.sqlite.prepare(`INSERT INTO orders(id,token,mode,status,items,note,total,created,pickup_slot,status_history,
    pickup_arrived_at,payment_method) VALUES (?,?,'pickup',?,'[]','private note',45,?,?,?,?,?)`);
  const seed=(id,readyAt,arrivedAt=null,status="ready",method="cash")=>add.run(id,crypto.randomUUID(),status,
    slot-30*minute,slot,readyAt===null?null:JSON.stringify([{from:"preparing",status:"ready",at:readyAt}]),arrivedAt,method);
  seed(1,slot+2*minute);
  seed(2,slot+5*minute,slot+3*minute);
  seed(3,slot+14*minute);
  seed(4,null);
  seed(5,slot,cutoff+1);
  seed(6,slot,null,"ready","line_pay");
  seed(7,slot,null,"completed");
  seed(8,slot,null,"preparing");
  seed(9,slot,slot+5*minute);
  assert.equal((await call("&followUp=1",{})).status,403);
  for(const invalid of ["&followUp=0","&followUp=1&followUp=1"])assert.equal((await call(invalid)).status,400);
  const read=async(suffix="")=>(await (await call("&followUp=1"+suffix)).json());
  assert.deepEqual((await read()).followUp,{unreported:0,arrived:0});
  now=cutoff;
  const snapshot=await read("&slot="+slot);
  assert.deepEqual(snapshot.followUp,{unreported:1,arrived:2});
  const flagged=snapshot.windows.flatMap(window=>window.orders).filter(order=>order.followUp);
  assert.deepEqual(flagged.map(({id,followUp})=>[id,followUp]),[
    [1,{state:"unreported",readyAt:slot+2*minute,dueAt:cutoff,arrivedAt:null}],
    [2,{state:"arrived",readyAt:slot+5*minute,dueAt:cutoff,arrivedAt:slot+3*minute}],
    [9,{state:"arrived",readyAt:slot,dueAt:cutoff,arrivedAt:slot+5*minute}],
  ]);
  assert.equal((await (await call()).json()).followUp,undefined);
  assert.ok(!/private|status_history|token/.test(JSON.stringify(snapshot)));
  assert.deepEqual((await read("&slot="+(slot+15*minute))).followUp,{unreported:0,arrived:0});
  db.sqlite.prepare("UPDATE orders SET pickup_arrived_at=? WHERE id=1").run(cutoff);
  db.sqlite.prepare("UPDATE orders SET status='completed' WHERE id IN (2,9)").run();
  assert.deepEqual((await read()).followUp,{unreported:0,arrived:0});
  now=cutoff+10*minute;
  const last=await read();
  assert.deepEqual(last.followUp,{unreported:1,arrived:1});
  assert.deepEqual(last.windows[0].orders.filter(order=>order.followUp).map(order=>order.id),[1,3]);
});

test("pickup roster follow-up sample comes from the current roster service",async()=>{
  const saved=JSON.parse(readFileSync(new URL("../examples/pickup-roster-followup-demo.json",import.meta.url),"utf8"));
  assert.deepEqual(await buildPickupRosterFollowUpDemo(),saved);
});

test("daily pickup punctuality uses the current booked date, cutoff and recorded readiness",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",previous="2026-11-24",midnight=Date.parse(date+"T00:00:00+08:00");
  const slot=Date.parse(date+"T11:00:00+08:00"),end=slot+900_000,nextSlot=end;
  let now=end;
  t.mock.method(Date,"now",()=>now);
  const staff={Authorization:"Bearer fixture-staff"},env={DB:db,STAFF_KEY:"fixture-staff"};
  const call=(day,options="&pickupPunctuality=1",headers=staff)=>
    api(new Request("https://order.example/api/kitchen/daily?date="+day+options,{headers}),env);
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status,pickup_slot,
    status_history,pickup_changes,payment_method,payment_due_at)
    VALUES (?,?,'punt-private-note','[]',45,?,?,?,?,?,?,?)`);
  const add=({start=slot,status="ready",created=midnight-1000,at=null,mode="pickup",
    method="cash",paymentDue=null,changes=null,history=at===null?"[]":JSON.stringify([{from:"preparing",status:"ready",at}])}={})=>
    Number(insert.run(crypto.randomUUID(),mode,created,status,start,history,changes&&JSON.stringify(changes),method,paymentDue).lastInsertRowid);
  add({at:slot-60_000,changes:[{from:slot-86_400_000,to:slot,at:midnight-500}]});
  add({at:end});
  const late=add({status:"completed",at:end+1000,method:"line_pay"});
  db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,'fixture-ref','private','refunded',?)")
    .run(late,slot);
  const overdue=add({status:"preparing"});
  add({status:"pending",start:nextSlot});
  add({status:"completed",at:midnight-2000});
  add({history:JSON.stringify([false,"legacy marker",{from:"preparing",status:"ready",at:String(slot)}])});
  add({method:"line_pay",status:"pending",paymentDue:end+60_000});
  add({status:"pending",method:"line_pay",paymentDue:end});
  add({status:"cancelled",at:slot});
  add({start:null,at:slot});
  add({mode:"table",at:slot});
  add({start:slot-86_400_000,created:midnight-100_000_000,at:slot-86_400_000});
  add({start:midnight+86_400_000,status:"pending"});
  const boundary=(await (await call(date)).json()).pickupPunctuality;
  assert.equal(boundary.totals.onTime,2);
  assert.equal(boundary.totals.overdue,0);
  assert.equal(boundary.totals.waiting,2);
  assert.equal(boundary.totals.unknown,3);

  now=end+2000;
  const response=await call(date,"&timing=1&pickupPunctuality=1");
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const raw=await response.text();
  assert.ok(!raw.includes("punt-private-note")&&!raw.includes("fixture-ref"));
  const report=JSON.parse(raw);
  assert.equal(report.channels.pickup.orders,0);
  const stats={bookings:10,onTime:2,late:1,overdue:1,waiting:1,unknown:2,awaitingPayment:1,cancelled:2};
  assert.deepEqual(report.pickupPunctuality,{totals:stats,
    windows:[{...stats,bookings:9,waiting:0,start:slot,end,issues:[
      {id:late,status:"late",readyAt:end+1000},{id:overdue,status:"overdue",readyAt:null},
    ]},{bookings:1,onTime:0,late:0,overdue:0,waiting:1,unknown:0,awaitingPayment:0,cancelled:0,
      start:nextSlot,end:nextSlot+900_000,issues:[]}]});
  assert.equal((await (await call(previous)).json()).pickupPunctuality.totals.bookings,1);
  assert.equal((await (await call("2026-11-26")).json()).pickupPunctuality.totals.bookings,1);
  assert.equal(Object.hasOwn(await (await call(date,"&timing=1")).json(),"pickupPunctuality"),false);
  assert.equal((await call(date,"&pickupPunctuality=1",{})).status,403);
});

test("daily arrival waits belong to the Taipei arrival date and group only valid readiness timestamps",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-23",start=Date.parse(date+"T00:00:00+08:00"),end=start+86_400_000,now=end+3_600_000;
  t.mock.method(Date,"now",()=>now);
  const staff={Authorization:"Bearer fixture-staff"},runtime={DB:db,STAFF_KEY:"fixture-staff"};
  const call=(day,timing=true)=>api(new Request("https://order.example/api/kitchen/daily?date="+day+(timing?"&timing=1":""),{headers:staff}),runtime);
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status,pickup_arrived_at,status_history)
    VALUES (?,?,'fixture-private-note','[]',45,?,?,?,?)`);
  const add=({arrived,ready=null,handedOff=null,created=start-60_000,mode="pickup",status="completed"})=>{
    const history=[
      ...(ready===null?[]:[{from:"preparing",status:"ready",at:ready}]),
      ...(handedOff===null?[]:[{from:"ready",status:"completed",at:handedOff}]),
    ];
    insert.run(crypto.randomUUID(),mode,created,status,arrived,JSON.stringify(history));
  };
  add({arrived:start,ready:start-10_000,handedOff:start+30_000});
  add({arrived:end-30_000,ready:end+5000,handedOff:end+15_000});
  add({arrived:start+2000,handedOff:start+12_000});
  add({arrived:start+20_000,ready:start+1000,handedOff:start+5000});
  add({arrived:start+30_000,status:"ready"});
  add({arrived:start+35_000,status:"cancelled"});
  add({arrived:start+40_000,ready:start+40_000,handedOff:start+40_000});
  add({arrived:end,ready:end,handedOff:end+1000});
  add({arrived:start+1000,ready:start,handedOff:start+2000,mode:"table"});
  add({arrived:null,ready:start,handedOff:start+1000});
  add({arrived:start+2000,ready:start+4000,handedOff:start+4000,created:start+3000});
  const result=await call(date);
  assert.equal(result.headers.get("Cache-Control"),"no-store");
  const raw=await result.text();
  assert.ok(!raw.includes("fixture-private-note"));
  const report=JSON.parse(raw);
  assert.deepEqual(report.arrivalTiming,{reported:7,unknownReadiness:1,
    overall:{eligible:5,samples:4,medianMs:20000,p90Ms:45000},
    readyAtArrival:{eligible:2,samples:2,medianMs:15000,p90Ms:30000},
    preparingAtArrival:{eligible:1,samples:1,medianMs:45000,p90Ms:45000},
  });
  assert.equal(report.channels.pickup.orders,1);
  assert.equal((await (await call("2026-11-24")).json()).arrivalTiming.overall.medianMs,1000);
  assert.equal(Object.hasOwn(await (await call(date,false)).json(),"arrivalTiming"),false);
});

test("pickup pass scopes access to one receipt and expires, rotates and revokes atomically",async t=>{
  const original=crypto.randomUUID(),unready=crypto.randomUUID(),table=crypto.randomUUID();
  const db=database((tag,sqlite)=>{
    if(tag!=="0033_pickup_passes")return;
    const add=sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created,pickup_slot)
      VALUES (?,?,?,'[]','private note',45,1,1800000)`);
    add.run(original,"pickup","ready");
    add.run(unready,"pickup","preparing");
    add.run(table,"table","ready");
  });
  t.after(()=>db.sqlite.close());
  let now=1000;
  t.mock.method(Date,"now",()=>now);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api"+path,options),env);
  const read=token=>call("/pickup-pass",{headers:{"X-Pickup-Pass":token}});
  const owner=(token,method="GET",body)=>call("/ticket/pickup-pass",{method,headers:{"X-Ticket":token,
    ...(body?{"Content-Type":"application/json"}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const issue=(pass,revision,token=original)=>owner(token,"POST",{pass,revision});
  const revoke=revision=>owner(original,"PATCH",{revision});
  const pass=crypto.randomUUID(),a=crypto.randomUUID(),b=crypto.randomUUID();
  assert.deepEqual(await (await owner(original)).json(),{active:false,revision:0,expiresAt:null});
  assert.equal((await issue(pass,0,crypto.randomUUID())).status,404);
  assert.equal((await issue(pass,0,unready)).status,409);
  assert.equal((await issue(pass,0,table)).status,409);
  assert.equal((await issue(original,0)).status,400);
  assert.equal((await issue([pass],0)).status,400);
  assert.equal((await issue(pass,0)).status,200);
  const guest=await read(pass);
  assert.equal(guest.headers.get("Cache-Control"),"no-store");
  assert.deepEqual(await guest.json(),{id:1,pickupSlot:1800000,expiresAt:1801000,pickupArrivedAt:null});
  const handoffView=await call("/pickup-pass?handoff=1",{headers:{"X-Pickup-Pass":pass}});
  assert.equal((await handoffView.json()).revision,1);
  assert.equal((await call("/ticket",{headers:{"X-Ticket":pass}})).status,404);
  assert.equal((await owner(pass)).status,404);
  assert.equal((await call("/kitchen/pickup?id=1",{headers:{"X-Pickup-Pass":pass}})).status,403);
  assert.equal((await read(original)).status,404);
  const stored=db.sqlite.prepare("SELECT token_hash FROM pickup_passes").get().token_hash;
  assert.match(stored,/^[a-f0-9]{64}$/);
  assert.notEqual(stored,pass);
  now+=30_000;
  assert.deepEqual(await (await issue(pass.toUpperCase(),0)).json(),{active:true,revision:1,expiresAt:1801000});
  const [first,second]=await Promise.all([issue(a,1),issue(b,1)]);
  assert.deepEqual([first.status,second.status].sort(),[200,409]);
  const current=first.ok?a:b;
  assert.equal((await read(pass)).status,404);
  assert.equal((await read(first.ok?b:a)).status,404);
  assert.equal((await read(current)).status,200);
  assert.equal((await revoke(1)).status,409);
  assert.deepEqual(await (await revoke(2)).json(),{active:false,revision:3,expiresAt:null});
  assert.equal((await revoke(2)).status,200);
  assert.equal((await read(current)).status,404);
  const expiring=crypto.randomUUID();
  const issued=await (await issue(expiring,3)).json();
  now=issued.expiresAt-1;
  assert.equal((await read(expiring)).status,200);
  now++;
  assert.equal((await read(expiring)).status,404);
  assert.deepEqual(await (await owner(original)).json(),{active:false,revision:4,expiresAt:null});
  const closing=crypto.randomUUID();
  assert.equal((await issue(closing,4)).status,200);
  assert.equal((await call("/kitchen/status",{method:"PATCH",headers:{...staff,"Content-Type":"application/json"},
    body:JSON.stringify({id:1,from:"ready",to:"completed"})})).status,200);
  assert.equal((await read(closing)).status,404);
  assert.equal((await issue(closing,4)).status,409);
});

test("delegated kitchen scan rechecks the issued pass at handoff and records exactly one event",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=1000;
  t.mock.method(Date,"now",()=>now);
  const original=crypto.randomUUID(),other=crypto.randomUUID();
  const firstPass=crypto.randomUUID(),secondPass=crypto.randomUUID();
  const add=db.sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created)
    VALUES (?,'pickup','ready','[]','staff-only note',45,1)`);
  add.run(original);
  add.run(other);
  const env={DB:db,STAFF_KEY:"fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api"+path,options),env);
  const staff={Authorization:"Bearer fixture-staff"};
  const issue=async(pass,revision,owner=original)=>call("/ticket/pickup-pass",{method:"POST",
    headers:{"X-Ticket":owner,"Content-Type":"application/json"},body:JSON.stringify({pass,revision})});
  const scan=(pass,opts={})=>{
    const {id=1,method="GET",headers=staff,revision=1}=opts;
    return call("/kitchen/pickup-pass-handoff?id="+id,{method,
      headers:{...headers,...(pass?{"X-Pickup-Pass":revision+"."+pass}:{}),"Content-Type":"application/json"},
      ...(method==="PATCH"?{body:"{}"}:{})});
  };
  assert.equal((await issue(firstPass,0)).status,200);
  assert.equal((await scan(firstPass,{headers:{}})).status,403);
  assert.equal((await scan(firstPass,{method:"PATCH",headers:{}})).status,403);
  assert.equal((await scan(null)).status,400);
  assert.equal((await scan(firstPass,{id:"1&id=1"})).status,400);
  assert.equal((await scan(firstPass,{id:2})).status,409);
  assert.equal((await scan(other)).status,409);
  const order=await (await scan(firstPass)).json();
  assert.equal(order.status,"ready");
  assert.equal(order.note,"staff-only note");
  assert.ok(!JSON.stringify(order).includes(firstPass)&&!JSON.stringify(order).includes(original));
  const second=await (await issue(secondPass,1)).json();
  assert.equal((await scan(firstPass)).status,409);
  assert.equal((await scan(firstPass,{method:"PATCH"})).status,409);
  now=second.expiresAt;
  assert.equal((await scan(secondPass,{method:"PATCH",revision:2})).status,409);
  assert.equal((await issue(firstPass,2)).status,200);
  assert.equal((await scan(firstPass,{method:"PATCH"})).status,409);
  const complete=()=>scan(firstPass,{method:"PATCH",revision:3});
  const [left,right]=await Promise.all([complete(),complete()]);
  assert.equal(left.status,200);
  assert.equal(right.status,200);
  const proof={id:1,status:"completed",completedAt:now};
  assert.deepEqual(await left.json(),proof);
  now++;
  assert.deepEqual(await right.json(),proof);
  assert.deepEqual(await (await complete()).json(),proof);
  assert.equal((await (await scan(firstPass,{revision:3})).json()).status,"completed");
  assert.equal((await call("/pickup-pass",{headers:{"X-Pickup-Pass":firstPass}})).status,404);
  const history=(await (await call("/kitchen/order-detail?id=1",{headers:staff})).json()).statusHistory;
  assert.deepEqual(history.filter(row=>row.status==="completed"),[{status:"completed",at:proof.completedAt,handoff:"pickup-pass"}]);
  assert.equal((await (await scan(firstPass,{id:2,revision:3})).json()).status,undefined);
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE id=2").get().status,"ready");
});

test("delegated handoff demo matches the protected API workflow",async()=>{
  const saved=JSON.parse(readFileSync(new URL("../examples/pickup-pass-handoff-demo.json",import.meta.url),"utf8"));
  assert.deepEqual(await buildPickupPassHandoffDemo(),saved);
});

test("staff pickup delay changes are versioned, retain their estimate on replay and close on readiness",async t=>{
  const customer=crypto.randomUUID(),unpaid=crypto.randomUUID(),pending=crypto.randomUUID(),table=crypto.randomUUID();
  const legacy=crypto.randomUUID();
  const db=database((tag,sqlite)=>{
    if(tag==="0047_pickup_delay_acknowledgements"){
      sqlite.prepare(`INSERT INTO pickup_delay_updates(order_id,revision,operation_id,ready_at,recorded_at)
        SELECT id,1,?,150000,50000 FROM orders WHERE token=?`).run(crypto.randomUUID(),legacy);
    }
    if(tag!=="0034_pickup_delay_updates")return;
    const add=sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created,pickup_slot,payment_method)
      VALUES (?,?,?,'[]','private receipt note',45,1,?,?)`);
    add.run(customer,"pickup","preparing",120_000,"cash");
    add.run(unpaid,"pickup","preparing",null,"line_pay");
    add.run(pending,"pickup","pending",null,"cash");
    add.run(table,"table","preparing",null,"cash");
    add.run(legacy,"pickup","preparing",null,"cash");
  });
  t.after(()=>db.sqlite.close());
  let now=60_000;
  t.mock.method(Date,"now",()=>now);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api"+path,options),env);
  const ticket=(token=customer)=>call("/ticket?progress=1",{headers:{"X-Ticket":token}});
  const update=(input,headers=staff)=>call("/kitchen/pickup-delay",{method:"PATCH",
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(input)});
  const acknowledge=(revision,token=customer,headers={})=>call("/ticket/pickup-delay/acknowledge",{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token,...headers},body:JSON.stringify({revision})});
  const id=(await (await ticket()).json()).id;
  const make=(minutes,revision=0,target=id)=>({id:target,revision,operationId:crypto.randomUUID(),minutes});
  for(const token of [unpaid,pending,table]){
    const other=(await (await ticket(token)).json()).id;
    assert.equal((await update(make(5,0,other))).status,409);
  }
  assert.equal((await update(make(5,0,99_999))).status,404);
  assert.equal((await update(make(5),{"X-Ticket":customer})).status,403);
  assert.equal((await update(make(5),{...staff,Origin:"https://other.example"})).status,403);
  assert.equal((await update(make(null))).status,409);
  assert.equal((await update(make(241))).status,400);
  const attempts=[make(7),make(12)],replies=await Promise.all(attempts.map(attempt=>update(attempt)));
  assert.deepEqual(replies.map(result=>result.status).sort(),[200,409]);
  const winner=replies.findIndex(result=>result.ok),saved=await replies[winner].json(),request=attempts[winner];
  assert.deepEqual(saved,{id,revision:1,readyAt:now+request.minutes*60_000,recordedAt:now});
  const receipt=await ticket();
  assert.equal(receipt.headers.get("Cache-Control"),"no-store");
  const original=await receipt.json();
  assert.deepEqual(original.pickupDelay,{revision:1,readyAt:saved.readyAt,recordedAt:saved.recordedAt,acknowledgedAt:null,passed:false});
  assert.equal(original.pickupSlot,120_000);
  const booking=await (await call("/kitchen/pickup-booking?id="+id,{headers:staff})).json();
  const board=await (await call("/kitchen",{headers:staff})).json();
  assert.deepEqual(booking,board.find(row=>row.id===id));
  assert.deepEqual(booking.pickupDelay,{revision:1,readyAt:saved.readyAt,recordedAt:saved.recordedAt,acknowledgedAt:null,passed:false});
  assert.equal((await acknowledge(1,crypto.randomUUID())).status,404);
  assert.equal((await acknowledge(1,customer,{Origin:"https://other.example"})).status,403);
  assert.equal((await acknowledge(1,unpaid)).status,409);
  assert.equal((await acknowledge(2)).status,409);
  assert.equal((await acknowledge("1")).status,400);
  now+=1000;
  const acknowledged={revision:1,acknowledgedAt:now};
  const repeated=await Promise.all([acknowledge(1),acknowledge(1)]);
  for(const result of repeated){
    assert.equal(result.status,200);
    assert.deepEqual(await result.json(),acknowledged);
  }
  assert.equal((await (await ticket()).json()).pickupDelay.acknowledgedAt,acknowledged.acknowledgedAt);
  assert.equal((await (await call("/kitchen",{headers:staff})).json()).find(row=>row.id===id).pickupDelay.acknowledgedAt,
    acknowledged.acknowledgedAt);
  now=saved.readyAt;
  assert.deepEqual(await (await update(request)).json(),saved);
  assert.equal((await update({...request,minutes:request.minutes+1})).status,409);
  assert.equal((await (await ticket()).json()).pickupDelay.passed,true);
  const dueBoard=await (await call("/kitchen",{headers:staff})).json();
  assert.equal(dueBoard.find(row=>row.id===id).pickupDelay.passed,true);
  assert.deepEqual(await (await acknowledge(1)).json(),acknowledged);
  const clear=make(null,1);
  const cleared=await (await update(clear)).json();
  assert.equal(cleared.readyAt,null);
  assert.equal(Object.hasOwn(await (await ticket()).json(),"pickupDelay"),false);
  const clearedBoard=await (await call("/kitchen",{headers:staff})).json();
  assert.deepEqual(clearedBoard.find(row=>row.id===id).pickupDelay,
    {revision:2,readyAt:null,recordedAt:cleared.recordedAt,acknowledgedAt:null,passed:false});
  assert.equal((await acknowledge(1)).status,409);
  assert.equal((await acknowledge(2)).status,409);
  assert.deepEqual(await (await update(clear)).json(),cleared);
  const latest=make(3,2);
  assert.equal((await update(latest)).status,200);
  assert.equal((await (await ticket()).json()).pickupDelay.acknowledgedAt,null);
  const prepare=await call("/kitchen/status",{method:"PATCH",headers:{...staff,"Content-Type":"application/json"},
    body:JSON.stringify({id,from:"preparing",to:"ready"})});
  assert.equal(prepare.status,200);
  assert.equal((await update(make(6,3))).status,409);
  assert.equal((await update(latest)).status,200);
  assert.equal(Object.hasOwn(await (await ticket()).json(),"pickupDelay"),false);
  assert.equal((await acknowledge(3)).status,409);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM pickup_delay_updates WHERE order_id=?").get(id).total,3);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS total FROM pickup_delay_acknowledgements WHERE order_id=?").get(id).total,1);
  assert.equal((await call("/kitchen/pickup-delay-history?id="+id,{headers:{"X-Ticket":customer}})).status,403);
  const history=await (await call("/kitchen/pickup-delay-history?id="+id,{headers:staff})).json();
  assert.deepEqual(history.updates.map(({revision,readyAt,acknowledgedAt,latest})=>[revision,readyAt,acknowledgedAt,latest]),[
    [3,now+180000,null,true],[2,null,null,false],[1,saved.readyAt,acknowledged.acknowledgedAt,false],
  ]);
  const prior=await (await ticket(legacy)).json();
  assert.deepEqual(prior.pickupDelay,{revision:1,readyAt:150000,recordedAt:50000,acknowledgedAt:null,passed:true});
  const [replacement,oldReply]=await Promise.all([update(make(5,1,prior.id)),acknowledge(1,legacy)]);
  assert.equal(replacement.status,200);
  assert.ok([200,409].includes(oldReply.status));
  const then=await (await ticket(legacy)).json();
  assert.equal(then.pickupDelay.revision,2);
  assert.equal(then.pickupDelay.acknowledgedAt,null);
});

test("pickup delay history pages stable revisions and only exposes the requested pickup order to staff",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const create=db.sqlite.prepare("INSERT INTO orders(token,mode,status,items,note,total,created,payment_method) VALUES (?,?,?,'[]','',45,0,'cash')");
  const order=Number(create.run(crypto.randomUUID(),"pickup","completed").lastInsertRowid);
  const another=Number(create.run(crypto.randomUUID(),"pickup","completed").lastInsertRowid);
  const table=Number(create.run(crypto.randomUUID(),"table","completed").lastInsertRowid);
  const delay=db.sqlite.prepare("INSERT INTO pickup_delay_updates(order_id,revision,operation_id,ready_at,recorded_at) VALUES (?,?,?,?,?)");
  const append=revision=>delay.run(order,revision,crypto.randomUUID(),revision===4?null:revision*1000+60000,revision*1000);
  for(let revision=1;revision<=12;revision++)append(revision);
  db.sqlite.prepare("INSERT INTO pickup_delay_acknowledgements VALUES (?,?,?)").run(order,1,1150);
  const read=(query,authorized=true)=>api(new Request("https://order.example/api/kitchen/pickup-delay-history?"+query,{
    headers:authorized?{Authorization:"Bearer fixture-staff"}:{},
  }),{DB:db,STAFF_KEY:"fixture-staff"});
  assert.equal((await read("id="+order,false)).status,403);
  assert.equal((await read("id="+table)).status,404);
  assert.equal((await read("id=99999")).status,404);
  assert.deepEqual(await (await read("id="+another)).json(),{id:another,updates:[],nextBefore:null});
  for(const query of ["before=0","before=2&before=3","before=9007199254740992","id="+another])
    assert.equal((await read("id="+order+"&"+query)).status,400);
  const reply=await read("id="+order);
  assert.equal(reply.headers.get("Cache-Control"),"no-store");
  const latest=await reply.json();
  assert.deepEqual(latest.updates.map(update=>update.revision),[12,11,10,9,8,7,6,5,4,3]);
  assert.deepEqual(latest.updates.filter(update=>update.latest).map(update=>update.revision),[12]);
  assert.deepEqual(latest.updates.find(update=>update.revision===4),
    {revision:4,readyAt:null,recordedAt:4000,acknowledgedAt:null,latest:false});
  assert.equal(latest.nextBefore,3);
  append(13);
  const older=await (await read("id="+order+"&before="+latest.nextBefore)).json();
  assert.deepEqual(older.updates.map(update=>update.revision),[2,1]);
  assert.equal(older.updates[1].acknowledgedAt,1150);
  assert.equal(older.nextBefore,null);
});

test("daily pickup delay reports use Taiwan event dates and one snapshot for acknowledgements and follow-up",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",start=Date.parse(date+"T00:00:00+08:00"),tomorrow=start+86_400_000,now=tomorrow+10_000;
  t.mock.method(Date,"now",()=>now);
  const create=db.sqlite.prepare("INSERT INTO orders(token,mode,status,items,note,total,created,payment_method) VALUES (?,?,?,'[]','',45,?,?)");
  const order=(status="preparing",method="cash",mode="pickup")=>
    Number(create.run(crypto.randomUUID(),mode,status,start-100_000,method).lastInsertRowid);
  const insert=db.sqlite.prepare("INSERT INTO pickup_delay_updates(order_id,revision,operation_id,ready_at,recorded_at) VALUES (?,?,?,?,?)");
  const ack=db.sqlite.prepare("INSERT INTO pickup_delay_acknowledgements VALUES (?,?,?)");
  function notice(id,revision,recordedAt,readyAt,acknowledgedAt=null){
    insert.run(id,revision,crypto.randomUUID(),readyAt,recordedAt);
    if(acknowledgedAt!==null)ack.run(id,revision,acknowledgedAt);
  }
  const continued=order();
  notice(continued,1,start-1,start+100,start+100);
  notice(continued,2,start,start+2000,start+2000);
  notice(continued,3,start+3000,start+5000,tomorrow+1000);
  notice(continued,4,tomorrow,tomorrow+120_000);
  const atBoundary=order(),earlier=order();
  notice(atBoundary,1,tomorrow-1000,now);
  notice(earlier,1,start+1000,start+9000);
  const withdrawnTomorrow=order(),withdrawnToday=order();
  notice(withdrawnTomorrow,1,start+1000,start+9000);
  notice(withdrawnTomorrow,2,tomorrow,null);
  notice(withdrawnToday,1,start-1000,start+9000);
  notice(withdrawnToday,2,start+1000,null);
  notice(order("completed"),1,start+1000,start+9000);
  notice(order("preparing","line_pay"),1,start+1000,start+9000);
  notice(order("preparing","cash","table"),1,start+1000,start+9000);
  notice(order(),1,now+1000,now+90_000);
  const headers={Authorization:"Bearer fixture-staff"};
  const read=(day,options="&pickupDelays=1",proof=headers)=>api(new Request(
    "https://order.example/api/kitchen/daily?date="+day+options,{headers:proof}),{DB:db,STAFF_KEY:"fixture-staff"});
  assert.equal((await read(date,"&pickupDelays=1",{})).status,403);
  assert.equal(Object.hasOwn(await (await read(date,"")).json(),"pickupDelays"),false);
  const report=await (await read(date,"&timing=1&pickupDelays=1")).json();
  assert.equal(report.capturedAt,now);
  assert.deepEqual(report.pickupDelays,{
    affectedOrders:6,notices:7,withdrawals:1,acknowledged:2,acknowledgedAfterEstimate:1,
    overdueOrders:[{id:earlier,revision:1,readyAt:start+9000},{id:atBoundary,revision:1,readyAt:now}],
  });
  assert.deepEqual((await (await read("2026-11-26")).json()).pickupDelays,{
    affectedOrders:1,notices:1,withdrawals:1,acknowledged:0,acknowledgedAfterEstimate:0,overdueOrders:[],
  });
  assert.deepEqual((await (await read("2026-11-27")).json()).pickupDelays,{
    affectedOrders:0,notices:0,withdrawals:0,acknowledged:0,acknowledgedAfterEstimate:0,overdueOrders:[],
  });
});

test("a pickup delegate and receipt owner share the first arrival with staff",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=60_000;
  t.mock.method(Date,"now",()=>now);
  const env={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api"+path,options),env);
  const post=(path,headers,body={},method="POST")=>call(path,{method,
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
  const original=crypto.randomUUID(),pass=crypto.randomUUID(),rotated=crypto.randomUUID(),expired=crypto.randomUUID();
  const owner={"X-Ticket":original},auth=token=>({"X-Pickup-Pass":token});
  const issue=(token,revision)=>post("/ticket/pickup-pass",owner,{pass:token,revision});
  const arrive=(token,extra={})=>post("/pickup-pass/arrival",{...auth(token),...extra});
  const id=Number(db.sqlite.prepare(`INSERT INTO orders(token,mode,status,items,note,total,created)
    VALUES (?,'pickup','ready','[]','original receipt only',45,1)`).run(original).lastInsertRowid);
  const confirmation={id,pickupArrivedAt:now};
  assert.equal((await issue(pass,0)).status,200);
  assert.equal((await post("/pickup-pass/arrival",owner)).status,404);
  assert.equal((await arrive(original)).status,404);
  assert.equal((await arrive(pass,{Origin:"https://other.example"})).status,403);
  assert.equal((await post("/ticket/arrival",{"X-Ticket":pass})).status,404);
  const first=await call("/pickup-pass",{headers:auth(pass)});
  assert.equal((await first.json()).pickupArrivedAt,null);

  const [delegate,customer]=await Promise.all([arrive(pass),post("/ticket/arrival",owner)]);
  assert.equal(delegate.headers.get("Cache-Control"),"no-store");
  for(const response of [delegate,customer]){
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),confirmation);
  }
  const [receipt,lookup,queue]=await Promise.all([
    call("/ticket",{headers:owner}),call("/kitchen/pickup?id="+id,{headers:staff}),call("/kitchen",{headers:staff}),
  ]);
  assert.equal((await receipt.json()).pickupArrivedAt,now);
  assert.equal((await lookup.json()).pickupArrivedAt,now);
  assert.equal((await queue.json()).find(row=>row.id===id).pickupArrivedAt,now);
  now+=5_000;
  assert.deepEqual(await (await arrive(pass)).json(),confirmation);
  const projection=await (await call("/pickup-pass",{headers:auth(pass)})).json();
  assert.deepEqual(projection,{id,pickupSlot:null,expiresAt:1860000,pickupArrivedAt:60000});
  assert.equal((await issue(rotated,1)).status,200);
  assert.equal((await arrive(pass)).status,404);
  assert.deepEqual(await (await arrive(rotated)).json(),confirmation);
  assert.equal((await post("/ticket/pickup-pass",owner,{revision:2},"PATCH")).status,200);
  assert.equal((await arrive(rotated)).status,404);
  const issued=await (await issue(expired,3)).json();
  now=issued.expiresAt;
  assert.equal((await arrive(expired)).status,404);
  const closing=crypto.randomUUID();
  assert.equal((await issue(closing,4)).status,200);
  assert.equal((await post("/kitchen/status",staff,{id,from:"ready",to:"completed"},"PATCH")).status,200);
  assert.equal((await arrive(closing)).status,404);
  assert.equal(db.sqlite.prepare("SELECT pickup_arrived_at FROM orders WHERE id=?").get(id).pickup_arrived_at,confirmation.pickupArrivedAt);
});

test("pickup arrival uses the receipt credential and persists the first time through handoff",async t=>{
  const oldToken=crypto.randomUUID();
  let now=Date.parse("2026-11-25T12:00:00+08:00");
  const db=database((tag,sqlite)=>{
    if(tag!=="0031_pickup_arrivals")return;
    sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,status,created)
      VALUES (?,'pickup','','[]',45,'preparing',?)`).run(oldToken,now-600_000);
  });
  t.after(()=>db.sqlite.close());
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"};
  const staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api"+path,options),runtime);
  const submit=(token,extra={})=>call("/ticket/arrival",{method:"POST",
    headers:{"X-Ticket":token,"Content-Type":"application/json",...extra},body:"{}"});
  const read=async token=>(await (await call("/ticket?progress=1",{headers:{"X-Ticket":token}})).json());
  const insert=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,status,created,payment_method,pickup_slot)
    VALUES (?,?,'','[]',45,?,?,?,?)`);
  const add=(status,mode="pickup",method="cash",slot=null)=>{
    const token=crypto.randomUUID();
    const id=Number(insert.run(token,mode,status,now-600_000,method,slot).lastInsertRowid);
    return {token,id};
  };
  const table=add("ready","table"),pending=add("pending"),unpaid=add("preparing","pickup","line_pay"),closed=add("completed");
  const online=add("ready","pickup","line_pay",now);
  const pay=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?, 'fixture',?,?)");
  pay.run(online.id,"arrival-paid","paid",now-5000);
  assert.equal((await submit("wrong-key")).status,404);
  assert.equal((await submit(crypto.randomUUID())).status,404);
  assert.equal((await submit(oldToken,{Origin:"https://other.example"})).status,403);
  for(const item of [table,pending,unpaid,closed])assert.equal((await submit(item.token)).status,409);
  const before=await read(oldToken);
  assert.equal(Object.hasOwn(before,"pickupArrivedAt"),false);
  const [first,repeat]=await Promise.all([submit(oldToken),submit(oldToken)]);
  assert.equal(first.headers.get("Cache-Control"),"no-store");
  const saved={id:before.id,pickupArrivedAt:now};
  assert.deepEqual(await first.json(),saved);
  assert.deepEqual(await repeat.json(),saved);
  assert.deepEqual(await read(oldToken),{...before,pickupArrivedAt:now});
  assert.equal((await submit(online.token)).status,200);
  assert.equal((await call("/kitchen/pickup?id="+online.id)).status,403);
  assert.equal((await (await call("/kitchen/pickup?id="+online.id,{headers:staff})).json()).pickupArrivedAt,now);
  const publicDisplay=await (await call("/kitchen/pickup-display",{headers:staff})).json();
  assert.deepEqual(publicDisplay,{capturedAt:now,ready:[online.id],preparing:[before.id]});
  now+=60_000;
  assert.deepEqual(await (await submit(oldToken)).json(),saved);
  const closing=add("ready");
  const [transition,late]=await Promise.all([
    call("/kitchen/status",{method:"PATCH",headers:{...staff,"Content-Type":"application/json"},
      body:JSON.stringify({id:closing.id,from:"ready",to:"completed"})}),
    submit(closing.token),
  ]);
  assert.equal(transition.status,200);
  assert.ok([200,409].includes(late.status));
  const after=await read(closing.token);
  assert.equal(after.status,"completed");
  assert.equal(after.pickupArrivedAt,late.ok?now:undefined);
  assert.equal((await submit(closing.token)).status,late.status);
});

test("staff pickup week groups capacity and unfinished prep in the same Taipei snapshot",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-30",pausedDate="2026-12-01",openDate="2026-12-02";
  const start=(day,time)=>Date.parse(day+"T"+time+":00+08:00");
  let now=start(date,"11:15");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=headers=>api(new Request("https://order.example/api/kitchen/pickup-week",{headers}),runtime);
  const add=db.sqlite.prepare(`INSERT INTO orders(token,mode,pickup_slot,note,items,total,created,status,payment_method,payment_due_at)
    VALUES (?,?,?,'private note',?,90,?,?,?,?)`);
  const order=(slot,qty,{mode="pickup",status="pending",method="cash",due=null}={})=>
    add.run(crypto.randomUUID(),mode,slot,JSON.stringify([{id:"sencha",qty}]),now-900_000,status,method,due).lastInsertRowid;
  const limit=db.sqlite.prepare("INSERT INTO pickup_slot_limits VALUES (?,?,1)");
  limit.run(start(date,"11:30"),1);
  limit.run(start(date,"11:45"),5);
  limit.run(start(date,"12:00"),0);
  limit.run(start(openDate,"12:00"),4);
  order(start(date,"11:30"),2,{status:"completed"});
  order(start(date,"11:45"),2);
  order(start(date,"11:45"),3,{status:"ready"});
  order(start(date,"11:45"),8,{status:"cancelled"});
  order(start(date,"11:45"),8,{mode:"table"});
  order(null,8);
  order(start("2026-11-29","13:00"),8);
  order(start("2026-12-07","13:00"),8);
  order(start(pausedDate,"12:00"),1);
  const overdue=order(start(openDate,"12:00"),4,{method:"line_pay",due:now});
  const underway=order(start(openDate,"12:00"),2,{method:"line_pay",due:now});
  const preparing=order(start(openDate,"12:15"),2,{status:"preparing",method:"line_pay",due:now});
  const tea={id:"sencha",qty:2,note:"private tea note"},gyoza={id:"gyoza",qty:3};
  db.sqlite.prepare("UPDATE orders SET items=?,station_progress=? WHERE id=?").run(JSON.stringify([tea,gyoza]),
    JSON.stringify({groups:{fryer:[gyoza],drinks:[tea]},done:{fryer:now-500}}),preparing);
  order(start(openDate,"12:30"),1,{status:"preparing"});
  const payment=db.sqlite.prepare("INSERT INTO payment_attempts(order_id,reference,merchant,state,created) VALUES (?,?,'fixture',?,?)");
  payment.run(underway,"private-ref","pending",now-1000);
  payment.run(preparing,"private-prep-ref","authorized",now-1000);
  db.sqlite.prepare("INSERT INTO pickup_day_intake VALUES (?,0,1)").run(pausedDate);
  db.sqlite.prepare("INSERT INTO order_intake VALUES ('pickup',0,1)").run();
  assert.equal((await call()).status,403);
  const response=await call(staff);
  assert.equal(response.status,200);
  assert.equal(response.headers.get("Cache-Control"),"no-store");
  const expectedEmpty={accepting:true,ended:false,bookings:0,portions:0,available:36,full:0,closed:0,prep:[]};
  assert.deepEqual(await response.json(),{capturedAt:now,onlineAccepting:false,days:[
    {date,accepting:true,ended:false,bookings:3,portions:7,available:31,full:1,closed:1,prep:[{id:"sencha",pending:2,preparing:0}]},
    {date:pausedDate,accepting:false,ended:false,bookings:1,portions:1,available:0,full:0,closed:0,prep:[{id:"sencha",pending:1,preparing:0}]},
    {date:openDate,...expectedEmpty,bookings:3,portions:8,prep:[{id:"sencha",pending:0,preparing:3}]},
    ...["2026-12-03","2026-12-04","2026-12-05","2026-12-06"].map(day=>({date:day,...expectedEmpty})),
  ]});
  const status=id=>db.sqlite.prepare("SELECT status FROM orders WHERE id=?").get(id).status;
  assert.equal(status(overdue),"cancelled");
  assert.equal(status(underway),"pending");
  now=start(date,"19:16");
  assert.deepEqual((await (await call(staff)).json()).days[0],{
    date,accepting:true,ended:true,bookings:3,portions:7,available:0,full:0,closed:0,prep:[{id:"sencha",pending:2,preparing:0}],
  });
  now=start(pausedDate,"00:00");
  const moved=(await (await call(staff)).json()).days;
  assert.equal(moved[0].date,pausedDate);
  assert.equal(moved.at(-1).date,"2026-12-07");
  assert.equal(moved.at(-1).bookings,1);
});

test("pickup slot batches compare every revision and cutoff before writing any limit",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",first=Date.parse(date+"T12:00:00+08:00"),second=first+900_000,third=second+900_000;
  let now=first-75*60_000;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const patch=(path,input,headers=staff)=>api(new Request("https://order.example/api/kitchen/"+path,{
    method:"PATCH",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(input),
  }),runtime);
  const single=(start,capacity,revision)=>patch("pickup-slots",{date,start,capacity,revision});
  const batch=(slots,capacity=0,headers=staff)=>patch("pickup-slot-batch",{date,capacity,slots},headers);
  const selected=[{start:second,revision:0},{start:first,revision:0}];
  assert.equal((await batch(selected,0,{})).status,403);
  for(const malformed of [[],[null],[selected[0],selected[0]],[{start:first+1,revision:0}],[{start:first,revision:-1}]]){
    assert.equal((await batch(malformed)).status,400);
  }
  assert.equal((await batch(selected,1.2)).status,400);
  assert.equal((await single(first,8,0)).status,200);
  assert.equal((await batch(selected)).status,409);
  const stored=()=>db.sqlite.prepare("SELECT start,capacity,revision FROM pickup_slot_limits ORDER BY start").all().map(row=>({...row}));
  assert.deepEqual(stored(),[{start:first,capacity:8,revision:1}]);
  const changed=await batch([{start:second,revision:0},{start:first,revision:1}]);
  assert.deepEqual(await changed.json(),{date,slots:[{start:first,capacity:0,revision:2},{start:second,capacity:0,revision:1}]});
  const [a,b]=await Promise.all([batch([{start:first,revision:2},{start:second,revision:1}],4),
    batch([{start:second,revision:1},{start:third,revision:0}],null)]);
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
  const before=stored();
  now=first-29*60_000;
  assert.equal((await batch([{start:first,revision:before[0].revision},{start:second,revision:before[1].revision}],null)).status,409);
  assert.deepEqual(stored(),before);
});

test("pickup limit history preserves preexisting settings and records only committed changes",async t=>{
  const date="2026-11-25",first=Date.parse(date+"T12:00:00+08:00"),second=first+900_000;
  const now=first-75*60_000;
  t.mock.method(Date,"now",()=>now);
  const db=database((tag,sqlite)=>{
    if(tag==="0028_pickup_limit_events")sqlite.prepare("INSERT INTO pickup_slot_limits VALUES (?,8,1)").run(first);
  });
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api/kitchen/"+path,options),runtime);
  const patch=(path,input)=>call(path,{method:"PATCH",headers:{...staff,"Content-Type":"application/json"},body:JSON.stringify({date,...input})});
  const history="pickup-slots/history?date="+date;
  const read=async(path=history)=>(await call(path,{headers:staff})).json();
  const batch=(revision,capacity)=>patch("pickup-slot-batch",{capacity,slots:[{start:second,revision:0},{start:first,revision}]});
  const day=(accepting,revision)=>patch("pickup-day",{accepting,revision});
  assert.equal((await call(history)).status,403);
  for(const suffix of ["&date="+date,"&before=0","&before=1e3","&before=1&before=2"])
    assert.equal((await call(history+suffix,{headers:staff})).status,400);
  assert.equal((await call(history,{headers:staff})).headers.get("cache-control"),"no-store");
  assert.deepEqual(await read(),{date,events:[],nextBefore:null});
  assert.equal((await patch("pickup-slots",{start:first,capacity:null,revision:1})).status,200);
  assert.equal((await batch(1,0)).status,409);
  db.sqlite.exec("CREATE TRIGGER fail_second_limit BEFORE INSERT ON pickup_slot_limits WHEN NEW.start="+second+
    " BEGIN SELECT RAISE(ABORT,'write rejected'); END");
  await assert.rejects(batch(2,0),/write rejected/);
  assert.deepEqual(db.sqlite.prepare("SELECT start,capacity,revision FROM pickup_slot_limits").all().map(row=>({...row})),
    [{start:first,capacity:null,revision:2}]);
  assert.equal((await read()).events.length,1);
  db.sqlite.exec("DROP TRIGGER fail_second_limit");
  assert.equal((await batch(2,0)).status,200);
  assert.equal((await day(false,0)).status,200);
  assert.equal((await day(true,0)).status,409);
  assert.equal((await day(true,1)).status,200);
  assert.deepEqual(await read(),{date,events:[
    {id:4,changedAt:now,kind:"day",changes:[{previousAccepting:false,accepting:true,revision:2}]},
    {id:3,changedAt:now,kind:"day",changes:[{previousAccepting:true,accepting:false,revision:1}]},
    {id:2,changedAt:now,kind:"batch",changes:[{start:first,previousCapacity:null,capacity:0,revision:3},
      {start:second,previousCapacity:null,capacity:0,revision:1}]},
    {id:1,changedAt:now,kind:"slot",changes:[{start:first,previousCapacity:8,capacity:null,revision:2}]},
  ],nextBefore:null});
  assert.equal((await patch("pickup-day",{date:"2026-11-26",accepting:false,revision:0})).status,200);
  for(let revision=2;revision<26;revision++)assert.equal((await day(revision%2===1,revision)).status,200);
  const latest=await read();
  assert.equal(latest.events.length,25);
  assert.equal(latest.nextBefore,4);
  assert.equal((await day(false,26)).status,200);
  const older=await read(history+"&before="+latest.nextBefore);
  assert.deepEqual(older.events.map(event=>event.id),[3,2,1]);
  assert.equal(older.nextBefore,null);
  assert.equal((await read("pickup-slots/history?date=2026-11-26")).events.length,1);
});

test("restore pickup history uses original values and rejects stale, expired and partial writes",async t=>{
  const date="2026-11-25",first=Date.parse(date+"T12:00:00+08:00"),second=first+900_000;
  let now=first-75*60_000;
  t.mock.method(Date,"now",()=>now);
  const db=database((tag,sqlite)=>{
    if(tag!=="0029_pickup_limit_restore_sources")return;
    const insert=sqlite.prepare("INSERT INTO pickup_slot_limits VALUES (?,0,2)");
    insert.run(first);insert.run(second);
    sqlite.prepare("INSERT INTO pickup_limit_events(operation_id,date,changed_at,kind,changes) VALUES (?,?,?,'batch',?)")
      .run("earlier-event",date,now-1000,JSON.stringify([
        {start:first,previousCapacity:null,capacity:0,revision:2},
        {start:second,previousCapacity:5,capacity:0,revision:2},
      ]));
  });
  t.after(()=>db.sqlite.close());
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api/kitchen/"+path,options),runtime);
  const patch=(path,input,headers=staff)=>call(path,{
    method:"PATCH",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({date,...input}),
  });
  const restore=(input,headers=staff)=>patch("pickup-slots/restore",{fromId:1,...input},headers);
  const history=async()=>(await (await call("pickup-slots/history?date="+date,{headers:staff})).json()).events;
  const selections=[{start:second,revision:2},{start:first,revision:2}];
  assert.equal((await restore({slots:selections},{})).status,403);
  assert.equal((await restore({date:"2026-11-26",slots:selections})).status,404);
  assert.equal((await restore({slots:[selections[0]]})).status,400);
  assert.equal((await restore({slots:[selections[0],selections[0]]})).status,400);
  assert.equal((await restore({slots:[selections[0],{start:first,revision:1}]})).status,409);
  now=first-29*60_000;
  assert.equal((await restore({slots:selections})).status,409);
  now=first-50*60_000;
  assert.equal((await history()).length,1);
  const stored=()=>db.sqlite.prepare("SELECT start,capacity,revision FROM pickup_slot_limits ORDER BY start").all().map(row=>({...row}));
  const original=stored();
  db.sqlite.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON pickup_slot_limits WHEN NEW.start="+second+
    " BEGIN SELECT RAISE(ABORT,'restore rejected'); END");
  await assert.rejects(restore({slots:selections}),/restore rejected/);
  assert.deepEqual(stored(),original);
  assert.equal((await history()).length,1);
  db.sqlite.exec("DROP TRIGGER fail_restore");
  const [a,b]=await Promise.all([restore({slots:selections}),restore({slots:selections})]);
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
  const rows=[{start:first,capacity:null,revision:3},{start:second,capacity:5,revision:3}];
  assert.deepEqual(await (a.ok?a:b).json(),{date,slots:rows,restoredFromId:1});
  assert.deepEqual(stored(),rows);
  assert.equal((await restore({slots:rows})).status,409);
  const events=await history();
  assert.equal(events.length,2);
  assert.deepEqual(events[0],{id:2,kind:"batch",changedAt:now,restoredFromId:1,changes:rows.map(row=>({...row,previousCapacity:0}))});
  assert.equal(Object.hasOwn(events[1],"restoredFromId"),false);
  assert.equal((await patch("pickup-day",{accepting:false,revision:0})).status,200);
  assert.equal((await restore({fromId:3,revision:0})).status,409);
  assert.deepEqual(await (await restore({fromId:3,revision:1})).json(),{date,accepting:true,revision:2,restoredFromId:3});
  assert.deepEqual((await history())[0],{id:4,kind:"day",changedAt:now,restoredFromId:3,
    changes:[{previousAccepting:false,accepting:true,revision:2}]});
});

test("copy pickup limits checks both dates and records mixed capacities without touching bookings",async t=>{
  const date="2026-11-25",sourceDate="2026-11-24",first=Date.parse(date+"T12:00:00+08:00"),second=first+900_000;
  const sourceSecond=second-86_400_000,db=database();
  t.after(()=>db.sqlite.close());
  let now=first-75*60_000;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff"},staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options)=>api(new Request("https://order.example/api/"+path,options),runtime);
  const send=(path,input,method="PATCH",headers=staff)=>call(path,{
    method,headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify(input),
  });
  const copy=(slots,extra={},headers=staff)=>send("kitchen/pickup-slots/copy",{date,sourceDate,slots,...extra},"PATCH",headers);
  const get=async(path,headers=staff)=>(await (await call(path,{headers})).json());
  const history=()=>get("kitchen/pickup-slots/history?date="+date);
  const limits=()=>get("kitchen/pickup-slots?date="+date);
  const setSource=db.sqlite.prepare("INSERT INTO pickup_slot_limits VALUES (?,?,?)");
  setSource.run(sourceSecond,0,1);
  db.sqlite.prepare("INSERT INTO pickup_day_intake VALUES (?,0,1)").run(sourceDate);
  assert.equal((await send("kitchen/pickup-slots",{date,start:first,revision:0,capacity:5})).status,200);
  const token=crypto.randomUUID();
  assert.equal((await send("orders",{token,mode:"pickup",note:"",pickupSlot:second,items:[{id:"sencha",qty:2}]},"POST",{})).status,200);
  const slots=[{start:second,revision:0,sourceRevision:1},{start:first,revision:1,sourceRevision:0}];
  assert.equal((await copy(slots,{},{})).status,403);
  assert.equal((await copy(slots,{sourceDate:date})).status,400);
  assert.equal((await copy([slots[0],slots[0]])).status,400);
  assert.equal((await copy([{...slots[0],start:sourceSecond}])).status,400);
  const baseline=await limits();
  for(const stale of [[{...slots[0],sourceRevision:0},slots[1]],[slots[0],{...slots[1],revision:0}]]){
    assert.equal((await copy(stale)).status,409);
    assert.deepEqual(await limits(),baseline);
  }
  now=first-29*60_000;
  assert.equal((await copy(slots)).status,409);
  now=first-50*60_000;
  assert.equal((await history()).events.length,1);
  const [one,two]=await Promise.all([copy(slots),copy(slots)]);
  assert.deepEqual([one.status,two.status].sort(),[200,409]);
  assert.deepEqual(await (one.ok?one:two).json(),{date,sourceDate,slots:[
    {start:first,capacity:null,revision:2},{start:second,capacity:0,revision:1},
  ]});
  const after=await limits();
  assert.deepEqual(after.intake,baseline.intake);
  assert.deepEqual(after.slots.find(slot=>slot.start===second),{start:second,end:second+900_000,capacity:0,used:2,remaining:0,revision:1,editable:true});
  assert.equal((await get("ticket",{"X-Ticket":token})).pickupSlot,second);
  const {events}=await history();
  assert.deepEqual(events[0],{id:2,kind:"batch",sourceDate,changedAt:now,changes:[
    {start:first,previousCapacity:5,capacity:null,revision:2},{start:second,previousCapacity:null,capacity:0,revision:1},
  ]});
  assert.equal((await copy([{...slots[0],revision:1},{...slots[1],revision:2}])).status,409);
  const restored=await send("kitchen/pickup-slots/restore",{date,fromId:events[0].id,slots:events[0].changes});
  assert.deepEqual(await restored.json(),{date,restoredFromId:2,slots:[
    {start:first,capacity:5,revision:3},{start:second,capacity:null,revision:2},
  ]});
  assert.equal((await get("kitchen/pickup-slots?date="+sourceDate)).slots.find(slot=>slot.start===sourceSecond).capacity,0);
});

test("authorized staff can close, raise and reset an individual slot without displacing bookings",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const date="2026-11-25",tomorrow="2026-11-26";
  const taipei=(time,day=date)=>Date.parse(day+"T"+time+"+08:00");
  let now=taipei("10:45:00");
  const first=taipei("12:00:00"),other=taipei("12:30:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff",TAPPAY_MODE:"demo"};
  const staff={Authorization:"Bearer fixture-staff"},endpoint="/api/kitchen/pickup-slots";
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const send=(method,path,data,headers={})=>call(path,{method,headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const save=(start,capacity,revision,day=date,headers=staff)=>send("PATCH",endpoint,{date:day,start,capacity,revision},headers);
  const snapshot=async(day=date)=>(await (await call(endpoint+"?date="+day,{headers:staff})).json()).slots;
  const publicSlot=async start=>(await (await call("/api/pickup-slots")).json()).slots.find(slot=>slot.start===start);
  const booking=(pickupSlot,qty)=>({token:crypto.randomUUID(),mode:"pickup",note:"",items:[{id:"sencha",qty}],pickupSlot});
  const post=data=>send("POST","/api/orders",data);
  const existing=booking(first,3),incoming=booking(other,2);
  assert.equal((await call(endpoint+"?date="+date)).status,403);
  assert.equal((await save(first,1,0,date,{})).status,403);
  assert.equal((await save(first,-1,0)).status,400);
  assert.equal((await save(first+1,1,0)).status,400);
  assert.equal((await save(taipei("11:00:00"),2,0)).status,409);
  assert.equal((await snapshot()).find(slot=>slot.start===first).remaining,12);
  const accepted=await (await post(existing)).json(),move=await (await post(incoming)).json();
  assert.equal((await save(first,0,0)).status,200);
  assert.deepEqual((await snapshot()).find(slot=>slot.start===first),
    {start:first,end:first+900_000,used:3,remaining:0,capacity:0,revision:1,editable:true});
  assert.deepEqual(await (await post(existing)).json(),accepted);
  assert.equal((await post(booking(first,1))).status,409);
  const shift=()=>send("POST","/api/ticket/reschedule",{from:other,to:first,revision:0},{"X-Ticket":incoming.token});
  assert.equal((await (await shift()).json()).code,"pickup_slot_full");
  assert.equal((await publicSlot(other)).remaining,10);
  assert.equal((await save(first,5,1)).status,200);
  assert.equal((await (await shift()).json()).pickupSlot,first);
  assert.equal((await publicSlot(first)).remaining,0);
  assert.equal((await publicSlot(other)).remaining,12);
  assert.equal((await (await call("/api/ticket",{headers:{"X-Ticket":incoming.token}})).json()).id,move.id);
  assert.equal((await save(first,null,2)).status,200);
  assert.equal((await publicSlot(first)).remaining,7);
  const following=taipei("12:00:00",tomorrow);
  assert.equal((await save(following,0,0,tomorrow)).status,200);
  assert.equal((await snapshot(tomorrow)).find(slot=>slot.start===following).remaining,0);
  assert.equal(await publicSlot(following),undefined);
  now=taipei("11:30:00")+1;
  assert.equal((await snapshot()).find(slot=>slot.start===first).editable,false);
  assert.equal((await save(first,6,3)).status,409);
});
test("receipt calendar hides checkout details and follows confirmed, moved and cancelled pickup windows",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const taipei=time=>Date.parse("2026-11-25T"+time+"+08:00");
  let now=taipei("10:15:00");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,TAPPAY_MODE:"demo"};
  const token=crypto.randomUUID(),wallet=crypto.randomUUID(),immediate=crypto.randomUUID();
  const first=taipei("12:00:00"),next=taipei("12:15:00");
  const endpoint="/api/ticket/calendar";
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const send=(path,data,ticket)=>call(path,{method:"POST",headers:{"Content-Type":"application/json",...(ticket?{"X-Ticket":ticket}:{})},body:JSON.stringify(data)});
  const calendar=ticket=>call(endpoint,{headers:ticket?{"X-Ticket":ticket}:{}});
  const booking=(ticket,paymentMethod="cash",pickupSlot=first)=>({token:ticket,paymentMethod,pickupSlot,mode:"pickup",
    note:"private-order-note",items:[{id:"sencha",qty:1,note:"private-dish-note"}]});
  assert.equal((await calendar()).status,404);
  assert.equal((await calendar(crypto.randomUUID())).status,404);
  assert.equal((await send("/api/orders",booking(immediate,"cash",null))).status,200);
  assert.equal((await calendar(immediate)).status,404);
  assert.equal((await send("/api/orders",booking(wallet,"line_pay"))).status,200);
  assert.equal((await calendar(wallet)).status,409);
  const {attempt}=await (await send("/api/payments/start",{},wallet)).json();
  assert.equal((await send("/api/payments/demo",{ref:attempt.ref,outcome:"paid"},wallet)).status,200);
  const paid=await calendar(wallet);
  assert.equal(paid.status,200);
  assert.match(await paid.text(),/STATUS:CONFIRMED/);

  const receipt=await (await send("/api/orders",booking(token))).json();
  const before=await calendar(token);
  assert.equal(before.status,200);
  assert.equal(before.headers.get("Content-Type"),"text/calendar; charset=utf-8");
  assert.equal(before.headers.get("Cache-Control"),"private, no-store");
  assert.equal(before.headers.get("Content-Disposition"),`attachment; filename="hey-table-pickup-${String(receipt.id).padStart(4,"0")}.ics"`);
  const unfolded=text=>text.replace(/\r\n /g,"");
  const field=(text,name)=>unfolded(text).split("\r\n").find(line=>line.startsWith(name+":"))?.slice(name.length+1);
  const raw=await before.text(),uid=field(raw,"UID");
  assert.match(uid,/^[a-f0-9]{64}@hey-table\.invalid$/);
  for(const value of [token,"private-order-note","private-dish-note","日式熱煎茶","X-Ticket","NT$","example"])
    assert.ok(!raw.includes(value),value);
  assert.equal(field(raw,"DTSTART"),"20261125T040000Z");
  assert.equal(field(raw,"DTEND"),"20261125T041500Z");
  assert.equal(field(raw,"SEQUENCE"),"0");
  assert.equal(field(raw,"STATUS"),"CONFIRMED");
  assert.equal(await (await calendar(token)).text(),raw);

  now+=5*60_000;
  assert.equal((await send("/api/ticket/reschedule",{from:first,to:next,revision:0},token)).status,200);
  const moved=await (await calendar(token)).text();
  assert.equal(field(moved,"UID"),uid);
  assert.equal(field(moved,"DTSTART"),"20261125T041500Z");
  assert.equal(field(moved,"DTSTAMP"),"20261125T022000Z");
  assert.equal(field(moved,"SEQUENCE"),"1");

  now+=5*60_000;
  assert.equal((await send("/api/ticket/cancel",{},token)).status,200);
  const cancelled=await (await calendar(token)).text();
  assert.equal(field(cancelled,"UID"),uid);
  assert.equal(field(cancelled,"DTSTART"),field(moved,"DTSTART"));
  assert.equal(field(cancelled,"DTSTAMP"),"20261125T022500Z");
  assert.equal(field(cancelled,"SEQUENCE"),"2");
  assert.equal(field(cancelled,"STATUS"),"CANCELLED");
});
test("kitchen overdue uses the current stage and starts online orders at confirmed payment",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const minute=60_000,initial=Date.parse("2026-11-25T02:00:00Z");
  let now=initial;
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"fixture-staff",TAPPAY_MODE:"demo"};
  const staff={Authorization:"Bearer fixture-staff"};
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const send=(method,path,data,headers={})=>call(path,{method,headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const queue=async()=>{
    const response=await call("/api/kitchen",{headers:staff});
    assert.equal(response.status,200);
    return new Map((await response.json()).map(row=>[row.id,row.overdue]));
  };
  const add=db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,status,status_history,payment_method,payment_env)
    VALUES (?,'pickup','','[]',45,?,?,?,?,?)`);
  const fixture=(at,status="pending",history=null,payment="cash")=>add.run(crypto.randomUUID(),at,status,history,payment,payment==="cash"?"cash":"sandbox").lastInsertRowid;
  const event=(from,status,at)=>JSON.stringify([{from,status,at}]);
  const justDue=fixture(now-5*minute),early=fixture(now-5*minute+1);
  const cooking=fixture(now-28*minute,"preparing",event("pending","preparing",now-15*minute-1));
  const ready=fixture(now-35*minute,"ready",event("preparing","ready",now-10*minute));
  const oldCooking=fixture(now-90*minute,"preparing"),badReady=fixture(now-19*minute,"ready","broken-history");
  const afterOrder=fixture(now-9*minute,"ready",event("preparing","ready",now-11*minute));
  const closed=fixture(now-90*minute,"completed",event("ready","completed",now-33*minute));
  const oldPaid=fixture(now-30*minute,"pending",null,"line_pay");
  db.sqlite.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,state,created,checked)
    VALUES (?,'legacy-payment','fixture','paid',?,?)`).run(oldPaid,now-29*minute,now-25*minute);
  const token=crypto.randomUUID(),guest={"X-Ticket":token};
  const open=await send("POST","/api/orders",{token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod:"line_pay"});
  assert.equal(open.status,200);
  const {id}=await open.json();

  assert.equal((await call("/api/kitchen")).status,403);
  const boundary=await queue();
  assert.deepEqual(boundary.get(justDue),{elapsedMs:5*minute,overByMs:0});
  assert.deepEqual(boundary.get(cooking),{elapsedMs:15*minute+1,overByMs:1});
  assert.deepEqual(boundary.get(ready),{elapsedMs:10*minute,overByMs:0});
  for(const ignored of [early,oldCooking,badReady,afterOrder,closed,oldPaid,id]){
    assert.ok(boundary.has(ignored));
    assert.equal(boundary.get(ignored),undefined);
  }
  now=initial+8*minute;
  assert.equal((await queue()).get(id),undefined);
  const {attempt}=await (await send("POST","/api/payments/start",{},guest)).json();
  now=initial+11*minute;
  assert.equal((await queue()).get(id),undefined);
  assert.equal((await send("POST","/api/payments/demo",{ref:attempt.ref,outcome:"paid"},guest)).status,200);
  now=initial+16*minute-1;
  assert.equal((await queue()).get(id),undefined);
  now++;
  assert.deepEqual((await queue()).get(id),{elapsedMs:5*minute,overByMs:0});
  const receipt=await (await call("/api/ticket?progress=1",{headers:guest})).json();
  assert.equal(receipt.overdue,undefined);
  assert.equal(receipt.kitchen_payable_at,undefined);
  assert.equal((await send("PATCH","/api/kitchen/status",{id,from:"pending",to:"preparing"},staff)).status,200);
  assert.equal((await queue()).get(id),undefined);
});
test("unpaid holds release at the boundary but preserve active payment attempts",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  let now=Date.parse("2026-11-25T02:00:00Z");
  t.mock.method(Date,"now",()=>now);
  const runtime={DB:db,STAFF_KEY:"local-test-key",TAPPAY_MODE:"demo"};
  const call=(path,options={})=>api(new Request("https://order.example"+path,options),runtime);
  const post=(path,data,headers={})=>call(path,{method:"POST",
    headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const getTicket=token=>call("/api/ticket?progress=1",{headers:{"X-Ticket":token}}).then(response=>response.json());
  const order=(token,paymentMethod="line_pay")=>({token,mode:"pickup",note:"",items:[{id:"sencha",qty:1}],paymentMethod});
  const cap=db.sqlite.prepare("INSERT INTO daily_portion_limits(date,dish,capacity,revision) VALUES ('2026-11-25','sencha',1,1)");
  cap.run();
  const old=crypto.randomUUID(),challenger=crypto.randomUUID();
  assert.equal((await post("/api/orders",order(old))).status,200);
  const due=now+15*60*1000;
  assert.equal((await getTicket(old)).paymentDueAt,due);
  now=due-1;
  assert.equal((await post("/api/orders",order(challenger))).status,409);
  now=due;
  assert.equal((await post("/api/orders",order(challenger))).status,200);
  const expired=await getTicket(old);
  assert.equal(expired.status,"cancelled");
  assert.deepEqual(expired.statusHistory.at(-1),{status:"cancelled",at:due,actor:"payment_expiry"});
  assert.equal((await post("/api/payments/start",{},{ "X-Ticket":old })).status,409);
  assert.deepEqual((await getTicket(old)).statusHistory,expired.statusHistory);

  const activeHeaders={"X-Ticket":challenger};
  now=due+15*60*1000-1;
  const {attempt}=await (await post("/api/payments/start",{},activeHeaders)).json();
  assert.equal(attempt.state,"pending");
  now+=1000;
  const menu=await (await call("/api/menu")).json();
  assert.equal(menu.remaining.sencha,0);
  assert.equal((await getTicket(challenger)).status,"pending");
  assert.equal((await (await post("/api/payments/start",{},activeHeaders)).json()).attempt.ref,attempt.ref);
  assert.equal((await post("/api/payments/demo",{ref:attempt.ref,outcome:"failed"},activeHeaders)).status,200);
  const cash=crypto.randomUUID();
  assert.equal((await post("/api/orders",order(cash,"cash"))).status,200);
  assert.equal((await getTicket(challenger)).statusHistory.at(-1).actor,"payment_expiry");
  assert.equal((await getTicket(cash)).paymentDueAt,undefined);

  const legacy=crypto.randomUUID();
  db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,payment_method,payment_env)
    VALUES (?,'pickup','','[]',45,1,'line_pay','demo')`).run(legacy);
  assert.equal((await getTicket(legacy)).status,"pending");
  assert.equal((await (await post("/api/payments/start",{},{"X-Ticket":legacy})).json()).attempt.state,"pending");
});

test("payment start cannot claim a hold that expires after it reads the order",async t=>{
  const db=database();
  t.after(()=>db.sqlite.close());
  const due=Date.parse("2026-11-25T02:15:00Z"),token=crypto.randomUUID();
  let now=due-1;
  t.mock.method(Date,"now",()=>now);
  db.sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,payment_method,payment_env,payment_due_at)
    VALUES (?,'pickup','','[]',45,?,'line_pay','demo',?)`).run(token,due-15*60*1000,due);
  const boundary={...db,prepare(sql){
    if(sql.startsWith("SELECT * FROM payment_attempts WHERE order_id="))now=due;
    return db.prepare(sql);
  }};
  const result=await api(new Request("https://order.example/api/payments/start",{method:"POST",
    headers:{"Content-Type":"application/json","X-Ticket":token},body:"{}"}),{DB:boundary,TAPPAY_MODE:"demo"});
  assert.equal(result.status,409);
  assert.equal(db.sqlite.prepare("SELECT status FROM orders WHERE token=?").get(token).status,"cancelled");
  assert.equal(db.sqlite.prepare("SELECT count(*) AS count FROM payment_attempts").get().count,0);
});
for(const method of ["line_pay","px_pay_plus"]){
  test(method+" resolves a lost charge reply with the original bank reference",async t=>{
    const db=database();
    t.after(()=>db.sqlite.close());
    const runtime={...env,DB:db,["TAPPAY_MERCHANT_"+method.toUpperCase()]:"fixture"};
    const token=crypto.randomUUID();
    async function post(path,body){
      const response=await api(new Request("https://order.example/api/"+path,{method:"POST",
        headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body)}),runtime);
      assert.equal(response.status,200);
      return response.json();
    }
    const order=await post("orders",{token,mode:"pickup",note:"",items:[{id:"oyakodon",qty:1}],paymentMethod:method});
    const charges=[],queries=[];
    t.mock.method(globalThis,"fetch",async(url,init)=>{
      const body=JSON.parse(init.body);
      if(url.endsWith("/pay-by-prime")){
        charges.push(body);
        throw new TypeError("connection lost after gateway acceptance");
      }
      queries.push(body.filters);
      return Response.json({status:0,trade_records:queries.length===1?[]:[{
        rec_trade_id:"recovered-trade",merchant_id:"fixture",payment_method:method,currency:"TWD",
        bank_transaction_id:charges[0].bank_transaction_id,original_amount:order.total,record_status:1
      }]});
    });
    const body={prime:"fixture-prime",buyer:{name:"測試",email:"qa@example.test",phone_number:"0900000000"}};
    const {attempt}=await post("payments/start",body);
    assert.deepEqual(attempt,{ref:charges[0].bank_transaction_id,state:"pending",redirect:null});
    assert.deepEqual((await post("payments/check",{})).attempt,attempt);
    const replays=await Promise.all(Array.from({length:8},()=>post("payments/start",body)));
    assert.ok(replays.every(replay=>replay.attempt.ref===attempt.ref));
    db.sqlite.exec("UPDATE payment_attempts SET checked=0");
    const recovered=(await post("payments/check",{})).attempt;
    assert.deepEqual(recovered,{...attempt,state:"paid"});
    assert.equal(queries.length,2);
    assert.ok(queries.every(filters=>filters.bank_transaction_id===attempt.ref));
    assert.equal(charges.length,1);
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM payment_attempts").get().n,1);
  });
}
for(const method of ["line_pay","px_pay_plus","jko_pay","easy_wallet","pi_wallet","plus_pay","card"]){
  test(method+" follows sandbox charge, verified notification and out-of-order result",async t=>{
    const db=database();t.after(()=>db.sqlite.close());
    let now=Date.now();
    t.mock.method(Date,"now",()=>now);
    const runtime={...env,DB:db,["TAPPAY_MERCHANT_"+method.toUpperCase()]:"fixture"};
    const token=crypto.randomUUID();
    async function post(path,body){
      const req=new Request("https://order.example/api/"+path,{method:"POST",
        headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body)});
      return api(req,runtime);
    }
    const items=[{id:"katsudon",qty:1,price:1},{id:"sencha",qty:2,price:0}];
    const ticket=await (await post("orders",{token,mode:"pickup",note:"",items,paymentMethod:method})).json();
    assert.equal(ticket.total,280);
    const gatewayMethod=method==="card"?"direct_pay":method;
    let reference,chargeCount=0,recordStatus=4,reportedMethod=gatewayMethod;
    t.mock.method(globalThis,"fetch",async(url,init)=>{
      assert.equal(init.headers["x-api-key"],env.TAPPAY_PARTNER_KEY);
      const body=JSON.parse(init.body);assert.equal(body.partner_key,env.TAPPAY_PARTNER_KEY);
      if(url.endsWith("/pay-by-prime")){
        chargeCount++;assert.equal(body.prime,"fixture-prime");assert.equal(body.merchant_id,"fixture");
        assert.equal(body.amount,ticket.total);assert.equal(body.currency,"TWD");
        if(method==="pi_wallet")assert.deepEqual(JSON.parse(body.details),[
          {item_name:"滑蛋豬排丼",item_quantity:1,item_price:190},
          {item_name:"日式熱煎茶",item_quantity:2,item_price:45}]);
        if(method==="line_pay")assert.equal(body.details,"katsudonX1AndsenchaX2");
        assert.equal(body.three_domain_secure,method==="card"?true:undefined);
        reference=body.bank_transaction_id;
        assert.match(reference,/^[A-Z0-9]{19}$/);assert.equal(reference,body.order_number);
        assert.equal(body.result_url.frontend_redirect_url,"https://order.example/ticket?payment="+reference);
        assert.equal(body.result_url.backend_notify_url,runtime.TAPPAY_NOTIFY_URL);
        assert.ok(!JSON.stringify(body).includes(token));
        return Response.json({status:0,rec_trade_id:"trade1",payment_url:"https://wallet.example/verify"});
      }
      assert.equal(url,"https://sandbox.tappaysdk.com/tpc/transaction/query");
      assert.deepEqual(body.filters.merchant_id,["fixture"]);assert.equal(body.filters.currency,"TWD");
      assert.equal(body.filters.bank_transaction_id,reference);
      return Response.json({status:0,trade_records:[{merchant_id:"fixture",rec_trade_id:"trade1",bank_transaction_id:reference,
        payment_method:reportedMethod,amount:ticket.total,record_status:recordStatus}]});
    });
    const body={prime:"fixture-prime",amount:1,buyer:{name:"測試",email:"qa@example.test",phone_number:"0900000000"}};
    const a=await (await post("payments/start",body)).json();
    assert.equal(a.attempt.redirect,"https://wallet.example/verify");assert.equal(a.attempt.state,"pending");
    await post("payments/start",body);assert.equal(chargeCount,1);
    assert.equal((await post("payments/demo",{ref:reference,outcome:"paid"})).status,403);
    const check=async n=>{recordStatus=n;db.sqlite.exec("UPDATE payment_attempts SET checked=0");
      await post("payments/notify",{bank_transaction_id:reference,status:0});
      return (await (await post("payments/check",{})).json()).attempt.state;};
    reportedMethod=method==="px_pay_plus"?"plus_pay":"px_pay_plus";
    assert.equal(await check(1),"pending");
    reportedMethod=gatewayMethod;
    const payableAt=()=>db.sqlite.prepare("SELECT kitchen_payable_at FROM payment_attempts WHERE order_id=?").get(ticket.id).kitchen_payable_at;
    assert.equal(await check(4),"pending");
    assert.equal(payableAt(),null);
    now+=6000;
    assert.equal(await check(0),"authorized");
    const firstConfirmed=now;
    assert.equal(payableAt(),firstConfirmed);
    now+=6000;
    assert.equal(await check(1),"paid");assert.equal(await check(4),"paid");assert.equal(await check(3),"refunded");
    assert.equal(payableAt(),firstConfirmed);
  });
}
