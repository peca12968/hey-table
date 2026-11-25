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
  if(!a)return {outcome:"noAttempt"};
  if(!["sandbox","production"].includes(order.payment_env)||env.TAPPAY_MODE!==order.payment_env)return {outcome:"unavailable"};
  if(!Object.hasOwn(transitions,a.state))return {outcome:"notQueryable"};
  const checkedAt=Date.now();
  const claimed=await env.DB.prepare("UPDATE payment_attempts SET checked=? WHERE id=? AND state=? AND checked<=?")
    .bind(checkedAt,a.id,a.state,checkedAt-5000).run();
  if(!claimed.meta.changes)return {outcome:"recent"};
  const verified=await lookup(env,order,a);
  if(!verified||!transitions[a.state].includes(verified.state))return {outcome:"unconfirmed"};
  const firstPayable=!kitchenPaymentStates.includes(a.state)&&kitchenPaymentStates.includes(verified.state);
  const stored=await env.DB.prepare(`UPDATE payment_attempts SET state=?, trade_id=?,
    redirect_url=CASE WHEN ?='pending' THEN redirect_url ELSE NULL END,
    kitchen_payable_at=COALESCE(kitchen_payable_at,?) WHERE id=? AND state=? AND checked=?
      AND (trade_id IS NULL OR trade_id=?)`)
    .bind(verified.state,verified.trade,verified.state,firstPayable?Date.now():null,a.id,a.state,checkedAt,verified.trade).run();
  return stored.meta.changes?{outcome:"matched",state:verified.state}:{outcome:"changed"};
}
export async function checkKitchenPayment(env,id) {
  if(!Number.isSafeInteger(id)||id<1)return fail("訂單編號無效",400);
  const order=await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(id).first();
  if(!order || order.payment_method==="cash")return fail("找不到線上付款餐單",404);
  try{
    const attempt=await latest(env.DB,id);
    const check=attempt&&!env.TAPPAY_PARTNER_KEY?{outcome:"unavailable"}:await reconcile(env,order,attempt);
    const current=await latest(env.DB,id);
    const paymentState=current?.state??"unpaid";
    const changed=current?.id!==attempt?.id||paymentState!==(check.state??attempt?.state??"unpaid");
    return result({ok:true,id,paymentState,outcome:changed?"changed":check.outcome});
  }catch{return fail("無法查詢金流，請稍後再查",503);}
}
export async function refundDemoPayment(env,{id,expectedTotal,expectedStatus}){
  if(settings(env).mode!=="demo")return fail("只能在示範環境模擬退款。",403);
  if(!Number.isSafeInteger(id)||id<1||!Number.isSafeInteger(expectedTotal)||expectedTotal<1||
    !["pending","preparing","ready","completed","cancelled"].includes(expectedStatus))
    return fail("請重新核對餐單狀態與原付款金額。",400);
  const db=env.DB,now=Date.now();
  const [,,,current]=await db.batch([
    db.prepare(`INSERT INTO demo_refunds(order_id,attempt_id,amount,previous_status,refunded_at)
      SELECT orders.id,attempt.id,orders.total,orders.status,? FROM orders JOIN payment_attempts AS attempt
      ON attempt.id=(SELECT id FROM payment_attempts WHERE order_id=orders.id ORDER BY id DESC LIMIT 1)
      WHERE orders.id=? AND orders.total=? AND orders.status=? AND orders.payment_env='demo'
      AND orders.payment_method<>'cash' AND attempt.state='paid' ON CONFLICT(order_id) DO NOTHING`)
      .bind(now,id,expectedTotal,expectedStatus),
    db.prepare(`UPDATE payment_attempts SET state='refunded',redirect_url=NULL
      WHERE id=(SELECT attempt_id FROM demo_refunds WHERE order_id=? AND amount=? AND previous_status=?)
      AND state='paid'`).bind(id,expectedTotal,expectedStatus),
    db.prepare(`UPDATE orders SET status='cancelled',
      status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',
        json_object('from',status,'status','cancelled','at',
          (SELECT refunded_at FROM demo_refunds WHERE order_id=orders.id),'actor','demo_refund'))
      WHERE id=? AND status IN ('pending','preparing','ready')
      AND EXISTS (SELECT 1 FROM demo_refunds WHERE order_id=orders.id AND amount=? AND previous_status=? AND previous_status=orders.status)
      AND ${latestState}='refunded'`).bind(id,expectedTotal,expectedStatus),
    db.prepare(`SELECT id,total,status,payment_env,payment_method,${latestState} AS payment_state FROM orders WHERE id=?`).bind(id),
  ]);
  const order=current.results[0];
  if(!order)return fail("找不到餐單。",404);
  if(order.payment_env!=="demo"||order.payment_method==="cash")return fail("這張餐單不適用示範退款。",403);
  if(order.total!==expectedTotal||order.payment_state!=="refunded")return fail("餐單或付款狀態已更新，請重新核對。",409);
  return result({id,total:order.total,status:order.status,paymentState:"refunded"});
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
