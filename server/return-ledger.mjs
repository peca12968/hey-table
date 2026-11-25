import {quoteReturn,remainingReturnLots,returnLots} from "../modules/receipt-returns/quote.mjs";

const receiptQuery="SELECT id,created,items,total,combo_quote FROM orders WHERE id=?";
const entryColumns="order_id,revision,operation_id,selection,quote,recorded_at";
const byOperation=`SELECT ${entryColumns} FROM return_quote_entries WHERE operation_id=?`;
const byReceipt=`SELECT ${entryColumns} FROM return_quote_entries WHERE order_id=? ORDER BY revision`;
const voidColumns="order_id,revision,target_revision,operation_id,reason,restored_amount,remaining_value,recorded_at";
const voidByOperation=`SELECT ${voidColumns} FROM return_quote_voids WHERE operation_id=?`;
const voidsByReceipt=`SELECT ${voidColumns} FROM return_quote_voids WHERE order_id=? ORDER BY revision`;
const revisionGuard=`MAX(COALESCE((SELECT MAX(revision) FROM return_quote_entries WHERE order_id=?),0),
  COALESCE((SELECT MAX(revision) FROM return_quote_voids WHERE order_id=?),0))=?`;

function receipt(row){
  const items=JSON.parse(row.items).map(({id,name,price,qty})=>({id,name,price,qty}));
  return {id:row.id,created:row.created,items,total:row.total,...(row.combo_quote?{combo:JSON.parse(row.combo_quote)}:{})};
}

function entry(row){
  return {revision:row.revision,recordedAt:row.recorded_at,...JSON.parse(row.quote)};
}

function voidEntry(row){
  return {revision:row.revision,targetRevision:row.target_revision,reason:row.reason,
    restoredAmount:row.restored_amount,remainingValue:row.remaining_value,recordedAt:row.recorded_at};
}

function ledger(records,voids){
  const voided=new Map(voids.map(row=>[row.target_revision,voidEntry(row)]));
  return {revision:Math.max(records.at(-1)?.revision??0,voids.at(-1)?.revision??0),records:records.map(row=>{
    const saved=entry(row),change=voided.get(saved.revision);
    return change?{...saved,voided:change}:saved;
  })};
}

function ledgerReads(db,id){
  return [db.prepare(receiptQuery).bind(id),db.prepare(byReceipt).bind(id),db.prepare(voidsByReceipt).bind(id)];
}

export async function readReturnReceipt(db,id,includeLedger){
  if(!includeLedger){
    const row=await db.prepare(receiptQuery).bind(id).first();
    return row?receipt(row):null;
  }
  const [lookup,history,voids]=await db.batch(ledgerReads(db,id));
  if(!lookup.results.length)return null;
  return {ticket:receipt(lookup.results[0]),ledger:ledger(history.results,voids.results)};
}

const reviewColumns="fingerprint,event_count,net_amount,reviewed_at,note";
const reviewLimit=10;
const eventOrder="recordedAt DESC,orderId DESC,revision DESC";
const dailyEventRows=`SELECT order_id AS orderId,revision,recorded_at AS recordedAt,
    'recorded' AS kind,json_extract(quote,'$.amount') AS amount,NULL AS targetRevision,NULL AS reason
  FROM return_quote_entries WHERE recorded_at>=? AND recorded_at<? AND recorded_at<=?
  UNION ALL
  SELECT order_id,revision,recorded_at,'voided',restored_amount,target_revision,reason
  FROM return_quote_voids WHERE recorded_at>=? AND recorded_at<? AND recorded_at<=?`;
const reviewFromRow=({fingerprint,event_count,net_amount,reviewed_at,note})=>
  ({fingerprint,eventCount:event_count,netAmount:net_amount,reviewedAt:reviewed_at,note});

function dailyEvents(db,[start,end],capturedAt){
  return db.prepare(dailyEventRows+" ORDER BY "+eventOrder)
    .bind(start,end,capturedAt,start,end,capturedAt);
}

