"use client";

import {useEffect,useState} from "react";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";

export default function CopySlotLimits({snapshot,busy,loadSource,save}){
  const {date,defaultCapacity}=snapshot;
  const [sourceDate,setSourceDate]=useState(""),[query,setQuery]=useState(null),[view,setView]=useState(null);
  const [selected,setSelected]=useState([]);
  useEffect(()=>{
    if(!query)return;
    const controller=new AbortController();
    loadSource(query.sourceDate,AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]))
      .then(source=>{if(!controller.signal.aborted)setView({query,source});})
      .catch(error=>{if(!controller.signal.aborted)setView({query,error:
        error.name==="TimeoutError"?"讀取來源時段逾時，請重試。":error.message});});
    return ()=>controller.abort();
  },[query,loadSource]);

  const current=view?.query===query?view:null;
  const latest=new Map(snapshot.slots.map(slot=>[slot.start,slot]));
  const targets=query?new Map(query.slots.map(slot=>[pickupWindow(slot.start),slot])):null;
  const changes=current?.source?current.source.slots.flatMap(source=>{
    const window=pickupWindow(source.start),target=targets.get(window);
    return target?.editable&&target.capacity!==source.capacity?[{window,source,target}]:[];
  }):[];
  const reviewed=changes.filter(({target})=>selected.includes(target.start));
  const stale=reviewed.some(({target})=>!latest.get(target.start)?.editable||latest.get(target.start).revision!==target.revision);
  const capacity=value=>value===null?`預設 ${defaultCapacity} 份`:`${value} 份`;

  async function apply(){
    if(busy||stale||!reviewed.length)return;
    await save("/api/kitchen/pickup-slots/copy",{date,sourceDate:query.sourceDate,
      slots:reviewed.map(({source,target})=>({start:target.start,revision:target.revision,sourceRevision:source.revision})),
    },`已複製 ${reviewed.length} 個時段的上限。`);
    setQuery(null);setSelected([]);
  }

  if(!snapshot.intake.editable&&!query)return null;
  return <details className="sheet copySlotLimits">
    <summary>從其他日期複製時段上限</summary>
    <form className="actions pickupLimitControls" onSubmit={event=>{
      event.preventDefault();
      if(busy||!sourceDate||sourceDate===date)return;
      setSelected([]);setQuery({sourceDate,slots:snapshot.slots});
    }}>
      <label>來源日期<input type="date" required value={sourceDate} disabled={busy} onChange={event=>{
        setSourceDate(event.target.value);setQuery(null);setSelected([]);
      }}/></label>
      <button className="outline" disabled={busy||!sourceDate||sourceDate===date}>比較時段上限</button>
    </form>
    {sourceDate===date&&<p role="status">請選擇不同於目的日的來源日期。</p>}
    {query&&!current&&<p role="status">正在讀取來源時段…</p>}
    {current?.error&&<p role="alert">{current.error}</p>}
    {current?.source&&<section aria-label="比較預約時段上限">
      <p>目的日 {date} · 套用後會保留既有預約與整日開放狀態。</p>
      {changes.length===0?<p>可調整的時段上限相同。</p>:<>
        <button className="outline" disabled={busy||reviewed.length===changes.length}
          onClick={()=>setSelected(changes.map(({target})=>target.start))}>選取全部差異</button>
        <ul>{changes.map(({source,target,window})=>{
          const used=latest.get(target.start)?.used??target.used;
          return <li key={target.start}>
            <label><input type="checkbox" aria-label={window} checked={selected.includes(target.start)} disabled={busy}
              onChange={event=>{
                const checked=event.target.checked;
                setSelected(values=>checked?[...values,target.start]:values.filter(start=>start!==target.start));
              }}/>
              <span><strong>{window}</strong><span>{capacity(target.capacity)} → {capacity(source.capacity)}</span>
                <small>目的日已占用 {used} 份{(source.capacity??defaultCapacity)<=used?" · 套用後暫停新增預約":""}</small></span>
            </label>
          </li>;
        })}</ul>
        {stale&&<p role="status">目的設定已更新，請重新比較時段。</p>}
        <button className="primary" disabled={busy||stale||!reviewed.length} onClick={apply}>套用已選時段上限</button>
      </>}
    </section>}
  </details>;
}
