import {cashRecorded,completedOnDay} from "./daily-payment-summary.mjs";
import {openPaymentAttention,paymentAttentionTable} from "./payment-attention.mjs";
import {paymentFollowUpDue,paymentFollowUpJoin} from "./payment-attention-notes.mjs";
import {latestState} from "./payment-api.mjs";
import {pickupDelayHandoffRows} from "./pickup-delay.mjs";
import {pickupFollowUp} from "./pickup-roster.mjs";

const previewLimit=10;

function preview(rows){
  return {total:rows[0]?.total??0,orders:rows.map(({total,...order})=>order)};
}

export async function shiftHandoff(db,date,range,capturedAt){
  const [bookings,payments,cash,delays]=await db.batch([
    db.prepare(`SELECT id,status,payment_method,COALESCE(${latestState},'unpaid') AS payment_state,
        pickup_slot,pickup_arrived_at,created,status_history
      FROM orders WHERE mode='pickup' AND status='ready' AND pickup_slot>=? AND pickup_slot<?`).bind(...range),
    db.prepare(`WITH openPayments AS (
        SELECT orders.id,orders.payment_method AS method,orders.payment_env AS environment,
          attempt.id AS attemptId,attempt.state,attempt.created AS startedAt,
          NULLIF(followUp.follow_up_at,0) AS followUpAt,
          CASE WHEN ${paymentFollowUpDue} THEN followUp.follow_up_at END AS dueAt
        ${paymentAttentionTable} ${paymentFollowUpJoin} WHERE ${openPaymentAttention}
      ) SELECT *,COUNT(*) OVER () AS total,COUNT(dueAt) OVER () AS followUpsDue FROM openPayments
      ORDER BY dueAt IS NULL,dueAt,startedAt,id LIMIT ?`).bind(capturedAt,capturedAt,previewLimit),
    db.prepare(`SELECT orders.id,orders.created AS createdAt,COUNT(*) OVER () AS total
      FROM orders WHERE ${completedOnDay} AND orders.payment_method='cash' AND NOT ${cashRecorded}
      ORDER BY orders.created,orders.id LIMIT ?`).bind(...range,previewLimit),
    pickupDelayHandoffRows(db,capturedAt,previewLimit),
  ]);
  const pickup={unreported:{total:0,orders:[]},arrived:{total:0,orders:[]}};
  for(const row of bookings.results){
    const followUp=pickupFollowUp(row,capturedAt);
    if(!followUp)continue;
    const group=pickup[followUp.state];
    group.orders.push({id:row.id,pickupSlot:row.pickup_slot,dueAt:followUp.dueAt});
  }
  for(const group of Object.values(pickup)){
    group.total=group.orders.length;
    group.orders.sort((a,b)=>a.dueAt-b.dueAt||a.id-b.id);
    group.orders=group.orders.slice(0,previewLimit);
  }
  const paymentPreview={
    total:payments.results[0]?.total??0,
    followUpsDue:payments.results[0]?.followUpsDue??0,
    orders:payments.results.map(({total,followUpsDue,dueAt,followUpAt,...order})=>({
      ...order,...(followUpAt===null?{}:{followUpAt}),
    })),
  };
  return {format:"hey-table.shift-handoff.v1",date,capturedAt,pickup,
    payments:paymentPreview,cash:preview(cash.results),delays:{
      total:delays.results[0]?.total??0,overdue:delays.results[0]?.overdue??0,
      orders:delays.results.map(({total,overdue,...order})=>order),
    }};
}
