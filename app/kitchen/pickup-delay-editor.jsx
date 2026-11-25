"use client";

import {useState} from "react";
import {PickupDelayTime,request} from "../shared";

const initial={revision:0,readyAt:null};

export default function PickupDelayEditor({id,record,staffKey,disabled,onChange,showEstimate=true}){
  const [local,setLocal]=useState(null),[draft,setDraft]=useState(null),[pending,setPending]=useState(null);
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(""),[error,setError]=useState("");
  const server=record??initial, current=local&&local.revision>server.revision?local:server;
  const stale=draft!==null&&draft.revision!==current.revision;
  const minutes=Number(draft?.minutes??"");
  const valid=Number.isInteger(minutes)&&minutes>=1&&minutes<=240;

  async function save(value){
    const body=pending??{id,operationId:crypto.randomUUID(),revision:draft?.revision??current.revision,minutes:value};
    setPending(body);setBusy(true);setNotice("");setError("");
    try{
      const saved=await request("/api/kitchen/pickup-delay",{method:"PATCH",
        headers:{"Content-Type":"application/json",...(staffKey?{Authorization:"Bearer "+staffKey}:{})},
        body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
      setPending(null);setDraft(null);setLocal(saved);
      setNotice(body.minutes===null?"已撤回備妥時間通知。":"已更新顧客收據上的備妥時間。");
      onChange();
    }catch(failure){
      if(failure.status){
        setPending(null);
        onChange();
      }
      setError(failure.status?failure.message:"尚未收到更新結果，請重試原操作。");
    }finally{setBusy(false);}
  }

  return <details className="pickupPassShare pickupDelay">
    <summary><span>通知取餐延誤</span>{current.readyAt!==null&&
      <small className="muted"> · {current.acknowledgedAt!=null?"顧客已確認":"等待顧客確認"}</small>}</summary>
    {showEstimate&&current.readyAt!==null&&<p>目前預計 <PickupDelayTime at={current.readyAt}/> 備妥</p>}
    <form onSubmit={event=>{
      event.preventDefault();
      if(!disabled&&!busy&&(pending||!stale&&valid))void save(minutes);
    }}>
      <label>預計還需幾分鐘<input type="number" min="1" max="240" step="1" inputMode="numeric"
        value={draft?.minutes??""} disabled={disabled||busy||Boolean(pending)} onChange={event=>{
          setDraft({revision:draft?.revision??current.revision,minutes:event.target.value});
          setNotice("");setError("");
        }}/></label>
      <div className="actions">
        <button className="outline" disabled={disabled||busy||(!pending&&(stale||!valid))}>
          {pending?"重試原操作":"通知顧客"}</button>
        {current.readyAt!==null&&<button type="button" className="outline" disabled={disabled||busy||Boolean(pending)||stale}
          onClick={()=>save(null)}>撤回通知</button>}
        {stale&&!pending&&<button type="button" className="outline" onClick={()=>{setDraft(null);setError("");}}>改用最新版</button>}
      </div>
    </form>
    {stale&&!pending&&<p>備妥時間已由其他店員更新。</p>}
    {error&&<p role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
  </details>;
}
