"use client";

import {useState} from "react";
import {request} from "./shared";

const displayTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});

export default function PickupArrival({arrivedAt=null,arrivalRevision=0,eligible=true,pass=false,token,onChange,onInvalid}){
  const [saved,setSaved]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [withdrawal,setWithdrawal]=useState(null),[notice,setNotice]=useState(null);
  const revision=Math.max(arrivalRevision,saved?.revision??0);
  const time=(arrivalRevision===revision?arrivedAt:null)??(saved?.revision===revision?saved.time:null);
  const endpoint=pass?"/api/pickup-pass/arrival":"/api/ticket/arrival",proof=pass?"X-Pickup-Pass":"X-Ticket";
  function send(method,body){
    return request(endpoint,{method,headers:{"Content-Type":"application/json",[proof]:token},
      body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  }
  function remember(result){
    setSaved({revision:result.pickupArrivalRevision??0,time:result.pickupArrivedAt});
  }
  async function report(){
    setBusy(true);setError("");setNotice(null);setWithdrawal(null);
    try{
      remember(await send("POST",{revision}));
    }catch(failure){
      if([404,409].includes(failure.status))onInvalid?.(failure.message);
      setError(failure.status?failure.message:"尚未收到到店回報結果，請再試一次。");
    }finally{
      setBusy(false);onChange?.();
    }
  }
  async function withdraw(){
    setBusy(true);setError("");
    const {revision:expected,arrivedAt,operationId}=withdrawal;
    setWithdrawal({...withdrawal,attempted:true});
    try{
      const result=await send("PATCH",{revision:expected,arrivedAt,operationId});
      remember(result);setNotice(result.withdrawal.revision);setWithdrawal(null);
    }catch(failure){
      if(failure.status>=400&&failure.status<500)setWithdrawal(null);
      setError(failure.status&&failure.status<500?failure.message:"尚未收到撤回結果，可重試同一次操作。");
    }finally{
      setBusy(false);onChange?.();
    }
  }
  const confirming=withdrawal&&(withdrawal.attempted||(eligible&&withdrawal.revision===revision&&withdrawal.arrivedAt===time));
  if(time===null&&!eligible&&!confirming&&!error)return null;
  return <div className="pickupArrival">
    {time!==null&&<p role="status">已回報到店 · <time dateTime={new Date(time).toISOString()}>{displayTime.format(time)}</time></p>}
    {time===null&&notice===revision&&<p role="status">已撤回到店回報。到店後可以再次回報。</p>}
    {time===null&&eligible&&!confirming&&<button className="outline" type="button" disabled={busy} onClick={report}>
      {busy?"正在回報…":"我已到店"}</button>}
    {time!==null&&eligible&&!pass&&!confirming&&<button className="outline" type="button" disabled={busy}
      onClick={()=>{setError("");setWithdrawal({revision,arrivedAt:time,operationId:crypto.randomUUID()});}}>撤回到店回報</button>}
    {confirming&&<>
      {!withdrawal.attempted&&<p>店家將收起本次到店通知。抵達後可重新回報。</p>}
      <div className="actions">
        <button className="outline" type="button" disabled={busy} onClick={withdraw}>
          {busy?"正在撤回…":withdrawal.attempted?"重試撤回":"確認撤回"}</button>
        <button className="outline" type="button" disabled={busy} onClick={()=>{setError("");setWithdrawal(null);}}>關閉</button>
      </div>
    </>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
