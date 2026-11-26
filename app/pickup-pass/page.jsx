"use client";

import {useEffect,useState,useSyncExternalStore} from "react";
import {Header,Footer,PickupAppointment,request} from "../shared";
import PickupArrival from "../pickup-arrival";
import PickupCode from "../pickup-code";
import {ProgressTime} from "../order-progress";
import {numberOf} from "../../lib/menu.mjs";

const subscribe=notify=>{
  window.addEventListener("hashchange",notify);
  return ()=>window.removeEventListener("hashchange",notify);
};
const browserPass=()=>location.hash.slice(1);
const serverPass=()=>null;
const expiresTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"short"});

export default function SharedPickup(){
  const token=useSyncExternalStore(subscribe,browserPass,serverPass);
  const [revision,setRevision]=useState(0),[view,setView]=useState(null);
  useEffect(()=>{
    if(!token)return;
    const abort=new AbortController();
    let timer;
    async function load(){
      try{
        const pass=await request("/api/pickup-pass?handoff=1",{headers:{"X-Pickup-Pass":token},
          signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)])});
        if(!abort.signal.aborted)setView({token,revision,pass});
        if(pass.status==="completed")return;
      }catch(error){
        const ended=error.status===404;
        if(!abort.signal.aborted)setView({token,revision,error:ended?error.message:"暫時無法讀取代取連結。"});
        if(ended)return;
      }
      if(!abort.signal.aborted)timer=setTimeout(load,5000);
    }
    void load();
    return ()=>{abort.abort();clearTimeout(timer);};
  },[token,revision]);
  const current=view?.token===token&&view.revision===revision?view:null;
  const pass=current?.pass;
  const reload=()=>setRevision(value=>value+1);
  return <><Header/><main className="shell narrow section"><article className="sheet pickupPass">
    <h1>{pass?"取餐號碼 "+numberOf(pass.id):"親友代取"}</h1>
    {token===""&&<p role="alert">請開啟原訂餐人提供的完整代取連結。</p>}
    {token!==""&&!current&&<p role="status">正在查詢代取連結…</p>}
    {current?.error&&<><p role="alert">{current.error}</p>
      <button className="outline" onClick={reload}>重新讀取</button></>}
    {pass?.status==="completed"?<div className="pickupArrival">
      <p role="status">取餐已完成 · <ProgressTime at={pass.completedAt}/></p>
    </div>:pass&&<>
      <p>餐點已備妥。到店後請出示取餐 QR 碼。</p>
      <PickupAppointment start={pass.pickupSlot}/>
      <PickupArrival key={token} arrivedAt={pass.pickupArrivedAt} token={token} pass onInvalid={reload}/>
      <PickupCode key={token} number={numberOf(pass.id)} pass={pass.revision+"."+token}/>
      <p className="muted">連結有效至 <time dateTime={new Date(pass.expiresAt).toISOString()}>{expiresTime.format(pass.expiresAt)}</time></p>
    </>}
  </article></main><Footer/></>;
}
