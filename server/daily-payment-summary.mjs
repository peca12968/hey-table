import {methods,paymentStates} from "../lib/payments.mjs";
import {latestState} from "./payment-api.mjs";

export const cashRecorded="EXISTS(SELECT 1 FROM cash_receipts WHERE order_id=orders.id)";
export const completedOnDay="orders.created>=? AND orders.created<? AND orders.status='completed'";

export const dailyPaymentRows=(db,range)=>db.prepare(`
  SELECT orders.id,orders.payment_method AS method,orders.payment_env AS environment,CAST(orders.total AS TEXT) AS total,
    COALESCE(${latestState},'unpaid') AS state,
    ${cashRecorded} AS cashRecorded
  FROM orders WHERE ${completedOnDay}
  ORDER BY orders.payment_method,orders.payment_env,orders.id`).bind(...range);

const environments=new Set(["demo","sandbox","production"]);
const settled=new Set(["cashRecorded","paid","refunded"]);

export function dailyPaymentSummary(rows){
  const groups=new Map();
  let needsReview=0;
  for(const row of rows){
    const method=Object.hasOwn(methods,row.method)?row.method:"unknown";
    const environment=method==="cash"?"cash":environments.has(row.environment)?row.environment:"unknown";
    const key=method+":"+environment;
    if(!groups.has(key))groups.set(key,{method,environment,orders:0,completedTotal:0n,statuses:{},review:[]});
    const group=groups.get(key);
    const state=method==="cash"?(row.cashRecorded?"cashRecorded":"cashMissing"):
      Object.hasOwn(paymentStates,row.state)?row.state:"unknown";
    group.orders++;
    group.completedTotal+=BigInt(row.total);
    group.statuses[state]=(group.statuses[state]??0)+1;
    if(method==="unknown"||environment==="unknown"||!settled.has(state)){
      group.review.push({id:row.id,state});
      needsReview++;
    }
  }
  return {completed:rows.length,needsReview,groups:[...groups.values()].map(group=>({
    ...group,completedTotal:String(group.completedTotal),
  }))};
}