async function reportFromRows(results,date,capturedAt){
  const totals={recordedCount:0,recordedAmount:0,voidedCount:0,restoredAmount:0,netAmount:0};
  const events=results.map(({kind,amount,targetRevision,reason,...row})=>{
    if(kind==="voided"){
      totals.voidedCount++;totals.restoredAmount+=amount;
      return {...row,kind,amount,targetRevision,reason};
    }
    totals.recordedCount++;totals.recordedAmount+=amount;
    return {...row,kind,amount};
  });
  totals.netAmount=totals.recordedAmount-totals.restoredAmount;
  const identity=results.map(({orderId,revision,recordedAt,kind,amount,targetRevision,reason})=>
    [orderId,revision,recordedAt,kind,amount,targetRevision,reason]);
  const signature=new TextEncoder().encode(JSON.stringify(["hey-table.return-ledger-review.v1",date,identity]));
  const digest=await crypto.subtle.digest("SHA-256",signature);
  const fingerprint=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
  return {format:"hey-table.return-ledger-report.v1",date,timeZone:"Asia/Taipei",capturedAt,totals,events,fingerprint};
}

export async function returnLedgerReport(db,date,range,capturedAt){
  const [events,reviews]=await db.batch([dailyEvents(db,range,capturedAt),db.prepare(`SELECT ${reviewColumns}
    FROM return_ledger_reviews WHERE date=? ORDER BY event_count DESC,reviewed_at DESC,fingerprint LIMIT ?`).bind(date,reviewLimit)]);
  return {...await reportFromRows(events.results,date,capturedAt),reviews:reviews.results.map(reviewFromRow)};
}

export async function readReturnLedgerReview(db,date,fingerprint,range){
  const [found,snapshot]=await db.batch([
    db.prepare(`SELECT ${reviewColumns},captured_at FROM return_ledger_reviews WHERE date=? AND fingerprint=?`)
      .bind(date,fingerprint),
    db.prepare(`SELECT order_id AS orderId,revision,recorded_at AS recordedAt,kind,amount,
      target_revision AS targetRevision,reason FROM return_ledger_review_events
      WHERE date=? AND fingerprint=? ORDER BY ${eventOrder}`).bind(date,fingerprint),
  ]);
  const saved=found.results[0];
  if(!saved)return {kind:"missing"};
  const captureSource=saved.captured_at==null?"reconstructed":"saved";
  const capturedAt=saved.captured_at??saved.reviewed_at;
  let events=snapshot.results;
  if(captureSource==="reconstructed"&&saved.event_count>0){
    const {results}=await dailyEvents(db,range,capturedAt).all();
    // Older confirmations carry a fingerprint but no snapshot of the event rows.
    events=results.slice(-saved.event_count);
  }
  const report=await reportFromRows(events,date,capturedAt),review=reviewFromRow(saved);
  if(report.fingerprint!==fingerprint||events.length!==review.eventCount||report.totals.netAmount!==review.netAmount)
    return {kind:"unverified"};
  return {kind:"found",report:{...report,review,captureSource}};
}

export async function confirmReturnLedger(db,{date,fingerprint,note,capturedAt},range,now){
  const byFingerprint=db.prepare(`SELECT ${reviewColumns} FROM return_ledger_reviews WHERE date=? AND fingerprint=?`)
    .bind(date,fingerprint);
  const replay=row=>row?.note===note?reviewFromRow(row):null;
  const already=await byFingerprint.first();
  if(already)return replay(already);
  const {results}=await dailyEvents(db,range,capturedAt).all();
  const report=await reportFromRows(results,date,capturedAt);
  if(report.fingerprint!==fingerprint)return null;
  const {recordedCount,voidedCount,netAmount}=report.totals;
  // Both event tables only grow. Day-wide counts detect inserts even if their timestamp equals or follows the capture.
  const [, ,saved]=await db.batch([db.prepare(`INSERT INTO return_ledger_reviews(date,fingerprint,event_count,net_amount,reviewed_at,note,captured_at)
    SELECT ?,?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM return_quote_entries WHERE recorded_at>=? AND recorded_at<?)=?
      AND (SELECT COUNT(*) FROM return_quote_voids WHERE recorded_at>=? AND recorded_at<?)=?
    ON CONFLICT DO NOTHING`).bind(date,fingerprint,results.length,netAmount,now,note,capturedAt,...range,recordedCount,...range,voidedCount),
    // changes() refers to the preceding INSERT in the same D1 transaction. A replay never rewrites archived rows.
    db.prepare(`INSERT INTO return_ledger_review_events
      (date,fingerprint,order_id,revision,recorded_at,kind,amount,target_revision,reason)
      SELECT ?,?,orderId,revision,recordedAt,kind,amount,targetRevision,reason FROM (${dailyEventRows})
      WHERE changes()=1`).bind(date,fingerprint,...range,capturedAt,...range,capturedAt),
    byFingerprint,
  ]);
  return replay(saved.results[0]);
}

