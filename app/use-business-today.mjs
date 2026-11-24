import {useSyncExternalStore} from "react";
import {businessDate,businessDayRange} from "../lib/business-day.mjs";

const getToday=()=>businessDate(Date.now());
const serverToday=()=>"";

function listenForDayChange(notify){
  let timer;
  function refresh(){
    clearTimeout(timer);
    const now=Date.now(),[,end]=businessDayRange(businessDate(now));
    timer=setTimeout(refresh,end-now);
    notify();
  }
  refresh();
  document.addEventListener("visibilitychange",refresh);
  return ()=>{clearTimeout(timer);document.removeEventListener("visibilitychange",refresh);};
}

export function useBusinessToday(){
  return useSyncExternalStore(listenForDayChange,getToday,serverToday);
}
