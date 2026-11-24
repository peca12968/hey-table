"use client";
import {useCallback,useEffect,useState} from "react";
import {ClipboardCheck,RefreshCw} from "lucide-react";
import {Header,Footer,Mode,request} from "../shared";
import {labels,numberOf} from "../../lib/menu.mjs";
import {pendingCarts,read} from "../../lib/order-storage.mjs";
import BillShares from "./bill-shares";
import Payment from "./payment";
import {methods,canPrepare} from "../../lib/payments.mjs";
import {reorderable} from "../../lib/reorder.mjs";
const progressLabels={
  pending:"已送單",preparing:"店家接單，開始製作",ready:"餐點已備妥",completed:"已交餐",cancelled:"店家已取消",
};
const progressTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});

function OrderProgress({history}){
  if(!history?.length)return null;
  return <section className="receiptProgress" aria-labelledby="receipt-progress">
    <h2 id="receipt-progress">餐單進度</h2>
    <ol role="list">{history.map(({status,at},index)=><li key={status} aria-current={index===history.length-1?"step":undefined}>
      <span>{progressLabels[status]}</span>
      {at===null?<small>時間未記錄</small>:<time dateTime={new Date(at).toISOString()}>{progressTime.format(at)}</time>}
    </li>)}</ol>
  </section>;
}

export default function Ticket(){
  const [order,setOrder]=useState(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  const refreshReceipt=useCallback(()=>setRefresh(v=>v+1),[]);
  const [route,setRoute]=useState(null);
  useEffect(()=>{
    function selectReceipt(){
      const pending=location.hash?[]:pendingCarts();
      const ref=new URLSearchParams(location.search).get("payment");
      const token=location.hash.slice(1)||(ref?read("he-ri-payment:"+ref,null):read("he-ri-last",null));
      setOrder(null);
      setError(!token&&!pending.length?"這台裝置還沒有餐單。":"");
      setRoute({token,pending});
    }
    selectReceipt();
    window.addEventListener("hashchange",selectReceipt);
    return ()=>window.removeEventListener("hashchange",selectReceipt);
  },[]);
  useEffect(()=>{
    if(!route?.token)return;
    const controller=new AbortController();
    let inFlight=false;
    async function load(){
      if(inFlight)return;
      inFlight=true;
      try{
        const value=await request("/api/ticket?progress=1",{headers:{"X-Ticket":route.token},signal:controller.signal});
        if(!controller.signal.aborted){setOrder(value);setError("");}
      }catch(e){if(!controller.signal.aborted)setError(e.message);}
      finally{inFlight=false;}
    }
    load();const timer=setInterval(load,5000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[route,refresh]);
  const pending=route?.pending??[];
  const menu=order?.table?"/?table="+order.table:"/";
  return <><Header/><main className="shell narrow"><article className="sheet receipt"><ClipboardCheck size={30}/><p className="eyebrow">ORDER RECEIPT</p><h1>{order?"取餐號碼 "+numberOf(order.id):"我的餐單"}</h1>
    {pending.length>0&&<section><h2>待確認的餐單</h2>{pending.map(table=><p key={table??"pickup"}><a className="outline" href={table?"/?table="+table:"/"}>確認 {table?table+" 桌":"自取"}送單結果</a></p>)}</section>}
    {error&&<p role="status">{error}</p>}{order&&<><div className="receiptMeta"><Mode table={order.table}/><b aria-live="polite">{order.status==='pending'&&!canPrepare(order)?'等待付款':labels[order.status]}</b></div>
    <p>{({pending:canPrepare(order)?"餐單已送達，等候店家接單。":"付款確認後，店家即可接單。",preparing:"廚房正在準備餐點。",ready:order.table?"餐點已完成，請留意桌邊送餐。":"餐點已完成，請出示取餐號碼。",completed:"這張餐單已完成。",cancelled:"店家已取消這張餐單。"})[order.status]}</p>
    <OrderProgress history={order.statusHistory}/>
    <ul className="orderLines">{order.items.map(d=><li key={d.id}><b>{d.name} × {d.qty}</b><span>NT$ {d.price*d.qty}</span></li>)}</ul>
    {order.combo&&<p>餐點原價 NT$ {order.combo.quote.subtotal} · 套餐折抵 NT$ {order.combo.quote.discount}</p>}
    {order.note&&<p>備註　{order.note}</p>}<div className="total"><span>{methods[order.paymentMethod]}</span><b>NT$ {order.total}</b></div>
    {order.paymentMethod!=="cash"&&<Payment key={order.id} order={order} token={route.token} onChange={refreshReceipt}/>}
    <button className="outline" onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={16}/> 更新進度</button></>}
    {order&&reorderable(order)&&<p><a className="outline" href={menu+"#reorder="+encodeURIComponent(route.token)}>再次點餐</a></p>}
    <a className="textLink" href={menu}>回到點餐菜單</a></article>
    {order && order.status!=="cancelled" && <BillShares key={order.id+":"+order.created} order={order}/>}
    </main><Footer/></>;
}
