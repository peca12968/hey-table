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
import {sqliteD1} from "../scripts/sqlite-d1.mjs";
import {applyDemoMigrations} from "../scripts/apply-demo-migrations.mjs";
import {bookablePickupSlots} from "../lib/pickup-slots.mjs";

const env={TAPPAY_MODE:"sandbox",TAPPAY_APP_ID:"123",TAPPAY_APP_KEY:"test-public",TAPPAY_PARTNER_KEY:"test-only",
  TAPPAY_SITE_ORIGIN:"https://order.example",TAPPAY_NOTIFY_URL:"https://notify.example/api/payments/notify"};
const ref="H0123456789ABCDEF00";
const attempt={reference:ref,created:Date.now(),merchant:"fixture",trade_id:"known"};
const data={bank_transaction_id:ref,rec_trade_id:"known",merchant_id:"fixture",payment_method:"px_pay_plus",original_amount:190};
const order={total:190,payment_method:"px_pay_plus"};
const reply=record=>async()=>Response.json({status:0,trade_records:[record]});
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
test("receipt timing drops completed station work and legacy items still reach the board",async t=>{
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
  assert.deepEqual((await read()).kitchenQuote.seconds,[300,420]);
  assert.equal((await cook(id,"hot")).status,200);
  assert.deepEqual((await read()).kitchenQuote.seconds,[60,90]);
  assert.equal((await cook(id,"bar")).status,200);
  assert.equal((await read()).status,"ready");
  assert.equal((await read()).kitchenQuote,undefined);

  const {lastInsertRowid:older}=insert.run(crypto.randomUUID(),JSON.stringify([{id:"old-tofu",name:"舊菜單豆腐",qty:1,price:60}]),1);
  const board=await api(new Request("https://order.example/api/kitchen/station-work?station=other",{
    headers:{Authorization:"Bearer local-test-key"},
  }),runtime);
  assert.deepEqual((await board.json()).orders,[{id:older,table:null,note:"",created:1,
    items:[{id:"old-tofu",name:"舊菜單豆腐",qty:1}],doneAt:null,doneStations:0,stations:1}]);
  assert.equal((await (await cook(older,"other")).json()).status,"ready");
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
test("the Worker and D1 enforce pickup capacity and serialize conflicting reschedules",async t=>{
  const {build}=await import("esbuild");
  const {Miniflare}=await import("miniflare");
  const root=fileURLToPath(new URL("../",import.meta.url));
  const bundle=await build({stdin:{resolveDir:root,contents:`
    import {api} from './server/api.mjs';
    Date.now=()=>Date.parse('2026-11-25T10:45:00+08:00');
    export default {fetch:api};`},bundle:true,format:"esm",write:false});
  const worker=new Miniflare({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-05-15",
    host:"127.0.0.1",d1Databases:["DB"]});
  t.after(()=>worker.dispose());
  await applyDemoMigrations(await worker.getD1Database("DB"),root);
  const host=(await worker.ready).origin;
  const pickupSlot=Date.parse("2026-11-25T12:00:00+08:00");
  const requests=Array.from({length:8},()=>({token:crypto.randomUUID(),mode:"pickup",note:"",items:[{id:"sencha",qty:3}],pickupSlot}));
  const post=(path,data,headers={})=>fetch(host+path,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(data)});
  const responses=await Promise.all(requests.map(data=>post("/api/orders",data)));
  assert.deepEqual(responses.map(response=>response.status).sort(),[200,200,200,200,409,409,409,409]);
  const results=await Promise.all(responses.map(response=>response.json()));
  assert.equal(new Set(results.filter(result=>result.pickupSlot===pickupSlot).map(result=>result.id)).size,4);
  assert.equal(results.filter(result=>result.code==="pickup_slot_full").length,4);
  const remaining=async start=>(await fetch(host+"/api/pickup-slots").then(response=>response.json())).slots.find(slot=>slot.start===start).remaining;
  assert.equal(await remaining(pickupSlot),0);
  const index=responses.findIndex(response=>response.ok),original=requests[index];
  const targets=[pickupSlot+900_000,pickupSlot+1_800_000];
  const reschedule=to=>post("/api/ticket/reschedule",{from:pickupSlot,to,revision:0},{"X-Ticket":original.token});
  const moved=await Promise.all(targets.map(reschedule));
  assert.deepEqual(moved.map(response=>response.status).sort(),[200,409]);
  const winner=moved.findIndex(response=>response.ok),changed=await moved[winner].json();
  assert.equal(changed.pickupSlot,targets[winner]);
  assert.equal(changed.pickupChanges.length,1);
  assert.deepEqual(await (await reschedule(changed.pickupSlot)).json(),changed);
  assert.equal(await remaining(pickupSlot),3);
  assert.equal(await remaining(changed.pickupSlot),9);
  assert.equal(await remaining(targets[1-winner]),12);
  assert.deepEqual(await (await post("/api/orders",original)).json(),{...results[index],pickupSlot:changed.pickupSlot});
  assert.equal((await post("/api/orders",{...original,pickupSlot:changed.pickupSlot})).status,409);
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
  assert.equal((await send("POST","/api/kitchen/create-pickup",order(1,{expectedTotal:45}),staff)).status,400);
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
test("pickup rescheduling preserves payment and requires staff to use the new version",async t=>{
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
  const ticket=async()=> (await call("/api/ticket?progress=1",{headers:guest})).json();
  const advance=pickupRevision=>send("PATCH","/api/kitchen/status",{id:original.id,from:"pending",to:"preparing",pickupRevision},staff);
  assert.equal(await (await ticket()).canReschedulePickup,true);
  assert.equal((await shift(first,next,0,{})).status,404);
  assert.equal((await shift(first,next,0,{"X-Ticket":crypto.randomUUID()})).status,404);
  const {attempt}=await (await send("POST","/api/payments/start",{},guest)).json();
  assert.equal((await send("POST","/api/payments/demo",{ref:attempt.ref,outcome:"paid"},guest)).status,200);
  const paid=await ticket();
  assert.equal((await post(booking(full,9))).status,200);
  const blocked=await shift(first,full);
  assert.equal(blocked.status,409);
  assert.equal((await blocked.json()).code,"pickup_slot_full");
  assert.deepEqual(await ticket(),paid);
  const newTime=await (await shift(first,next)).json();
  assert.deepEqual(newTime,{pickupSlot:next,pickupChanges:[{from:first,to:next,at:now}],canReschedulePickup:true});
  assert.deepEqual(await ticket(),{...paid,...newTime});
  const payment=await (await send("POST","/api/payments/check",{},guest)).json();
  assert.equal(payment.attempt.ref,attempt.ref);
  assert.equal(payment.attempt.state,"paid");

  now=taipei("12:00:00");
  assert.equal((await ticket()).canReschedulePickup,false);
  assert.equal((await shift(next,taipei("13:00:00"),1)).status,409);
  assert.equal((await advance(0)).status,409);
  assert.equal((await advance()).status,409);
  const board=await (await call("/api/kitchen",{headers:staff})).json();
  assert.equal(board.find(row=>row.id===original.id).pickupRevision,1);
  assert.equal((await advance(1)).status,200);
  assert.equal((await ticket()).status,"preparing");
  assert.deepEqual(await (await shift(first,next)).json(),{...newTime,canReschedulePickup:false});
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
