import {methods,onlinePaymentEnvironments,paymentAttentionStates} from "../lib/payments.mjs";

const pageSize=25;
const filters={
  state:paymentAttentionStates,
  environment:onlinePaymentEnvironments,
  method:Object.keys(methods).filter(method=>method!=="cash"),
};

export function paymentAttentionQuery(params){
  const query={};
  for(const [name,allowed] of Object.entries(filters)){
    const values=params.getAll(name);
    if(values.length>1||values[0]&&!allowed.includes(values[0]))return null;
    if(values[0])query[name]=values[0];
  }
  const cursors=params.getAll("after");
  if(cursors.length>1)return null;
  if(cursors.length){
    const cursor=/^(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/.exec(cursors[0]);
    if(!cursor)return null;
    query.after=cursor.slice(1).map(Number);
    if(!query.after.every(Number.isSafeInteger)||query.after[0]>8_640_000_000_000_000)return null;
  }
  return query;
}

export async function paymentAttention(env,{state,environment,method,after},capturedAt){
  const conditions=[
    "attempt.state IN ('pending','authorized')",
    "orders.payment_method<>'cash'",
    "attempt.created<=?",
    "attempt.id=(SELECT newest.id FROM payment_attempts AS newest WHERE newest.order_id=orders.id ORDER BY newest.id DESC LIMIT 1)",
  ];
  const args=[capturedAt];
  for(const [column,value] of [["attempt.state",state],["orders.payment_env",environment],["orders.payment_method",method]]){
    if(value){conditions.push(column+"=?");args.push(value);}
  }
  if(after){conditions.push("(attempt.created,attempt.order_id)>(?,?)");args.push(...after);}
  const {results}=await env.DB.prepare(`SELECT orders.id,orders.status,orders.payment_method AS method,orders.payment_env AS environment,
    orders.total,orders.payment_due_at AS paymentDueAt,attempt.state,attempt.created AS startedAt,NULLIF(attempt.checked,0) AS checkedAt
    FROM payment_attempts AS attempt JOIN orders ON orders.id=attempt.order_id WHERE ${conditions.join(" AND ")}
    ORDER BY attempt.created,attempt.order_id LIMIT ?`).bind(...args,pageSize+1).all();
  const orders=results.slice(0,pageSize).map(row=>({...row,
    canCheck:(row.environment==="sandbox"||row.environment==="production")&&
      env.TAPPAY_MODE===row.environment&&Boolean(env.TAPPAY_PARTNER_KEY),
  }));
  const last=orders.at(-1);
  return {format:"hey-table.payment-attention.v1",capturedAt,orders,
    nextAfter:results.length>pageSize?last.startedAt+":"+last.id:null};
}
