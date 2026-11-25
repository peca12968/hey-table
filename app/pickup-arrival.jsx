"use client";

import {useState} from "react";
import {request} from "./shared";

const displayTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});

export default function PickupArrival({arrivedAt,eligible=true,pass=false,token,onChange,onInvalid}){
  const [reportedAt,setReportedAt]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const time=arrivedAt??reportedAt;
  if(time===null&&!eligible)return null;
  async function report(){
    setBusy(true);setError("");
    try{
      const endpoint=pass?"/api/pickup-pass/arrival":"/api/ticket/arrival";
      const proof=pass?"X-Pickup-Pass":"X-Ticket";
      const result=await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",[proof]:token},
        body:"{}",signal:AbortSignal.timeout(10_000)});
      setReportedAt(result.pickupArrivedAt);
    }catch(failure){
      if(failure.status===404)onInvalid?.(failure.message);
      setError(failure.status?failure.message:"尚未收到到店回報結果，請再試一次。");
    }finally{
      setBusy(false);onChange?.();
    }
  }
  return <div className="pickupArrival">
    {time!==null?<p role="status">已回報到店 · <time dateTime={new Date(time).toISOString()}>{displayTime.format(time)}</time></p>:
      <><button className="outline" type="button" disabled={busy} onClick={report}>{busy?"正在回報…":"我已到店"}</button>
        {error&&<p role="alert">{error}</p>}</>}
  </div>;
}
