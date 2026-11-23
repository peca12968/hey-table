"use client";
import {useEffect,useState} from "react";
import {Clock3} from "lucide-react";
import {request} from "./shared";

const localTime = new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});
function minutes(seconds) {
  const [low,high] = seconds.map(s=>Math.ceil(s/60));
  return (low===high ? String(low) : low+"–"+high)+" 分鐘";
}

export default function CartQuote({body}) {
  const [quote,setQuote]=useState(null), [error,setError]=useState(""), [revision,setRevision]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      try {
        const result=await request("/api/quote",{method:"POST",signal:controller.signal,
          headers:{"Content-Type":"application/json"},body});
        if(!controller.signal.aborted)setQuote(result);
      } catch(e) {
        if(!controller.signal.aborted)setError(e.status===409 ? e.message : "暫時無法試算，可繼續點餐。");
      }
    },revision ? 0 : 250);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[body,revision]);
  function refresh(){setQuote(null);setError("");setRevision(v=>v+1);}
  return <section className="cartQuote" aria-label="預估出餐時間">
    <div className="quoteHead"><span><Clock3 size={16} aria-hidden="true"/> 預估出餐</span>
      <button type="button" onClick={refresh} disabled={!quote&&!error}>重新試算</button></div>
    <div role="status">{quote ? <><strong>約 {minutes(quote.seconds)}</strong>
      <small>{localTime.format(quote.capturedAt)} 依製作中餐單與{quote.timingSource==="store"?"店家設定工時":"示範工時"}估算</small></> : error || "正在試算…"}</div>
  </section>;
}
