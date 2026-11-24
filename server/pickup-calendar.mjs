import {numberOf,restaurant} from "../lib/menu.mjs";
import {pickupSlotDuration} from "../lib/pickup-slots.mjs";

const encoder=new TextEncoder();
const calendarTime=timestamp=>new Date(timestamp).toISOString().replace(/[-:]/g,"").replace(/\.\d{3}Z$/,"Z");
const calendarText=text=>text.replace(/\\/g,"\\\\").replace(/\r\n|\n|\r/g,"\\n").replace(/[;,]/g,"\\$&");

function fold(line){
  let result="",bytes=0;
  for(const character of line){
    const size=encoder.encode(character).length;
    if(bytes+size>75){result+="\r\n ";bytes=1;}
    result+=character;
    bytes+=size;
  }
  return result;
}

export async function pickupCalendar({id,token,created,start,modified,revision,status}){
  const hash=await crypto.subtle.digest("SHA-256",encoder.encode(`hey-table.pickup-calendar.v1:${id}:${created}:${token}`));
  const uid=Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("")+"@hey-table.invalid";
  const lines=["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Hey Table//Pickup Calendar//ZH-TW","CALSCALE:GREGORIAN",
    "BEGIN:VEVENT","UID:"+uid,"DTSTAMP:"+calendarTime(modified),"CREATED:"+calendarTime(created),
    "DTSTART:"+calendarTime(start),"DTEND:"+calendarTime(start+pickupSlotDuration),"SEQUENCE:"+revision,
    "STATUS:"+status,"CLASS:PRIVATE","SUMMARY:"+calendarText(restaurant+" · 自取 "+numberOf(id)),"END:VEVENT","END:VCALENDAR"];
  return lines.map(fold).join("\r\n")+"\r\n";
}
