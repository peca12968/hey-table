"use client";

import {useState} from "react";
import {PickupDelayTime,request} from "../shared";

export default function PickupDelayNotice({delay,token,onChange}){
  const [savedAt,setSavedAt]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const acknowledgedAt=delay.acknowledgedAt??savedAt;
  async function acknowledge(){
    setBusy(true);setError("");
    try{
      const saved=await request("/api/ticket/pickup-delay/acknowledge",{method:"POST",
        headers:{"Content-Type":"application/json","X-Ticket":token},body:JSON.stringify({revision:delay.revision}),
        signal:AbortSignal.timeout(10_000)});
      setSavedAt(saved.acknowledgedAt);
      onChange();
    }catch(failure){
      setError(failure.status?failure.message:"尚未收到確認結果，請再試一次。");
      if(failure.status===409)onChange();
    }finally{setBusy(false);}
  }
  return <section className="pickupDelayNotice" aria-label="取餐延誤通知">
    <p role="status">{delay.passed?
      <>原預計 <PickupDelayTime at={delay.readyAt}/> 備妥。店家仍在準備餐點。</>:
      <>店家通知 · 預計 <PickupDelayTime at={delay.readyAt}/> 備妥。</>}</p>
    {acknowledgedAt!==null?<p role="status">已確認收到這版通知。</p>:
      <><button type="button" className="outline" disabled={busy} onClick={acknowledge}>
        {busy?"正在確認…":"已收到通知"}
      </button>{error&&<p role="alert">{error}</p>}</>}
  </section>;
}
