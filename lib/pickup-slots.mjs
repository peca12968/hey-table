import {businessDate,businessDayRange} from "./business-day.mjs";
import {canPrepare} from "./payments.mjs";

const minute=60_000;
export const pickupSlotDuration=15*minute;
export const pickupPrepLead=15*minute;
export const pickupSlotCapacity=12;
const bookingLead=30*minute;
const dayLength=24*60*minute;
const bookingDays=7;
const hours={open:11*60*minute,close:20*60*minute};
const time=new Intl.DateTimeFormat("zh-TW",{hour:"2-digit",minute:"2-digit",hourCycle:"h23",timeZone:"Asia/Taipei"});
const date=new Intl.DateTimeFormat("zh-TW",{month:"numeric",day:"numeric",timeZone:"Asia/Taipei"});

export function pickupSlotsForDay(day){
  const range=businessDayRange(day);
  if(!range)return [];
  return Array.from({length:(hours.close-hours.open)/pickupSlotDuration},(_,index)=>range[0]+hours.open+index*pickupSlotDuration);
}

export function pickupBookingDays(now){
  return Array.from({length:bookingDays},(_,index)=>businessDate(now+index*dayLength));
}

export function bookablePickupSlots(now,day=businessDate(now)){
  if(!pickupBookingDays(now).includes(day))return [];
  return pickupSlotsForDay(day).filter(start=>start>=now+bookingLead);
}

export function bookedPickupDate(now,start){
  if(start<now+bookingLead||start>=now+bookingDays*dayLength)return null;
  const day=businessDate(start);
  return bookablePickupSlots(now,day).includes(start)?day:null;
}

export const pickupTime=start=>time.format(start);
export const pickupWindow=start=>pickupTime(start)+"～"+pickupTime(start+pickupSlotDuration);
export const datedPickupWindow=start=>date.format(start)+" "+pickupWindow(start);

export const pickupRosterReviews={unreported:"逾時未回報到店",arrived:"已到店等候過久"};

export function pickupRosterPath(day,start=null,review=null){
  const query=new URLSearchParams({date:day});
  if(start!==null)query.set("slot",String(start));
  if(Object.hasOwn(pickupRosterReviews,review))query.set("review",review);
  return "/kitchen/pickup-roster?"+query;
}

export const pickupSettingsPath=day=>"/kitchen/pickup-slots?"+new URLSearchParams({date:day});

export function pickupChangeWindows({from,to}){
  const format=businessDate(from)===businessDate(to)?pickupWindow:datedPickupWindow;
  return [format(from),format(to)];
}

export function pickupCalendarStatus(order){
  if(order.mode!=="pickup"||order.pickupSlot==null)return null;
  if(order.status==="cancelled")return "CANCELLED";
  return canPrepare(order)||order.status==="completed"?"CONFIRMED":null;
}
