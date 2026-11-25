"use client";

import {useEffect,useRef,useState} from "react";
import {pickupWindow} from "../lib/pickup-slots.mjs";
import {request} from "./shared";

export default function PickupSuggestion({date,items,onChoose,endpoint="/api/pickup-suggestion",staffHeaders}){
  const [view,setView]=useState(null);
  const pending=useRef(null);
  useEffect(()=>()=>pending.current?.abort(),[]);

  async function find(){
    if(pending.current)return;
    const controller=new AbortController();
    pending.current=controller;
    setView({loading:true});
    try{
      const {suggestion}=await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders?.()},
        body:JSON.stringify({afterDate:date,items}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])});
      if(!controller.signal.aborted)setView({suggestion});
    }catch{
      if(!controller.signal.aborted)setView({error:true});
    }finally{pending.current=null;}
  }

  const suggestion=view?.suggestion;
  return <section className="pickupSlots" aria-label="其他可用取餐日期">
    <div className="actions">
      <button type="button" className="outline" disabled={view?.loading} onClick={find}>
        {view?.loading?"正在尋找…":"找下一個可用日期"}
      </button>
      {suggestion&&<button type="button" className="outline" onClick={()=>onChoose(suggestion)}>使用此時段</button>}
    </div>
    {view&&!view.loading&&<p role="status">{suggestion?`${suggestion.date} · ${pickupWindow(suggestion.start)}`:
      view.error?"暫時無法尋找可用日期，請再試一次。":"接下來的可預約日期沒有符合這張餐單的時段。"}</p>}
  </section>;
}
