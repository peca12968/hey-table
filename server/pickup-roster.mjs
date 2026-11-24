import {latestState} from "./payment-api.mjs";
import {expirePaymentHolds} from "./payment-holds.mjs";
import {orderPortions,pickupDaySettings} from "./pickup-slots.mjs";

export async function pickupRoster(db,date,range,capturedAt){
  const [,settings,bookings]=await db.batch([
    expirePaymentHolds(db,capturedAt),
    pickupDaySettings(db,date),
    db.prepare(`SELECT id,source,status,pickup_slot,payment_method,COALESCE(${latestState},'unpaid') AS payment_state,
      COALESCE(${orderPortions},0) AS portions FROM orders
      WHERE mode='pickup' AND pickup_slot>=? AND pickup_slot<? ORDER BY pickup_slot,id`).bind(...range),
  ]);
  const windows=new Map();
  const totals={bookings:0,portions:0,cancelled:0};
  for(const row of bookings.results){
    let window=windows.get(row.pickup_slot);
    if(!window){
      window={start:row.pickup_slot,portions:0,orders:[]};
      windows.set(row.pickup_slot,window);
    }
    window.orders.push({id:row.id,source:row.source==="staff"?"staff":"online",status:row.status,
      paymentMethod:row.payment_method,paymentState:row.payment_state,portions:row.portions});
    if(row.status==="cancelled")totals.cancelled++;
    else{
      totals.bookings++;
      totals.portions+=row.portions;
      window.portions+=row.portions;
    }
  }
  return {date,capturedAt,accepting:settings.results[0]?.accepting!==0,totals,windows:Array.from(windows.values())};
}
