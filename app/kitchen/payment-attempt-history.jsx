"use client";

import {useEffect,useState} from "react";
import {request} from "../shared";
import {paymentStates} from "../../lib/payments.mjs";
import "./payment-attention-notes.css";

const endpoint="/api/kitchen/payment-attempt-history",detailPath="/kitchen/order-detail";
const clock=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium",hourCycle:"h23"});
const time=at=><time dateTime={new Date(at).toISOString()}>{clock.format(at)}</time>;

export default function PaymentAttemptHistory({id,query,autoOpen}){
  const [open,setOpen]=useState(autoOpen),[version,setVersion]=useState(0),[view,setView]=useState(null);
  const params=new URLSearchParams(query),before=params.get("paymentBefore");
  const current=view?.version===version?view:null;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController(),key=sessionStorage.getItem("he-ri-staff");
    const filters=new URLSearchParams({id});
    if(before!==null)filters.set("before",before);
    request(endpoint+"?"+filters,{headers:key?{Authorization:"Bearer "+key}:{},
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])}).then(data=>{
      if(!controller.signal.aborted)setView({version,data});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({version,error:error.name==="TimeoutError"?"讀取付款嘗試逾時，請重新讀取。":error.message});
    });
    return ()=>controller.abort();
  },[id,before,open,version]);

  function pageLink(cursor){
    const next=new URLSearchParams(query);
    next.set("attempts","1");
    next.delete("paymentBefore");
    if(cursor!==null)next.set("paymentBefore",cursor);
    return detailPath+"?"+next+"#payment-attempt-history";
  }

  function noteLink(attemptId){
    const next=new URLSearchParams(query);
    next.set("attempts","1");
    next.set("notes","1");
    next.set("attempt",attemptId);
    return detailPath+"?"+next+"#payment-attention-notes";
  }

  const data=current?.data;
  return <details id="payment-attempt-history" className="paymentAttentionNotes" open={open}
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>歷次付款嘗試</summary>
    {open&&<div>
      {!current&&<p role="status">正在讀取付款嘗試…</p>}
      {current?.error&&<p className="error" role="alert">{current.error}</p>}
      {data&&<>
        {data.attempts.length>0?<ol className="paymentAttentionNoteList" aria-label="付款嘗試歷程">
          {data.attempts.map(attempt=><li key={attempt.attemptId}>
            <p><strong>第 {attempt.number} 次付款 · {Object.hasOwn(paymentStates,attempt.state)?
              paymentStates[attempt.state]:"付款狀態未記錄"}</strong>{attempt.latest&&" · 最新"}</p>
            <p>{attempt.startedAt>0?<>付款開始 {time(attempt.startedAt)}</>:"付款開始時間未記錄"}</p>
            {attempt.lastCheckedAt>0&&<p>最近發出金流查詢 {time(attempt.lastCheckedAt)}</p>}
            {attempt.firstPayableAt>0&&<p>首次可接單 {time(attempt.firstPayableAt)}</p>}
            <a className="textLink" href={noteLink(attempt.attemptId)}>
              第 {attempt.number} 次付款備註（{attempt.noteCount} 筆）
            </a>
          </li>)}
        </ol>:<p>{before===null?"這張餐單尚無付款嘗試。":"已到最早的付款嘗試。"}</p>}
        {(before!==null||data.nextBefore!==null)&&<nav className="actions paymentAttemptPages" aria-label="付款嘗試分頁">
          {before!==null&&<a className="outline" href={pageLink(null)}>返回最新付款嘗試</a>}
          {data.nextBefore!==null&&<a className="outline" href={pageLink(data.nextBefore)}>查看更早的付款嘗試</a>}
        </nav>}
      </>}
      {current&&<button className="outline paymentAttentionNotesRefresh" onClick={()=>setVersion(value=>value+1)}>重新讀取付款嘗試</button>}
    </div>}
  </details>;
}
