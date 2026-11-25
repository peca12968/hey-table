import {methods,onlinePaymentEnvironments,paymentAttentionStates} from "../lib/payments.mjs";
import {latestPaymentAttentionNote,paymentFollowUpJoin} from "./payment-attention-notes.mjs";

const pageSize=25;
const amountBase=1_000_000;
const summaryTotals=()=>({orders:0,amount:0n,pending:0,authorized:0,overdue:0});
const filters={
  state:paymentAttentionStates,
  environment:onlinePaymentEnvironments,
  method:Object.keys(methods).filter(method=>method!=="cash"),
  followUp:["due"],
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
  const summaries=params.getAll("summary");
  if(summaries.length>1||(summaries.length===1&&summaries[0]!=="1"))return null;
  if(summaries.length)query.summary=true;
  return query;
}

function summarize(rows,query,capturedAt){
  const groups=new Map(),totals=summaryTotals();
  for(const row of rows){
    const method=Object.hasOwn(methods,row.method)?row.method:"unknown";
    const environment=onlinePaymentEnvironments.includes(row.environment)?row.environment:"unknown";
    const key=method+":"+environment;
    if(!groups.has(key))groups.set(key,{method,environment,...summaryTotals()});
    const amount=BigInt(row.whole)*BigInt(amountBase)+BigInt(row.remainder);
    for(const summary of [groups.get(key),totals]){
      summary.orders+=row.orders;
      summary.amount+=amount;
      summary[row.state]+=row.orders;
      summary.overdue+=row.overdue;
    }
  }
  const serialize=summary=>({...summary,amount:String(summary.amount)});
  return {format:"hey-table.payment-attention-summary.v1",capturedAt,timeZone:"Asia/Taipei",filters:query,
    totals:serialize(totals),groups:[...groups.values()].map(serialize)};
}

export async function paymentAttention(env,{state,environment,method,followUp,after,summary},capturedAt){
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
  if(followUp==="due"){
    conditions.push("followUp.follow_up_at BETWEEN 1 AND ?");
    args.push(capturedAt);
  }
  const table="FROM payment_attempts AS attempt JOIN orders ON orders.id=attempt.order_id";
  const where=" WHERE "+conditions.join(" AND ");
  const pageScope=table+" "+paymentFollowUpJoin+where;
  const summaryScope=(followUp?table+" "+paymentFollowUpJoin:table)+where;
  const cursor=after?" AND (attempt.created,attempt.order_id)>(?,?)":"";
  const page=env.DB.prepare(`SELECT orders.id,orders.status,orders.payment_method AS method,orders.payment_env AS environment,
    orders.total,orders.payment_due_at AS paymentDueAt,attempt.state,attempt.created AS startedAt,NULLIF(attempt.checked,0) AS checkedAt,
    ${latestPaymentAttentionNote} AS latestNote,NULLIF(followUp.follow_up_at,0) AS followUpAt
    ${pageScope}${cursor} ORDER BY attempt.created,attempt.order_id LIMIT ?`).bind(...args,...(after??[]),pageSize+1);
  let results,report;
  if(summary){
    // Sum integer quotients and remainders separately so the full total can exceed SQLite's single integer range.
    const aggregate=env.DB.prepare(`SELECT orders.payment_method AS method,orders.payment_env AS environment,attempt.state,
      COUNT(*) AS orders,COUNT(CASE WHEN attempt.state='pending' AND orders.payment_due_at<=? THEN 1 END) AS overdue,
      CAST(SUM(orders.total/${amountBase}) AS TEXT) AS whole,CAST(SUM(orders.total%${amountBase}) AS TEXT) AS remainder
      ${summaryScope} GROUP BY orders.payment_method,orders.payment_env,attempt.state ORDER BY method,environment,attempt.state`)
      .bind(capturedAt,...args);
    const [details,rollup]=await env.DB.batch([page,aggregate]);
    results=details.results;
    report=summarize(rollup.results,{state:state??null,environment:environment??null,method:method??null,
      ...(followUp?{followUp}:{})},capturedAt);
  }else{
    results=(await page.all()).results;
  }
  const orders=results.slice(0,pageSize).map(({latestNote,followUpAt,...row})=>({...row,
    ...(latestNote?{latestNote:JSON.parse(latestNote)}:{}),
    ...(followUpAt===null?{}:{followUpAt}),
    canCheck:(row.environment==="sandbox"||row.environment==="production")&&
      env.TAPPAY_MODE===row.environment&&Boolean(env.TAPPAY_PARTNER_KEY),
  }));
  const last=orders.at(-1);
  return {format:"hey-table.payment-attention.v1",capturedAt,orders,
    nextAfter:results.length>pageSize?last.startedAt+":"+last.id:null,...(report?{summary:report}:{})};
}
