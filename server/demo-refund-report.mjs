import {latestState} from "./payment-api.mjs";

const legacyTimestamp="json_extract(status_history,'$[#-1].at')";
const legacyStatus="json_extract(status_history,'$[#-1].from')";

export async function demoRefundReport(db,date,[start,end],capturedAt){
  const {results:refunds}=await db.prepare(`SELECT order_id AS orderId,orders.mode,orders.payment_method AS paymentMethod,
      amount,previous_status AS previousStatus,refunded_at AS refundedAt,'recorded' AS source
    FROM demo_refunds JOIN orders ON orders.id=demo_refunds.order_id WHERE refunded_at>=? AND refunded_at<?
    UNION ALL
    SELECT orders.id,orders.mode,orders.payment_method,orders.total,${legacyStatus},${legacyTimestamp},'cancellation_history'
    FROM orders WHERE orders.status='cancelled' AND payment_env='demo' AND payment_method<>'cash'
      AND ${latestState}='refunded' AND NOT EXISTS(SELECT 1 FROM demo_refunds WHERE order_id=orders.id)
      AND json_extract(status_history,'$[#-1].actor')='demo_refund' AND ${legacyStatus} IN ('pending','preparing','ready')
      AND json_type(status_history,'$[#-1].at')='integer' AND ${legacyTimestamp}>=? AND ${legacyTimestamp}<?
    ORDER BY refundedAt DESC,orderId DESC`).bind(start,end,start,end).all();
  return {format:"hey-table.demo-refunds.v1",date,timeZone:"Asia/Taipei",capturedAt,refunds,totals:{
    count:refunds.length,amount:refunds.reduce((sum,refund)=>sum+refund.amount,0),
    completed:refunds.filter(refund=>refund.previousStatus==="completed").length,
  }};
}