export async function recordReturnQuote(db,{id,revision,operationId,items,amount},now){
  const selection=items.map(({id,qty})=>[id,qty]).sort(([a],[b])=>a<b?-1:a>b?1:0);
  const encoded=JSON.stringify(selection);
  function replay(row){
    const saved=entry(row);
    return row.order_id===id&&row.revision===revision+1&&row.selection===encoded&&saved.amount===amount
      ?{kind:"saved",entry:saved}:{kind:"stale"};
  }
  const [lookup,history,voids,retry]=await db.batch([
    ...ledgerReads(db,id),db.prepare(byOperation).bind(operationId),
  ]);
  if(retry.results.length)return replay(retry.results[0]);
  if(!lookup.results.length)return {kind:"missing"};
  const current=ledger(history.results,voids.results);
  if(current.revision!==revision)return {kind:"stale"};
  let quote;
  try{
    const pricing=returnLots(receipt(lookup.results[0]));
    quote=quoteReturn(remainingReturnLots(pricing,current.records),new Map(selection));
  }catch(error){
    return {kind:"invalid",message:error.message};
  }
  if(quote.amount!==amount)return {kind:"stale"};
  // The revision predicate covers every quoted lot. The transaction either appends the whole quote or leaves the ledger intact.
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO return_quote_entries (order_id,revision,operation_id,selection,quote,recorded_at)
      SELECT ?,?,?,?,?,?
      WHERE ${revisionGuard} AND NOT EXISTS (SELECT 1 FROM return_quote_voids WHERE operation_id=?)
      ON CONFLICT DO NOTHING`).bind(id,revision+1,operationId,encoded,JSON.stringify(quote),now,id,id,revision,operationId),
    db.prepare(byOperation).bind(operationId),
  ]);
  return saved.results.length?replay(saved.results[0]):{kind:"stale"};
}

export async function voidReturnQuote(db,{id,revision,targetRevision,operationId,reason},now){
  function replay(row){
    return row.order_id===id&&row.revision===revision+1&&row.target_revision===targetRevision&&row.reason===reason
      ?{kind:"saved",entry:voidEntry(row)}:{kind:"stale"};
  }
  const [lookup,history,voids,retry]=await db.batch([
    ...ledgerReads(db,id),db.prepare(voidByOperation).bind(operationId),
  ]);
  if(retry.results.length)return replay(retry.results[0]);
  if(!lookup.results.length)return {kind:"missing"};
  const current=ledger(history.results,voids.results);
  const target=current.records.find(record=>record.revision===targetRevision);
  if(current.revision!==revision||!target||target.voided)return {kind:"stale"};
  let remaining;
  try{
    const pricing=returnLots(receipt(lookup.results[0]));
    remaining=remainingReturnLots(pricing,current.records.filter(record=>record.revision!==targetRevision)).total;
  }catch(error){return {kind:"invalid",message:error.message};}
  const [,saved]=await db.batch([
    db.prepare(`INSERT INTO return_quote_voids (order_id,revision,target_revision,operation_id,reason,restored_amount,remaining_value,recorded_at)
      SELECT ?,?,?,?,?,?,?,?
      WHERE ${revisionGuard} AND NOT EXISTS (SELECT 1 FROM return_quote_entries WHERE operation_id=?)
      ON CONFLICT DO NOTHING`).bind(id,revision+1,targetRevision,operationId,reason,target.amount,remaining,now,id,id,revision,operationId),
    db.prepare(voidByOperation).bind(operationId),
  ]);
  return saved.results.length?replay(saved.results[0]):{kind:"stale"};
}
