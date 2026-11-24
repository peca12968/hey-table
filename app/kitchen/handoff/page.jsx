"use client";
import {useEffect,useState} from "react";
import {Printer} from "lucide-react";
import {Header,Footer,Mode,request} from "../../shared";
import {numberOf} from "../../../lib/menu.mjs";
import "./slip.css";

function fetchSlip(number,signal){
  const staffKey=sessionStorage.getItem("he-ri-staff");
  return request("/api/kitchen/handoff?id="+encodeURIComponent(number),{
    headers:staffKey?{Authorization:"Bearer "+staffKey}:{},signal,
  });
}

export default function Handoff(){
  const [number,setNumber]=useState("");
  const [slip,setSlip]=useState(null);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(true);
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    const id=new URLSearchParams(location.search).get("id")??"";
    setNumber(id);
    setBusy(true);
    setError("");
    fetchSlip(id,controller.signal).then(value=>{
      if(!controller.signal.aborted)setSlip(value);
    }).catch(err=>{
      if(!controller.signal.aborted){setSlip(null);setError(err.message);}
    }).finally(()=>{
      if(!controller.signal.aborted)setBusy(false);
    });
    return ()=>controller.abort();
  },[retry]);

  async function print(){
    if(!slip||busy)return;
    setBusy(true);
    setMessage("");
    try{
      const latest=await fetchSlip(number);
      if(latest.status!==slip.status||latest.table!==slip.table){
        setSlip(latest);
        setMessage(latest.table!==slip.table?"桌號已更新，請核對後再列印。":"交餐狀態已更新，請核對後再列印。");
      }else{
        window.print();
      }
    }catch(err){
      setSlip(null);
      setError(err.message);
    }finally{
      setBusy(false);
    }
  }

  return <><Header/><main className="shell narrow handoffSlip">
    <a className="textLink slipControl" href="/kitchen">返回店家接單台</a>
    <h1 className="slipControl">交餐小票</h1>
    {error&&<p className="error slipControl" role="alert">{error}</p>}
    {busy&&!slip&&<p className="slipControl" role="status">正在讀取交餐小票…</p>}
    {slip&&<article className="sheet slipPaper" aria-label="交餐小票內容">
      <p>禾日食堂 · 交餐小票</p>
      <h2>取餐號碼 {numberOf(slip.id)}</h2>
      <div className="receiptMeta"><Mode table={slip.table}/><strong>{slip.status==="ready"?"待交餐":"已交餐"}</strong></div>
      <ul className="orderLines">{slip.items.map((item,index)=><li key={index}><span>{item.name}</span><strong>× {item.qty}</strong></li>)}</ul>
    </article>}
    {message&&<p className="slipControl" role="status">{message}</p>}
    {slip?<button className="primary slipControl" disabled={busy} onClick={print}><Printer size={16}/>列印交餐小票</button>:
      error&&<button className="outline slipControl" disabled={busy} onClick={()=>setRetry(value=>value+1)}>重新讀取</button>}
  </main><Footer/></>;
}
