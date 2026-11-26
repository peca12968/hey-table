"use client";

import {useEffect,useRef,useState} from "react";
import {pickupWindow} from "../lib/pickup-slots.mjs";
import {request} from "./shared";

export function PickupChoiceList({choices,onChoose,disabled=false}){
  return <ul aria-label="可用取餐時段" className="pickupSuggestions">
    {choices.map(slot=>{
      const title=slot.date+" · "+pickupWindow(slot.start);
      return <li key={slot.start}>
        <span>{title} · 剩 {slot.remaining} 份</span>
        <button type="button" className="outline" aria-label={"選擇 "+title} disabled={disabled}
          onClick={()=>onChoose(slot)}>使用此時段</button>
      </li>;
    })}
  </ul>;
}

export default function PickupSuggestion({date,items,fromSlot,onChoose,endpoint="/api/pickup-suggestion",staffHeaders}){
  const [view,setView]=useState(null);
  const pending=useRef(null);
  useEffect(()=>()=>pending.current?.abort(),[]);

  async function find(alternatives){
    if(pending.current)return;
    const controller=new AbortController();
    pending.current=controller;
    setView({loading:true,alternatives});
    try{
      const result=await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders?.()},
        body:JSON.stringify({afterDate:date,items,...(alternatives?{alternatives:true,fromSlot}:{})}),
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])});
      if(!controller.signal.aborted)setView({alternatives,...result});
    }catch{
      if(!controller.signal.aborted)setView({error:true,alternatives});
    }finally{pending.current=null;}
  }

  const suggestion=view?.suggestion;
  return <section className="pickupSlots" aria-label="其他可用取餐日期">
    <div className="actions">
      <button type="button" className="outline" disabled={view?.loading} onClick={()=>find(true)}>
        {view?.loading&&view.alternatives?"正在尋找…":"比較可用取餐時段"}
      </button>
      <button type="button" className="outline" disabled={view?.loading} onClick={()=>find(false)}>
        {view?.loading&&!view.alternatives?"正在尋找…":"找下一個可用日期"}
      </button>
      {suggestion&&<button type="button" className="outline" onClick={()=>onChoose(suggestion)}>使用此時段</button>}
    </div>
    {view&&!view.loading&&<p role="status">{suggestion?`${suggestion.date} · ${pickupWindow(suggestion.start)}`:
      view.error?"暫時無法尋找可用日期，請再試一次。":view.suggestions?.length?
        "找到 "+view.suggestions.length+" 個可用時段。選擇後會重新核對供應。":"接下來的可預約日期沒有符合這張餐單的時段。"}</p>}
    {view?.suggestions?.length>0&&<PickupChoiceList choices={view.suggestions} onChoose={onChoose}/>}
  </section>;
}
