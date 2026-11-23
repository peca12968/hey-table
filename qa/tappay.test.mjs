import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {api} from "../server/api.mjs";
import {settings,lookup} from "../server/tappay.mjs";
import {paymentPrime,openPaymentUrl} from "../lib/tappay-client.mjs";

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
  return {sqlite,prepare(sql){const stmt=sqlite.prepare(sql);return {bind(...args){return {
    first:()=>stmt.get(...args),run:()=>({meta:stmt.run(...args)}),all:()=>({results:stmt.all(...args)})};}};}};
}
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
    assert.equal(await check(4),"pending");assert.equal(await check(0),"authorized");
    assert.equal(await check(1),"paid");assert.equal(await check(4),"paid");assert.equal(await check(3),"refunded");
  });
}
