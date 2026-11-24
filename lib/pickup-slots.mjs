import {businessDate,businessDayRange} from "./business-day.mjs";
import {canPrepare} from "./payments.mjs";

const minute=60_000;
export const pickupSlotDuration=15*minute;
export const pickupPrepLead=15*minute;
export const pickupSlotCapacity=12;
const bookingLead=30*minute;
const hours={open:11*60*minute,close:20*60*minute};
const time=new Intl.DateTimeFormat("zh-TW",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Taipei"});
const date=new Intl.DateTimeFormat("zh-TW",{month:"numeric",day:"numeric",timeZone:"Asia/Taipei"});

export function pickupSlotsForDay(day){
  const range=businessDayRange(day);
  if(!range)return [];
  return Array.from({length:(hours.close-hours.open)/pickupSlotDuration},(_,index)=>range[0]+hours.open+index*pickupSlotDuration);
}

export const bookablePickupSlots=now=>pickupSlotsForDay(businessDate(now)).filter(start=>start>=now+bookingLead);

export const pickupTime=start=>time.format(start);
export const pickupWindow=start=>pickupTime(start)+"～"+pickupTime(start+pickupSlotDuration);
export const datedPickupWindow=start=>date.format(start)+" "+pickupWindow(start);

export function pickupCalendarStatus(order){
  if(order.mode!=="pickup"||order.pickupSlot==null)return null;
  if(order.status==="cancelled")return "CANCELLED";
  return canPrepare(order)||order.status==="completed"?"CONFIRMED":null;
}
