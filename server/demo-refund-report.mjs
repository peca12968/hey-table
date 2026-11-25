import {latestState} from "./payment-api.mjs";
import {numberOf} from "../lib/menu.mjs";
import {methods} from "../lib/payments.mjs";

const legacyTimestamp="json_extract(status_history,'$[#-1].at')";
const legacyStatus="json_extract(status_history,'$[#-1].from')";
const timedLegacyRefund=`orders.status='cancelled' AND json_extract(status_history,'$[#-1].actor')='demo_refund'
  AND ${legacyStatus} IN ('pending','preparing','ready') AND json_type(status_history,'$[#-1].at')='integer'`;
const demoPayment="orders.payment_env='demo' AND orders.payment_method<>'cash'";

export const demoRefundReceiptColumn=`CASE WHEN ${demoPayment} AND ${latestState}='refunded' THEN COALESCE(
  (SELECT json_object('amount',amount,'refundedAt',refunded_at) FROM demo_refunds WHERE order_id=orders.id),
  json_object('amount',orders.total,'refundedAt',CASE WHEN ${timedLegacyRefund} THEN ${legacyTimestamp} END)
) END AS demo_refund_receipt`;

const taipeiTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium"});

export function demoRefundReceiptText(order,refund){
  const time=refund.refundedAt===null?"未記錄":taipeiTime.format(refund.refundedAt);
  return ["禾日食堂｜示範退款收據","示範付款，無實際退款。",
    `取餐號碼 ${numberOf(order.id)}`,`支付方式 ${methods[order.paymentMethod]??"未記錄"}`,
    `退款金額 NT$ ${refund.amount}`,`退款時間（台灣） ${time}`,""].join("\r\n");
}

export async function demoRefundReport(db,date,[start,end],capturedAt){
  const {results:refunds}=await db.prepare(`SELECT order_id AS orderId,orders.mode,orders.payment_method AS paymentMethod,
      amount,previous_status AS previousStatus,refunded_at AS refundedAt,'recorded' AS source
    FROM demo_refunds JOIN orders ON orders.id=demo_refunds.order_id WHERE refunded_at>=? AND refunded_at<?
    UNION ALL
    SELECT orders.id,orders.mode,orders.payment_method,orders.total,${legacyStatus},${legacyTimestamp},'cancellation_history'
    FROM orders WHERE ${demoPayment} AND ${timedLegacyRefund}
      AND ${latestState}='refunded' AND NOT EXISTS(SELECT 1 FROM demo_refunds WHERE order_id=orders.id)
      AND ${legacyTimestamp}>=? AND ${legacyTimestamp}<?
    ORDER BY refundedAt DESC,orderId DESC`).bind(start,end,start,end).all();
  return {format:"hey-table.demo-refunds.v1",date,timeZone:"Asia/Taipei",capturedAt,refunds,totals:{
    count:refunds.length,amount:refunds.reduce((sum,refund)=>sum+refund.amount,0),
    completed:refunds.filter(refund=>refund.previousStatus==="completed").length,
  }};
}
