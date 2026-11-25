"use client";

import {useEffect,useState} from "react";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";
import {request} from "../../shared";

const changedTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});
const actions={slot:"單時段調整",batch:"批次調整",day:"整日預約"};
const accepting=value=>value?"開放":"暫停";

function restorePlan(event,snapshot,slots){
  if(event.kind==="day"){
    const {accepting,revision,editable}=snapshot.intake,target=event.changes[0].previousAccepting;
    return editable&&accepting!==target?{intake:{accepting,target},input:{revision}}:null;
  }
  const affected=event.changes.map(change=>({slot:slots.get(change.start),target:change.previousCapacity}));
  if(affected.some(({slot})=>!slot?.editable)||!affected.some(({slot,target})=>slot.capacity!==target))return null;
  return {affected,input:{slots:affected.map(({slot:{start,revision}})=>({start,revision}))}};
}

export default function PickupLimitHistory({snapshot,busy,revision,staffHeaders,save}){
  const {date,defaultCapacity}=snapshot;
  const [opened,setOpened]=useState(false),[page,setPage]=useState(null),[view,setView]=useState(null);
  const [retry,setRetry]=useState(0),[review,setReview]=useState(null);
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
  const slots=new Map(snapshot.slots.map(slot=>[slot.start,slot]));

  async function confirm(fromId,plan){
    await save("/api/kitchen/pickup-slots/restore",{date,fromId,...plan.input},
      plan.intake?"已還原整日預約狀態。":`已還原 ${plan.affected.length} 個時段的上限。`);
    setReview(null);
  }

  return <details className="sheet limitHistory" onToggle={event=>{
    const open=event.currentTarget.open;
    setOpened(open);
    if(!open)setReview(null);
  }}>
    <summary>查看預約調整紀錄</summary>
    {opened&&<section aria-label="預約調整紀錄">
      <p className="muted">取餐日 {date} · 變更時間以台灣時間顯示</p>
      {!current&&<p role="status">正在讀取調整紀錄…</p>}
      {current?.error&&<><p role="alert">暫時無法讀取調整紀錄。</p>
        <button className="outline" onClick={()=>setRetry(value=>value+1)}>重讀紀錄</button></>}
      {current?.report&&<>
        {current.report.events.length===0&&<p>這一天沒有已記錄的調整。</p>}
        <ol>{current.report.events.map(event=>{
          const plan=restorePlan(event,snapshot,slots);
          const preview=review?.id===event.id&&review.revision===revision?review.plan:null;
          return <li key={event.id}>
            <h3>{event.restoredFromId?"還原 · ":""}{event.sourceDate?"跨日複製":actions[event.kind]}{event.kind==="batch"?` · ${event.changes.length} 個時段`:""}</h3>
            <p className="historyEventDate">第 {event.id} 筆 · <time dateTime={new Date(event.changedAt).toISOString()}>{changedTime.format(event.changedAt)}</time>
              {event.restoredFromId&&<> · 依第 {event.restoredFromId} 筆還原</>}
              {event.sourceDate&&<> · 來源日 {event.sourceDate}</>}</p>
            <ul>{event.changes.map(change=>event.kind==="day"?<li key="day">{accepting(change.previousAccepting)} → {accepting(change.accepting)}</li>:
              <li key={change.start}>{pickupWindow(change.start)} · {capacity(change.previousCapacity)} → {capacity(change.capacity)}</li>)}</ul>
            {preview?<section className="pickupRestore" aria-label="核對還原設定">
              <h4>核對還原設定</h4>
              {preview.intake?<p>整日預約 · {accepting(preview.intake.accepting)} → {accepting(preview.intake.target)}</p>:
                <ul>{preview.affected.map(({slot,target})=><li key={slot.start}>
                  {pickupWindow(slot.start)} · {capacity(slot.capacity)} → {capacity(target)} · 已占用 {slot.used} 份
                </li>)}</ul>}
              <p>既有預約會保留。</p>
              <div className="actions">
                <button className="primary" disabled={busy} onClick={()=>confirm(event.id,preview)}>確認還原</button>
                <button className="outline" disabled={busy} onClick={()=>setReview(null)}>取消還原</button>
              </div>
            </section>:plan&&<button className="outline historyRestoreButton" disabled={busy}
              onClick={()=>setReview({id:event.id,revision,plan})}>預覽還原變更前設定</button>}
          </li>;
        })}</ol>
        <div className="actions">
          {before!==null&&<button className="outline" onClick={()=>{setReview(null);setPage(null);}}>回最新紀錄</button>}
          {current.report.nextBefore!==null&&<button className="outline" onClick={()=>{
            setReview(null);setPage({revision,before:current.report.nextBefore});
          }}>較早紀錄</button>}
        </div>
      </>}
    </section>}
  </details>;
}
