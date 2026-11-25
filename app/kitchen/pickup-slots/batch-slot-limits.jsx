"use client";

import {useState} from "react";
import {pickupWindow} from "../../../lib/pickup-slots.mjs";

export default function BatchSlotLimits({snapshot,busy,save}){
  const [selected,setSelected]=useState([]),[value,setValue]=useState(""),[review,setReview]=useState(null);
  const editable=snapshot.slots.filter(slot=>slot.editable);
  const chosen=editable.filter(slot=>selected.includes(slot.start));
  const capacity=value===""?null:Number(value);
  const valid=capacity===null||(Number.isSafeInteger(capacity)&&capacity>=0);
  const changed=chosen.filter(slot=>slot.capacity!==capacity);
  if(!editable.length&&!review)return null;

  async function confirm(){
    const {capacity,slots}=review;
    const saved=await save("/api/kitchen/pickup-slot-batch",{date:snapshot.date,capacity,
      slots:slots.map(({start,revision})=>({start,revision}))},`已批次儲存 ${slots.length} 個時段。`);
    if(saved){setSelected([]);setValue("");}
    setReview(null);
  }

  return <details className="sheet batchSlotLimits">
    <summary>批次調整時段上限</summary>
    {review?<section aria-label="預覽時段上限">
      <h2>確認調整 {review.slots.length} 個時段</h2>
      <p>新上限 {review.capacity??snapshot.defaultCapacity} 份{review.capacity===null?"（預設）":""}。既有預約會保留。</p>
      <ul>{review.slots.map(slot=><li key={slot.start}>{pickupWindow(slot.start)} · 已占用 {slot.used} 份 · 原上限 {slot.capacity??snapshot.defaultCapacity} 份</li>)}</ul>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={confirm}>確認批次儲存</button>
        <button className="outline" disabled={busy} onClick={()=>setReview(null)}>返回選擇</button>
      </div>
    </section>:<form onSubmit={event=>{
      event.preventDefault();
      if(!busy&&valid&&changed.length)setReview({capacity,slots:changed});
    }}>
      <fieldset disabled={busy}>
        <legend>選擇要調整的時段</legend>
        <div className="batchSlotOptions">{editable.map(slot=><label key={slot.start}>
          <input type="checkbox" checked={selected.includes(slot.start)} onChange={event=>{
            const checked=event.target.checked;
            setSelected(values=>checked?[...values,slot.start]:values.filter(start=>start!==slot.start));
          }}/>{pickupWindow(slot.start)}
        </label>)}</div>
      </fieldset>
      <div className="actions batchSlotControls">
        <label>新的份數上限<input type="number" min="0" step="1" max={Number.MAX_SAFE_INTEGER} inputMode="numeric"
          value={value} disabled={busy} placeholder={"預設 "+snapshot.defaultCapacity} onChange={event=>setValue(event.target.value)}/></label>
        <button className="outline" disabled={busy||!valid||!changed.length}>預覽調整</button>
      </div>
      {selected.length>0&&<p role="status">{changed.length?`將調整 ${changed.length} 個時段。`:
        chosen.length?"所選時段已是這個上限。":"請選擇仍可調整的時段。"}</p>}
    </form>}
  </details>;
}
