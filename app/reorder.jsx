"use client";
import {useEffect,useState} from "react";
import {dishes} from "../lib/menu.mjs";
import {reorderable,reorderPlan} from "../lib/reorder.mjs";
import {request} from "./shared";

export default function Reorder({token,table,sold,remaining,loaded,cart,blocked,onAdd,onClose}){
  const [order,setOrder]=useState(null),[error,setError]=useState("");
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();
    setError("");
    request("/api/ticket",{headers:{"X-Ticket":token},signal:controller.signal}).then(value=>{
      if(controller.signal.aborted)return;
      if(!reorderable(value)||value.table!==table){
        setError("無法帶入這張餐單，請從已結單的收據重新開啟。");
        return;
      }
      setOrder(value);
    }).catch(()=>{
      if(!controller.signal.aborted)setError("目前無法讀取原餐單，請稍後重試。");
    });
    return ()=>controller.abort();
  },[token,table,retry]);
  const plan=order&&loaded?reorderPlan(order.items,dishes,sold,cart,remaining):null;
  const available=plan?.some(row=>row.added>0);
  return <section className="reorder" aria-labelledby="reorder-title">
    <h3 id="reorder-title">再次點餐</h3>
    <p>請確認本次點餐管道與餐點，金額依目前菜單計算。</p>
    {error?<p role="alert">{error}</p>:!plan?<p aria-live="polite">正在核對原餐單與菜單…</p>:
      <ul>{plan.map(row=><li key={row.id}>{row.name} · {row.added?"可加入 "+row.added+" 份":row.reason}
        {row.added>0&&row.reason&&<small> · {row.reason}</small>}</li>)}</ul>}
    {blocked&&<p>請先確認目前這張餐單的送單結果。</p>}
    <div className="actions">
      {error&&<button className="outline" onClick={()=>setRetry(value=>value+1)}>重試讀取</button>}
      <button className="outline" disabled={!available||blocked} onClick={()=>{if(!onAdd(plan))setError("請先確認目前這張餐單的送單結果。");}}>加入這些餐點</button>
      <button className="outline" onClick={onClose}>取消帶入</button>
    </div>
  </section>;
}
