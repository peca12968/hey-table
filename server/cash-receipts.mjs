import {businessDate} from "../lib/business-day.mjs";

const initialCashReceipt=`(SELECT json_object('amount',amount,'tendered',tendered,'change',tendered-amount,'collectedAt',collected_at)
  FROM cash_receipts WHERE order_id=orders.id)`;
const latestCorrection=orderKey=>`(SELECT MAX(revision) FROM cash_receipt_corrections WHERE order_id=${orderKey})`;
const effectiveTendered="COALESCE(c.tendered,r.tendered)";
const correctedReceiptValues=`json_object('amount',r.amount,'tendered',${effectiveTendered},
  'change',${effectiveTendered}-r.amount,'collectedAt',r.collected_at)`;
export const cashReceiptColumn=`(SELECT json_patch(${correctedReceiptValues},
    CASE WHEN c.revision IS NULL THEN '{}' ELSE json_object('revision',c.revision,'correctedAt',c.corrected_at) END)
  FROM cash_receipts r LEFT JOIN cash_receipt_corrections c ON c.order_id=r.order_id AND c.revision=${latestCorrection("r.order_id")}
  WHERE r.order_id=orders.id)`;

export async function collectCash(db,{id,operationId,expectedTotal,tendered},now){
  const [,lookup]=await db.batch([
    db.prepare(`INSERT INTO cash_receipts(order_id,operation_id,amount,tendered,collected_at)
      SELECT id,?,total,?,? FROM orders
      WHERE id=? AND payment_method='cash' AND status IN ('ready','completed') AND total=? AND total<=?
      ON CONFLICT DO NOTHING`).bind(operationId,tendered,now,id,expectedTotal,tendered),
    db.prepare(`SELECT orders.payment_method,orders.status,orders.total,cash_receipts.operation_id,
      ${initialCashReceipt} AS cash_receipt
      FROM orders LEFT JOIN cash_receipts ON order_id=orders.id WHERE orders.id=?`).bind(id),
  ]);
  return lookup.results[0];
}

export async function cashCorrectionHistory(db,id){
  const {results}=await db.prepare(`SELECT revision,previous_tendered AS previousTendered,tendered,reason,
    corrected_at AS correctedAt FROM cash_receipt_corrections WHERE order_id=? ORDER BY revision DESC`).bind(id).all();
  return results;
}

export async function correctCashReceipt(db,{id,revision,operationId,tendered,reason},now){
  const [,saved,current]=await db.batch([
    db.prepare(`INSERT INTO cash_receipt_corrections(order_id,revision,operation_id,previous_tendered,tendered,reason,corrected_at)
      SELECT r.order_id,?,?,${effectiveTendered},?,?,MAX(?,COALESCE(c.corrected_at,r.collected_at))
      FROM cash_receipts r LEFT JOIN cash_receipt_corrections c ON c.order_id=r.order_id AND c.revision=${latestCorrection("r.order_id")}
      WHERE r.order_id=? AND COALESCE(c.revision,0)=? AND ?>=r.amount AND ?<>${effectiveTendered}
      ON CONFLICT DO NOTHING`).bind(revision+1,operationId,tendered,reason,now,id,revision,tendered,tendered),
    db.prepare(`SELECT c.order_id AS orderId,c.revision,c.tendered,c.reason,c.corrected_at AS correctedAt,
      r.amount,r.collected_at AS collectedAt
      FROM cash_receipt_corrections c JOIN cash_receipts r ON r.order_id=c.order_id WHERE c.operation_id=?`).bind(operationId),
    db.prepare("SELECT amount FROM cash_receipts WHERE order_id=?").bind(id),
  ]);
  return {stored:saved.results[0],receipt:current.results[0]};
}

export const cashCorrectionsInRange=`SELECT COUNT(*) FROM cash_receipt_corrections c
  JOIN cash_receipts r ON r.order_id=c.order_id WHERE r.collected_at>=? AND r.collected_at<?`;

const completedAt=`(SELECT MIN(CASE WHEN event.type='object' THEN
  CASE WHEN json_extract(event.value,'$.from')='ready' AND json_extract(event.value,'$.status')='completed'
    AND json_type(event.value,'$.at')='integer' AND json_extract(event.value,'$.at')>=orders.created
    THEN json_extract(event.value,'$.at') END END)
  FROM json_each(CASE WHEN json_valid(orders.status_history) THEN orders.status_history ELSE '[]' END) AS event)`;

export async function dailyCashReceipts(db,date,range,capturedAt,includeActivity=false){
  const context=includeActivity?`,orders.created AS orderCreatedAt,
    CASE WHEN orders.status='completed' THEN ${completedAt} END AS completedAt`:"";
  const ledger=db.prepare(`SELECT r.order_id AS orderId, orders.mode,
    r.amount,${effectiveTendered} AS tendered,${effectiveTendered}-r.amount AS change,
    r.collected_at AS recordedAt,c.revision AS correctionRevision,c.corrected_at AS correctedAt${context}
    FROM cash_receipts r JOIN orders ON orders.id=r.order_id
    LEFT JOIN cash_receipt_corrections c ON c.order_id=r.order_id AND c.revision=(
      SELECT MAX(revision) FROM cash_receipt_corrections WHERE order_id=r.order_id AND corrected_at<=?)
    WHERE r.collected_at>=? AND r.collected_at<? AND r.collected_at<=?
    ORDER BY r.collected_at,r.order_id`).bind(capturedAt,...range,capturedAt);
  const [ledgerResult,events]=includeActivity?await db.batch([ledger,
    db.prepare(`SELECT c.order_id AS orderId,c.revision,c.previous_tendered AS previousTendered,c.tendered,
      c.corrected_at AS correctedAt,r.collected_at AS recordedAt
      FROM cash_receipt_corrections c JOIN cash_receipts r ON r.order_id=c.order_id
      WHERE c.corrected_at>=? AND c.corrected_at<? AND c.corrected_at<=?
      ORDER BY c.corrected_at,c.order_id,c.revision`).bind(...range,capturedAt),
  ]):[await ledger.all()];
  let net=0n,tendered=0n,change=0n,correctionCount=0;
  let earlierOrders=0,afterHandoff=0;
  const receipts=ledgerResult.results.map(({correctionRevision,correctedAt,orderCreatedAt,completedAt,...row})=>{
    net+=BigInt(row.amount);
    tendered+=BigInt(row.tendered);
    change+=BigInt(row.change);
    correctionCount+=correctionRevision??0;
    if(includeActivity){
      row.orderDate=businessDate(orderCreatedAt);
      if(row.orderDate<date)earlierOrders++;
      if(Number.isSafeInteger(completedAt)&&completedAt<row.recordedAt){
        row.completedAt=completedAt;
        afterHandoff++;
      }
    }
    return correctionRevision?{...row,correctionRevision,correctedAt}:row;
  });
  return {format:"hey-table.daily-cash.v1",date,timeZone:"Asia/Taipei",capturedAt,
    totals:{receipts:receipts.length,net:String(net),tendered:String(tendered),change:String(change)},receipts,
    ...(includeActivity?{activity:{earlierOrders,afterHandoff,
      corrections:events.results.map(event=>({...event,recordedDate:businessDate(event.recordedAt)})),
    }}:{}),
    ...(correctionCount?{correctionCount}:{})};
}
