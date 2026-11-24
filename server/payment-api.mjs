import {charge,httpsUrl,lookup,merchantFor,settings,validBuyer} from "./tappay.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";
import {kitchenPaymentStates} from "../lib/payments.mjs";

export const latestState = "(SELECT state FROM payment_attempts WHERE order_id=orders.id ORDER BY id DESC LIMIT 1)";
export const payableForKitchen = "(payment_method='cash' OR "+latestState+" IN ("+kitchenPaymentStates.map(state=>"'"+state+"'").join(",")+"))";
const result=(data,status=200)=>Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
const fail=(msg,status)=>result({error:msg},status);
const publicAttempt=a=>a&&({ref:a.reference,state:a.state,redirect:a.state==="pending"?a.redirect_url:null});
const latest=(db,id)=>db.prepare("SELECT * FROM payment_attempts WHERE order_id=? ORDER BY id DESC LIMIT 1").bind(id).first();
const transitions={pending:["pending","authorized","paid","failed","cancelled","partial","refunded"],
  authorized:["authorized","paid","cancelled","partial","refunded"],paid:["paid","partial","refunded"],partial:["partial","refunded"]};
async function reconcile(env,order,a) {
  if(!a || order.payment_env==="demo" || env.TAPPAY_MODE!==order.payment_env || !transitions[a.state])return;
  const updated=await env.DB.prepare("UPDATE payment_attempts SET checked=? WHERE id=? AND checked<?")
    .bind(Date.now(),a.id,Date.now()-5000).run();
  if(!updated.meta.changes)return;
  const verified=await lookup(env,order,a);
  if(verified && transitions[a.state].includes(verified.state)){
    const firstPayable=!kitchenPaymentStates.includes(a.state)&&kitchenPaymentStates.includes(verified.state);
    await env.DB.prepare(`UPDATE payment_attempts SET state=?, trade_id=?,
      redirect_url=CASE WHEN ?='pending' THEN redirect_url ELSE NULL END,
      kitchen_payable_at=COALESCE(kitchen_payable_at,?) WHERE id=? AND state=?`)
      .bind(verified.state,verified.trade,verified.state,firstPayable?Date.now():null,a.id,a.state).run();
  }
}
export async function checkKitchenPayment(env,id) {
  if(!Number.isSafeInteger(id))return fail("訂單編號無效",400);
  const order=await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
  if(!order || order.payment_method==="cash")return fail("找不到線上付款餐單",404);
  try{await reconcile(env,order,await latest(env.DB,id));}catch{return fail("無法查詢金流，請稍後再查",503);}
  return result({ok:true});
}
export async function paymentApi(path,request,env,input) {
  const db=env.DB;
  if(path==="/api/payments/notify"){
    const ref=input.bank_transaction_id || input.order_number;
    let a;
    if(typeof ref==="string" && /^[A-Z0-9]{19}$/.test(ref))
      a=await db.prepare("SELECT * FROM payment_attempts WHERE reference=?").bind(ref).first();
    else if(typeof input.rec_trade_id==="string" && input.rec_trade_id.length<=100)
      a=await db.prepare("SELECT * FROM payment_attempts WHERE trade_id=?").bind(input.rec_trade_id).first();
    if(a){
      const order=await db.prepare("SELECT * FROM orders WHERE id=?").bind(a.order_id).first();
      try{
        await reconcile(env,order,a);
        if(order.payment_env!=="demo" && (await db.prepare("SELECT state FROM payment_attempts WHERE id=?").bind(a.id).first()).state==="pending")
          return fail("交易尚待確認",503);
      }catch{return fail("金流查詢暫時無法完成",503);}
    }
    return result({ok:true});
  }
  const token=request.headers.get("X-Ticket");
  if(!token || token.length!==36)return fail("找不到餐單",404);
  if(path==="/api/payments/start")await expirePaymentHolds(db,Date.now(),token).run();
  const order=await db.prepare("SELECT * FROM orders WHERE token=?").bind(token).first();
  if(!order || order.payment_method==="cash")return fail("找不到線上付款餐單",404);
  let attempt=await latest(db,order.id);
  if(path==="/api/payments/check"){
    try{await reconcile(env,order,attempt);}catch{return fail("無法查詢金流，請稍後再查",503);}
    return result({attempt:publicAttempt(await latest(db,order.id))});
  }
  if(order.status!=="pending")return fail("餐單已更新",409);
  if(path==="/api/payments/demo"){
    if(order.payment_env!=="demo" || settings(env).mode!=="demo" || !attempt || input.ref!==attempt.reference ||
      !["paid","failed","cancelled"].includes(input.outcome))return fail("無法模擬此付款",403);
    const res=await db.prepare("UPDATE payment_attempts SET state=?, kitchen_payable_at=? WHERE id=? AND state='pending'")
      .bind(input.outcome,input.outcome==="paid"?Date.now():null,attempt.id).run();
    return res.meta.changes ? result({attempt:publicAttempt(await latest(db,order.id))}) : fail("付款已更新",409);
  }
  if(path!=="/api/payments/start")return fail("找不到此操作",404);
  if(attempt && !["failed","cancelled"].includes(attempt.state))return result({attempt:publicAttempt(attempt)});
  const config=settings(env),demo=order.payment_env==="demo";
  if(config.mode!==order.payment_env || !config.methods.includes(order.payment_method))return fail("此付款方式暫停使用",503);
  if(!demo && (typeof input.prime!=="string" || !input.prime || input.prime.length>2000 || !validBuyer(input.buyer)))
    return fail("請確認付款資料",400);
  const ref="H"+crypto.randomUUID().replaceAll("-","").slice(0,18).toUpperCase();
  const claimedAt=Date.now();
  const claimed=await db.prepare(`INSERT INTO payment_attempts(order_id,reference,merchant,created)
    SELECT id,?,?,? FROM orders WHERE id=? AND status='pending'
    AND (payment_due_at IS NULL OR payment_due_at>?)
    AND COALESCE(${latestState},'unpaid') IN ('unpaid','failed','cancelled')`)
    .bind(ref,demo?"demo":merchantFor(env,order.payment_method),claimedAt,order.id,claimedAt).run();
  attempt=await latest(db,order.id);
  if(!claimed.meta.changes){
    const [,current]=await db.batch([
      expirePaymentHolds(db,claimedAt,token),
      db.prepare("SELECT status FROM orders WHERE id=?").bind(order.id),
    ]);
    const row=current.results[0];
    return row?.status==="cancelled"?fail("餐單已取消",409):result({attempt:publicAttempt(attempt)});
  }
  if(demo || !attempt || attempt.reference!==ref)return result({attempt:publicAttempt(attempt)});
  try{
    const reply=await charge(env,order,attempt,input.prime,input.buyer);
    if([10002,10003,10007,10008,10009,10012,10014].includes(reply.status)){
      await db.prepare("UPDATE payment_attempts SET state='failed' WHERE id=? AND state='pending' AND trade_id IS NULL").bind(attempt.id).run();
    }else if(reply.status===0){
      await db.prepare("UPDATE payment_attempts SET trade_id=COALESCE(trade_id,?),redirect_url=? WHERE id=? AND state='pending'")
        .bind(typeof reply.rec_trade_id==="string"?reply.rec_trade_id:null,httpsUrl(reply.payment_url),attempt.id).run();
    }
  }catch{/* A charge may have reached the provider. Keep the attempt for reconciliation. */}
  return result({attempt:publicAttempt(await latest(db,order.id))});
}
