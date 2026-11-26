import {cashRecorded,completedOnDay} from "./daily-payment-summary.mjs";
import {openPaymentAttention,paymentAttentionTable} from "./payment-attention.mjs";
import {latestState} from "./payment-api.mjs";
import {pickupFollowUp} from "./pickup-roster.mjs";

const previewLimit=10;

function preview(rows){
  return {total:rows[0]?.total??0,orders:rows.map(({total,...order})=>order)};
}

export async function shiftHandoff(db,date,range,capturedAt){
  const [bookings,payments,cash]=await db.batch([
    db.prepare(`SELECT id,status,payment_method,COALESCE(${latestState},'unpaid') AS payment_state,
        pickup_slot,pickup_arrived_at,created,status_history
      FROM orders WHERE mode='pickup' AND status='ready' AND pickup_slot>=? AND pickup_slot<?`).bind(...range),
    db.prepare(`SELECT orders.id,orders.payment_method AS method,orders.payment_env AS environment,
        attempt.state,attempt.created AS startedAt,COUNT(*) OVER () AS total
      ${paymentAttentionTable} WHERE ${openPaymentAttention}
      ORDER BY attempt.created,orders.id LIMIT ?`).bind(capturedAt,previewLimit),
    db.prepare(`SELECT orders.id,orders.created AS createdAt,COUNT(*) OVER () AS total
      FROM orders WHERE ${completedOnDay} AND orders.payment_method='cash' AND NOT ${cashRecorded}
      ORDER BY orders.created,orders.id LIMIT ?`).bind(...range,previewLimit),
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
  return {format:"hey-table.shift-handoff.v1",date,capturedAt,pickup,
    payments:preview(payments.results),cash:preview(cash.results)};
}
