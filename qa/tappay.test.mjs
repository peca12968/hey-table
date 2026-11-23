import test from "node:test";
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync} from "node:fs";
import {api} from "../server/api.mjs";
import {settings,lookup} from "../server/tappay.mjs";

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
});
test("match payment, merchant, currency filter, original amount and trade before accepting a record",async()=>{
  for(const [code,state] of [[-1,"failed"],[0,"authorized"],[1,"paid"],[2,"partial"],[3,"refunded"],[4,"pending"],[5,"cancelled"]]){
    assert.deepEqual(await lookup(env,order,attempt,reply({...data,record_status:code})),{state,trade:"known"});
  }
  for(const override of [{currency:"USD"},{original_amount:1},{merchant_id:"other"},{bank_transaction_id:"wrong"},{payment_method:"line_pay"},{rec_trade_id:"other"},{record_status:99}]){
    assert.equal(await lookup(env,order,attempt,reply({...data,record_status:1,...override})),null);
  }
});
function database(){
  const sqlite=new DatabaseSync(":memory:");
  const journal=JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json",import.meta.url)));
  for(const {tag} of journal.entries)sqlite.exec(readFileSync(new URL("../drizzle/"+tag+".sql",import.meta.url),"utf8"));
  return {sqlite,prepare(sql){const stmt=sqlite.prepare(sql);return {bind(...args){return {
    first:()=>stmt.get(...args),run:()=>({meta:stmt.run(...args)}),all:()=>({results:stmt.all(...args)})};}};}};
}
for(const method of ["line_pay","px_pay_plus","jko_pay","card"]){
  test(method+" follows sandbox charge, verified notification and out-of-order result",async t=>{
    const db=database();t.after(()=>db.sqlite.close());
    const runtime={...env,DB:db,["TAPPAY_MERCHANT_"+method.toUpperCase()]:"fixture"};
    const token=crypto.randomUUID();
    async function post(path,body){
      const req=new Request("https://order.example/api/"+path,{method:"POST",
        headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify(body)});
      return api(req,runtime);
    }
    const item={id:"katsudon",qty:1};
    const ticket=await (await post("orders",{token,mode:"pickup",note:"",items:[item],paymentMethod:method})).json();
    let reference,chargeCount=0,recordStatus=4;
    t.mock.method(globalThis,"fetch",async(url,init)=>{
      assert.equal(init.headers["x-api-key"],env.TAPPAY_PARTNER_KEY);
      const body=JSON.parse(init.body);assert.equal(body.partner_key,env.TAPPAY_PARTNER_KEY);
      if(url.endsWith("/pay-by-prime")){
        chargeCount++;assert.equal(body.prime,"fixture-prime");assert.equal(body.merchant_id,"fixture");
        assert.equal(body.amount,ticket.total);assert.equal(body.currency,"TWD");
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
        payment_method:method==="card"?"direct_pay":method,amount:ticket.total,record_status:recordStatus}]});
    });
    const body={prime:"fixture-prime",amount:1,buyer:{name:"測試",email:"qa@example.test",phone_number:"0900000000"}};
    const a=await (await post("payments/start",body)).json();
    assert.equal(a.attempt.redirect,"https://wallet.example/verify");assert.equal(a.attempt.state,"pending");
    await post("payments/start",body);assert.equal(chargeCount,1);
    assert.equal((await post("payments/demo",{ref:reference,outcome:"paid"})).status,403);
    const check=async n=>{recordStatus=n;db.sqlite.exec("UPDATE payment_attempts SET checked=0");
      await post("payments/notify",{bank_transaction_id:reference,status:0});
      return (await (await post("payments/check",{})).json()).attempt.state;};
    assert.equal(await check(4),"pending");assert.equal(await check(0),"authorized");
    assert.equal(await check(1),"paid");assert.equal(await check(4),"paid");assert.equal(await check(3),"refunded");
  });
}
