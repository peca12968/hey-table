import {methods} from "../lib/payments.mjs";

export const merchantFor = (env, method) => env["TAPPAY_MERCHANT_" + method.toUpperCase()];
export function httpsUrl(value) {
  try {const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : null;}
  catch {return null;}
}
export function settings(env) {
  const mode = env.TAPPAY_MODE ?? "demo";
  const active = ["sandbox","production"].includes(mode) && /^\d+$/.test(env.TAPPAY_APP_ID) &&
    env.TAPPAY_APP_KEY && env.TAPPAY_PARTNER_KEY && httpsUrl(env.TAPPAY_NOTIFY_URL) && httpsUrl(env.TAPPAY_SITE_ORIGIN);
  return {mode, methods:Object.keys(methods).filter(m => m === "cash" || mode === "demo" || (active && merchantFor(env,m))),
    ...(active ? {appId:Number(env.TAPPAY_APP_ID),appKey:env.TAPPAY_APP_KEY} : {})};
}
async function call(env,path,data,transport) {
  const host = {sandbox:"sandbox",production:"prod"}[env.TAPPAY_MODE];
  if (!host) throw Error("無法連線至金流");
  const response = await transport("https://"+host+".tappaysdk.com/tpc/"+path,{
    method:"POST",headers:{"content-type":"application/json","x-api-key":env.TAPPAY_PARTNER_KEY},
    body:JSON.stringify({...data, partner_key:env.TAPPAY_PARTNER_KEY}),signal:AbortSignal.timeout(25000)
  });
  if (!response.ok) throw Error("金流暫時無法回應");
  return response.json();
}
export function validBuyer(buyer) {
  return buyer && typeof buyer.name === "string" && buyer.name.trim().length > 0 && buyer.name.length <= 40 &&
    typeof buyer.email === "string" && buyer.email.length <= 40 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(buyer.email) &&
    typeof buyer.phone_number === "string" && /^\+?[0-9]{8,15}$/.test(buyer.phone_number);
}
export function charge(env,order,attempt,prime,buyer,transport=fetch) {
  return call(env,"payment/pay-by-prime",{prime,merchant_id:attempt.merchant,amount:order.total,currency:"TWD",
    details:JSON.parse(order.items).map(i=>i.name+"×"+i.qty).join("、").slice(0,100),
    order_number:attempt.reference,bank_transaction_id:attempt.reference,
    cardholder:{name:buyer.name.trim(),email:buyer.email,phone_number:buyer.phone_number},remember:false,
    ...(order.payment_method==="card"?{three_domain_secure:true}:{}),
    result_url:{frontend_redirect_url:new URL("/ticket?payment="+attempt.reference,env.TAPPAY_SITE_ORIGIN).href,backend_notify_url:env.TAPPAY_NOTIFY_URL}
  },transport);
}
const states = {"-1":"failed",0:"authorized",1:"paid",2:"partial",3:"refunded",4:"pending",5:"cancelled"};
export async function lookup(env,order,attempt,transport=fetch) {
  const result=await call(env,"transaction/query",{records_per_page:20,page:0,filters:{
    time:{start_time:attempt.created-60000,end_time:Math.min(Date.now()+1000,attempt.created+89*86400000)},
    currency:"TWD",merchant_id:[attempt.merchant],bank_transaction_id:attempt.reference,
    ...(attempt.trade_id ? {rec_trade_id:attempt.trade_id} : {})}},transport);
  if (![0,2].includes(result.status) || !Array.isArray(result.trade_records)) return null;
  const records=result.trade_records.filter(r=>r.bank_transaction_id===attempt.reference && r.merchant_id===attempt.merchant &&
    (r.currency===undefined || r.currency==="TWD") && r.payment_method===(order.payment_method==="card"?"direct_pay":order.payment_method) && (r.original_amount??r.amount)===order.total && typeof r.rec_trade_id==="string" && r.rec_trade_id &&
    (!attempt.trade_id || r.rec_trade_id===attempt.trade_id));
  if(records.length!==1 || !Object.hasOwn(states,records[0].record_status))return null;
  return {state:states[records[0].record_status],trade:records[0].rec_trade_id};
}
