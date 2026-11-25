"use client";

import {useEffect,useState} from "react";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";
import {request} from "../../shared";

const changedTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const actions={slot:"單時段調整",batch:"批次調整",day:"整日預約"};
const accepting=value=>value?"開放":"暫停";

export default function PickupLimitHistory({date,defaultCapacity,revision,staffHeaders}){
  const [opened,setOpened]=useState(false),[page,setPage]=useState(null),[view,setView]=useState(null);
  const [retry,setRetry]=useState(0);
  const before=page?.revision===revision?page.before:null;
  useEffect(()=>{
    if(!opened)return;
    const query=new URLSearchParams({date});
    if(before!==null)query.set("before",String(before));
    const controller=new AbortController();
    request("/api/kitchen/pickup-slots/history?"+query,{headers:staffHeaders(),
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])}).then(report=>{
      if(!controller.signal.aborted)setView({revision,before,retry,report});
    }).catch(()=>{
      if(!controller.signal.aborted)setView({revision,before,retry,error:true});
    });
    return ()=>controller.abort();
  },[opened,date,revision,before,retry,staffHeaders]);
  const current=view?.revision===revision&&view.before===before&&view.retry===retry?view:null;
  const capacity=value=>value===null?`預設 ${defaultCapacity} 份`:`${value} 份`;

  return <details className="sheet limitHistory" onToggle={event=>setOpened(event.currentTarget.open)}>
    <summary>查看預約調整紀錄</summary>
    {opened&&<section aria-label="預約調整紀錄">
      <p className="muted">取餐日 {date} · 變更時間以台灣時間顯示</p>
      {!current&&<p role="status">正在讀取調整紀錄…</p>}
      {current?.error&&<><p role="alert">暫時無法讀取調整紀錄。</p>
        <button className="outline" onClick={()=>setRetry(value=>value+1)}>重讀紀錄</button></>}
      {current?.report&&<>
        {current.report.events.length===0&&<p>這一天沒有已記錄的調整。</p>}
        <ol>{current.report.events.map(event=><li key={event.id}>
          <h3>{actions[event.kind]}{event.kind==="batch"?` · ${event.changes.length} 個時段`:""}</h3>
          <time dateTime={new Date(event.changedAt).toISOString()}>{changedTime.format(event.changedAt)}</time>
          <ul>{event.changes.map(change=>event.kind==="day"?<li key="day">{accepting(change.previousAccepting)} → {accepting(change.accepting)}</li>:
            <li key={change.start}>{pickupWindow(change.start)} · {capacity(change.previousCapacity)} → {capacity(change.capacity)}</li>)}</ul>
        </li>)}</ol>
        <div className="actions">
          {before!==null&&<button className="outline" onClick={()=>setPage(null)}>回最新紀錄</button>}
          {current.report.nextBefore!==null&&<button className="outline" onClick={()=>setPage({revision,before:current.report.nextBefore})}>較早紀錄</button>}
        </div>
      </>}
    </section>}
  </details>;
}
