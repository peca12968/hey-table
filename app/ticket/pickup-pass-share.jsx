"use client";

import {useEffect,useRef,useState} from "react";
import {request} from "../shared";

const endpoint="/api/ticket/pickup-pass";
const expiresTime=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"short"});

export default function PickupPassShare({token}){
  const [open,setOpen]=useState(false),[revision,setRevision]=useState(0),[view,setView]=useState(null);
  const [busy,setBusy]=useState(false),[pending,setPending]=useState(null),[shared,setShared]=useState(null);
  const [notice,setNotice]=useState(""),[error,setError]=useState("");
  const linkInput=useRef(null);
  useEffect(()=>{
    if(!open)return;
    const abort=new AbortController();
    request(endpoint,{headers:{"X-Ticket":token},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(10_000)])})
      .then(state=>{if(!abort.signal.aborted)setView({revision,state});})
      .catch(()=>{if(!abort.signal.aborted)setView({revision,error:true});});
    return ()=>abort.abort();
  },[open,revision,token]);
  const current=view?.revision===revision?view:null,state=current?.state;
  const link=shared&&state?.revision===shared.revision?shared.url:"";
  const reload=()=>setRevision(value=>value+1);

  async function change(method,body){
    setBusy(true);setError("");setNotice("");
    try{
      const result=await request(endpoint,{method,body:JSON.stringify(body),
        headers:{"X-Ticket":token,"Content-Type":"application/json"},signal:AbortSignal.timeout(10_000)});
      setView({revision,state:result});
      setPending(null);
      setShared(method==="POST"?{revision:result.revision,url:new URL("/pickup-pass#"+body.pass,location.origin).href}:null);
      setNotice(method==="PATCH"?"代取連結已取消。":"代取連結已產生。");
    }catch(failure){
      if(failure.status){
        setPending(null);setShared(null);reload();
      }
      setError(failure.status?failure.message:"尚未收到操作結果，請再試一次。");
    }finally{setBusy(false);}
  }

  async function copy(){
    try{await navigator.clipboard.writeText(link);setNotice("已複製代取連結。");}
    catch{linkInput.current?.select();setNotice("已選取代取連結，可手動複製。");}
  }

  return <details className="pickupPassShare" onToggle={event=>{
    const expanded=event.currentTarget.open;
    setOpen(expanded);
    if(expanded)reload();
  }}>
    <summary>分享代取連結</summary>
    {open&&<section aria-label="代取連結設定">
      <p>連結有效 30 分鐘。重新產生或完成交餐後，舊連結會失效。</p>
      {error&&<p role="alert">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
      {!current&&<p role="status">正在查詢代取連結…</p>}
      {current?.error&&<><p role="alert">暫時無法查詢代取連結。</p>
        <button className="outline" onClick={reload}>重新讀取</button></>}
      {state&&<>
        {state.active&&<p>有效至 <time dateTime={new Date(state.expiresAt).toISOString()}>{expiresTime.format(state.expiresAt)}</time></p>}
        {state.active&&link&&<div className="actions">
          <input ref={linkInput} readOnly value={link} aria-label="親友代取網址"/>
          <button className="outline" disabled={busy||Boolean(pending)} onClick={copy}>複製代取連結</button>
        </div>}
        <div className="actions">
          <button className="outline" disabled={busy} onClick={()=>{
            const attempt=pending??{pass:crypto.randomUUID(),revision:state.revision};
            setPending(attempt);void change("POST",attempt);
          }}>{pending?"重試產生連結":state.active?"重新產生代取連結":"產生代取連結"}</button>
          {state.active&&<button className="outline" disabled={busy} onClick={()=>change("PATCH",{revision:state.revision})}>取消代取連結</button>}
        </div>
      </>}
    </section>}
  </details>;
}
