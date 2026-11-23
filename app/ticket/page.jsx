"use client";
import {useEffect,useState} from "react";
import {ClipboardCheck,RefreshCw} from "lucide-react";
import {Header,Footer,Mode,request} from "../shared";
import {labels,numberOf} from "../../lib/menu.mjs";
import {pendingCarts,read} from "../../lib/order-storage.mjs";
export default function Ticket(){
  const [order,setOrder]=useState(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  const [pending,setPending]=useState([]);
  useEffect(()=>{
    let live=true;
    const carts=location.hash?[]:pendingCarts();
    setPending(carts);
    const token=location.hash.slice(1)||read("he-ri-last",null);
    if(!token){setError(carts.length?"":"這台裝置還沒有餐單。");return;}
    const load=async()=>{try{const value=await request("/api/ticket",{headers:{"X-Ticket":token}});if(live){setOrder(value);setError("");}}catch(e){if(live)setError(e.message);}};
    load();const t=setInterval(load,5000);return()=>{live=false;clearInterval(t);};
  },[refresh]);
  return <><Header/><main className="shell narrow"><article className="sheet receipt"><ClipboardCheck size={30}/><p className="eyebrow">ORDER RECEIPT</p><h1>{order?"取餐號碼 "+numberOf(order.id):"我的餐單"}</h1>
    {pending.length>0&&<section><h2>待確認的餐單</h2>{pending.map(table=><p key={table??"pickup"}><a className="outline" href={table?"/?table="+table:"/"}>確認 {table?table+" 桌":"自取"}送單結果</a></p>)}</section>}
    {error&&<p role="status">{error}</p>}{order&&<><div className="receiptMeta"><Mode table={order.table}/><b aria-live="polite">{labels[order.status]}</b></div>
    <p>{({pending:"餐單已送達，等候店家接單。",preparing:"廚房正在準備餐點。",ready:order.table?"餐點已完成，請留意桌邊送餐。":"餐點已完成，請出示取餐號碼。",completed:"這張餐單已完成。",cancelled:"店家已取消這張餐單。"})[order.status]}</p>
    <ul className="orderLines">{order.items.map(d=><li key={d.id}><b>{d.name} × {d.qty}</b><span>NT$ {d.price*d.qty}</span></li>)}</ul>
    {order.note&&<p>備註　{order.note}</p>}<div className="total"><span>現場付款</span><b>NT$ {order.total}</b></div>
    <button className="outline" onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={16}/> 更新進度</button></>}
    <a className="textLink" href={order?.table?"/?table="+order.table:"/"}>回到點餐菜單</a></article></main><Footer/></>;
}
