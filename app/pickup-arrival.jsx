"use client";

import {useEffect,useState} from "react";
import {request} from "./shared";
import {read,save,withStorageLock} from "../lib/order-storage.mjs";

const displayTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});

function pendingWithdrawal(key){
  if(!key)return null;
  const entry=read(key,null);
  if(!Number.isSafeInteger(entry?.revision)||entry.revision<0||entry.revision>=Number.MAX_SAFE_INTEGER||
    !Number.isSafeInteger(entry.arrivedAt)||entry.arrivedAt<1||typeof entry.operationId!=="string"||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.operationId))return null;
  const {revision,arrivedAt,operationId}=entry;
  return {revision,arrivedAt,operationId};
}

export default function PickupArrival({arrivedAt=null,arrivalRevision=0,eligible=true,pass=false,token,receiptKey,onChange,onInvalid}){
  const [saved,setSaved]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [draft,setDraft]=useState(null),[pending,setPending]=useState(null),[notice,setNotice]=useState(null);
  const [resend,setResend]=useState(null);
  const revision=Math.max(arrivalRevision,saved?.revision??0);
  const time=(arrivalRevision===revision?arrivedAt:null)??(saved?.revision===revision?saved.time:null);
  const endpoint=pass?"/api/pickup-pass/arrival":"/api/ticket/arrival",proof=pass?"X-Pickup-Pass":"X-Ticket";
  const storageKey=receiptKey?"he-ri-arrival-withdrawal:"+receiptKey:null;
  useEffect(()=>{
    if(!storageKey)return;
    const sync=event=>{
      if(!event||event.key===storageKey||event.key===null){
        setPending(pendingWithdrawal(storageKey));
        setResend(null);
      }
    };
    sync();
    window.addEventListener("storage",sync);
    return ()=>window.removeEventListener("storage",sync);
  },[storageKey]);
  function send(method,body){
    return request(endpoint,{method,headers:{"Content-Type":"application/json",[proof]:token},
      body:JSON.stringify(body),signal:AbortSignal.timeout(10_000)});
  }
  function remember(result){
    setSaved({revision:result.pickupArrivalRevision??0,time:result.pickupArrivedAt});
  }
  async function report(){
    setBusy(true);setError("");setNotice(null);setDraft(null);
    try{
      remember(await send("POST",{revision}));
    }catch(failure){
      if([404,409].includes(failure.status))onInvalid?.(failure.message);
      setError(failure.status?failure.message:"尚未收到到店回報結果，請再試一次。");
    }finally{
      setBusy(false);onChange?.();
    }
  }
  async function clear(operation){
    const current=await withStorageLock(storageKey,()=>{
      const stored=pendingWithdrawal(storageKey);
      if(stored?.operationId!==operation.operationId)return stored;
      try{localStorage.removeItem(storageKey);}catch{}
      return null;
    });
    setPending(value=>value?.operationId===operation.operationId?current:value);
    setResend(null);
  }
  async function recover(operation){
    const result=await request(endpoint+"?"+new URLSearchParams({operationId:operation.operationId}),{
      headers:{[proof]:token},signal:AbortSignal.timeout(10_000),
    });
    remember(result);
    if(result.withdrawal?.revision===operation.revision+1&&result.withdrawal.previousArrivedAt===operation.arrivedAt){
      setNotice({revision:result.withdrawal.revision,withdrawnAt:result.withdrawal.withdrawnAt});
      await clear(operation);
    }else if(!result.withdrawal&&result.canWithdraw&&result.pickupArrivalRevision===operation.revision&&
      result.pickupArrivedAt===operation.arrivedAt){
      setResend(operation.operationId);
    }else{
      await clear(operation);
      setError("原撤回未成立，請核對目前到店狀態。");
    }
  }
  async function change(kind){
    setBusy(true);setError("");setNotice(null);
    let operation=pending;
    try{
      if(kind==="confirm"){
        const claim=await withStorageLock(storageKey,()=>{
          const existing=pendingWithdrawal(storageKey);
          if(existing)return {operation:existing,send:false};
          const operation={...draft,operationId:crypto.randomUUID()};
          save(storageKey,operation);
          return {operation,send:true};
        });
        operation=claim.operation;
        setDraft(null);setPending(operation);
        if(!claim.send)return await recover(operation);
      }
      if(kind==="recover")return await recover(operation);
      const result=await send("PATCH",operation);
      remember(result);setNotice({revision:result.withdrawal.revision,withdrawnAt:result.withdrawal.withdrawnAt});
      await clear(operation);
    }catch(failure){
      const definitive=[400,404,409].includes(failure.status);
      if(operation&&definitive)await clear(operation);
      setError(definitive?failure.message:"尚未收到撤回結果，可先查回同一次操作。");
      setResend(null);
    }finally{
      setBusy(false);onChange?.();
    }
  }
  const confirming=!pending&&draft&&eligible&&draft.revision===revision&&draft.arrivedAt===time;
  if(time===null&&!eligible&&!pending&&!error&&!notice)return null;
  return <div className="pickupArrival">
    {time!==null&&<p role="status">已回報到店 · <time dateTime={new Date(time).toISOString()}>{displayTime.format(time)}</time></p>}
    {notice&&(time===null&&notice.revision===revision?<p role="status">已撤回到店回報。到店後可以再次回報。</p>:
      <p role="status">已查回原撤回紀錄 · <time dateTime={new Date(notice.withdrawnAt).toISOString()}>{displayTime.format(notice.withdrawnAt)}</time></p>)}
    {time===null&&eligible&&!pending&&<button className="outline" type="button" disabled={busy} onClick={report}>
      {busy?"正在回報…":"我已到店"}</button>}
    {time!==null&&eligible&&!pass&&!confirming&&!pending&&<button className="outline" type="button" disabled={busy}
      onClick={()=>{setError("");setDraft({revision,arrivedAt:time});}}>撤回到店回報</button>}
    {confirming&&<>
      <p>店家將收起本次到店通知。抵達後可重新回報。</p>
      <div className="actions">
        <button className="outline" type="button" disabled={busy} onClick={()=>change("confirm")}>確認撤回</button>
        <button className="outline" type="button" disabled={busy} onClick={()=>{setError("");setDraft(null);}}>關閉</button>
      </div>
    </>}
    {pending&&<>
      <p>{resend===pending.operationId?"目前查無撤回紀錄，可以重送原操作。":"有一筆待確認的撤回操作。"}</p>
      <div className="actions">
        <button className="outline" type="button" disabled={busy} onClick={()=>change("recover")}>查回撤回結果</button>
        {resend===pending.operationId&&<button className="outline" type="button" disabled={busy}
          onClick={()=>change("resend")}>重送原撤回</button>}
      </div>
    </>}
    {error&&<p role="alert">{error}</p>}
  </div>;
}
