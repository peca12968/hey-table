"use client";

import {useEffect,useState} from "react";
import {request} from "../shared";
import "./payment-attention-notes.css";

const sectionId="pickup-delay-history";
const time=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"medium",hourCycle:"h23"});
const timestamp=at=><time dateTime={new Date(at).toISOString()}>{time.format(at)}</time>;

export default function PickupDelayHistory({id,query,autoOpen}){
  const [open,setOpen]=useState(autoOpen),[version,setVersion]=useState(0),[view,setView]=useState(null);
  const before=new URLSearchParams(query).get("delayBefore");
  const current=view?.version===version?view:null,data=current?.data;
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController(),key=sessionStorage.getItem("he-ri-staff");
    const params=new URLSearchParams({id});
    if(before!==null)params.set("before",before);
    request("/api/kitchen/pickup-delay-history?"+params,{headers:key?{Authorization:"Bearer "+key}:{},
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])}).then(data=>{
      if(!controller.signal.aborted)setView({version,data});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({version,error:error.name==="TimeoutError"?"讀取延誤通知紀錄逾時，請再試一次。":error.message});
    });
    return ()=>controller.abort();
  },[id,before,open,version]);

  function pageLink(cursor){
    const next=new URLSearchParams(query);
    next.set("delays","1");
    next.delete("delayBefore");
    if(cursor!==null)next.set("delayBefore",cursor);
    return "/kitchen/order-detail?"+next+"#"+sectionId;
  }

  return <details id={sectionId} className="paymentAttentionNotes" open={open}
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>自取延誤通知紀錄</summary>
    {open&&<div>
      {!current&&<p role="status">正在讀取延誤通知紀錄…</p>}
      {current?.error&&<p role="alert" className="error">{current.error}</p>}
      {data&&<>
        {data.updates.length?<ol role="list" className="paymentAttentionNoteList" aria-label="延誤通知歷程">
          {data.updates.map(({revision,readyAt,recordedAt,acknowledgedAt,latest})=><li key={revision}>
            <p><strong>第 {revision} 版 · {readyAt===null?"撤回通知":"發布通知"}</strong> {timestamp(recordedAt)}
              {latest&&" · 最新紀錄"}</p>
            {readyAt!==null&&<>
              <p>預計備妥 {timestamp(readyAt)}</p>
              <p>{acknowledgedAt===null?"未確認收到":<>顧客確認 {timestamp(acknowledgedAt)}</>}</p>
            </>}
          </li>)}
        </ol>:<p>{before===null?"這張餐單尚無延誤通知。":"已到最早的延誤通知。"}</p>}
        {(before!==null||data.nextBefore!==null)&&<nav className="actions paymentAttemptPages" aria-label="延誤通知分頁">
          {before!==null&&<a className="outline" href={pageLink(null)}>返回最新通知</a>}
          {data.nextBefore!==null&&<a className="outline" href={pageLink(data.nextBefore)}>查看更早的通知</a>}
        </nav>}
      </>}
      {current&&<button className="outline paymentAttentionNotesRefresh" onClick={()=>setVersion(value=>value+1)}>重新讀取延誤紀錄</button>}
    </div>}
  </details>;
}
