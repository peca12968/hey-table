"use client";
import {useCallback,useEffect,useState} from "react";
import {ClipboardCheck,RefreshCw} from "lucide-react";
import {Header,Footer,Mode,PickupAppointment,PickupDelayTime,request} from "../shared";
import {ItemNote} from "../item-notes";
import {labels,numberOf} from "../../lib/menu.mjs";
import {lastReceiptToken,pendingCarts,read,recentReceipts,refreshReceiptHistory,removeReceipt} from "../../lib/order-storage.mjs";
import BillShares from "./bill-shares";
import Payment from "./payment";
import {methods,canPrepare,canCustomerCancel} from "../../lib/payments.mjs";
import {reorderable} from "../../lib/reorder.mjs";
import {QuoteSummary} from "../cart-quote";
import CancelReceipt from "./cancel-receipt";
import ReschedulePickup from "../reschedule-pickup";
import PickupCalendar from "./pickup-calendar";
import PickupArrival from "../pickup-arrival";
import PickupCode from "../pickup-code";
import PickupPassShare from "./pickup-pass-share";
import TextDownload from "./text-download";
import CashReceipt from "../cash-receipt";
import {pickupCalendarStatus,pickupChangeWindows} from "../../lib/pickup-slots.mjs";
const progressLabels={
  pending:"已送單",preparing:"店家接單，開始製作",ready:"餐點已備妥",completed:"已交餐",cancelled:"店家已取消",
};
const cancellationLabels={customer:"顧客已取消",payment_expiry:"付款保留已到期",demo_refund:"店家退款並取消"};
const cancellationMessages={
  customer:"這張餐單已由顧客取消。",
  payment_expiry:"付款保留時間已到，餐點份數已釋回。可返回菜單重新點餐。",
};
const progressTime=new Intl.DateTimeFormat("zh-TW",{
  timeZone:"Asia/Taipei",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23",
});

function OrderProgress({history}){
  if(!history?.length)return null;
  return <section className="receiptProgress" aria-labelledby="receipt-progress">
    <h2 id="receipt-progress">餐單進度</h2>
    <ol role="list">{history.map(({status,at,actor},index)=><li key={status} aria-current={index===history.length-1?"step":undefined}>
      <span>{status==="cancelled"?(cancellationLabels[actor]??progressLabels[status]):progressLabels[status]}</span>
      {at===null?<small>時間未記錄</small>:<time dateTime={new Date(at).toISOString()}>{progressTime.format(at)}</time>}
    </li>)}</ol>
  </section>;
}

function ReceiptHistory({entries,active,open,onRemove}){
  if(!entries.length)return null;
  return <details className="receiptHistory" open={open}>
    <summary>最近餐單 <small>{entries.length} 張</small></summary>
    <ul>
      {entries.map(({id,table,created,token})=><li key={token}>
        <div>
          <a href={"/ticket#"+token} aria-current={token===active?"page":undefined}>取餐號碼 {numberOf(id)}</a>
          <small>{table?table+" 桌內用":"線上自取"} · {progressTime.format(created)}</small>
        </div>
        <button type="button" className="outline" aria-label={"從本機移除 "+numberOf(id)} onClick={()=>onRemove(token,id)}>移除</button>
      </li>)}
    </ul>
  </details>;
}

export default function Ticket(){
  const [order,setOrder]=useState(null),[error,setError]=useState(""),[refresh,setRefresh]=useState(0);
  const [recent,setRecent]=useState([]);
  const refreshReceipt=useCallback(()=>setRefresh(v=>v+1),[]);
  const [route,setRoute]=useState(null);
  const selectReceipt=useCallback(()=>{
    const pending=location.hash?[]:pendingCarts();
    const ref=new URLSearchParams(location.search).get("payment");
    const direct=Boolean(location.hash||ref);
    const token=location.hash.slice(1)||(ref?read("he-ri-payment:"+ref,null):lastReceiptToken());
    setOrder(null);
    setError(!token&&!pending.length?"這台裝置還沒有餐單。":"");
    setRoute({token,pending,direct});
  },[]);
  useEffect(()=>{
    const syncHistory=()=>setRecent(recentReceipts());
    syncHistory();
    selectReceipt();
    window.addEventListener("hashchange",selectReceipt);
    window.addEventListener("storage",syncHistory);
    return ()=>{
      window.removeEventListener("hashchange",selectReceipt);
      window.removeEventListener("storage",syncHistory);
    };
  },[selectReceipt]);
  useEffect(()=>{
    if(!route?.token)return;
    const controller=new AbortController();
    let inFlight=false;
    async function load(){
      if(inFlight)return;
      inFlight=true;
      try{
        const value=await request("/api/ticket?progress=1&timing=1",{headers:{"X-Ticket":route.token},signal:controller.signal});
        if(!controller.signal.aborted){
          setOrder(value);setError("");
          if(refreshReceiptHistory(route.token,value))setRecent(recentReceipts());
        }
      }catch(e){if(!controller.signal.aborted)setError(e.message);}
      finally{inFlight=false;}
    }
    load();const timer=setInterval(load,5000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[route,refresh]);
  function forget(token,id){
    if(!window.confirm("從這個瀏覽器移除取餐號碼 "+numberOf(id)+" 的查單紀錄？"))return;
    removeReceipt(token);
    setRecent(recentReceipts());
    if(!route?.direct&&route?.token===token)selectReceipt();
  }
  const pending=route?.pending??[];
  const menu=order?.table?"/?table="+order.table:"/";
  const cancellationActor=order?.statusHistory?.at(-1)?.actor;
  const latestMove=order?.tableMoves?.at(-1);
  const latestPickup=order?.pickupChanges?.at(-1);
  const [previousWindow,newWindow]=latestPickup?pickupChangeWindows(latestPickup):[];
  const calendarStatus=order&&pickupCalendarStatus(order);
  const closedBeforePayment=Object.hasOwn(cancellationMessages,cancellationActor);
  const showHold=order?.paymentDueAt&&order.paymentMethod!=="cash"&&canCustomerCancel(order);
  const payable=order&&canPrepare(order);
  const refundBeforeHandoff=order?.paymentState==="refunded"&&!["completed","cancelled"].includes(order.status);
  const pendingMessage=payable?(order.pickupSlot!=null?"已保留取餐時段，店家會在接近取餐時間時準備。":"餐單已送達，等候店家接單。"):
    (order?.pickupSlot!=null?"完成付款後，店家會依預約時段備餐。":"付款確認後，店家即可接單。");
  return <><Header/><main className="shell narrow"><article className="sheet receipt"><ClipboardCheck size={30}/><p className="eyebrow">ORDER RECEIPT</p><h1>{order?"取餐號碼 "+numberOf(order.id):"我的餐單"}</h1>
    {pending.length>0&&<section><h2>待確認的餐單</h2>{pending.map(table=><p key={table??"pickup"}><a className="outline" href={table?"/?table="+table:"/"}>確認 {table?table+" 桌":"自取"}送單結果</a></p>)}</section>}
    <ReceiptHistory entries={recent} active={route?.token} open={route&&!route.direct} onRemove={forget}/>
    {error&&<p role="status">{error}</p>}{order&&<><div className="receiptMeta"><Mode table={order.table} source={order.source}/><b aria-live="polite">{order.status==='pending'&&!payable&&!refundBeforeHandoff?'等待付款':labels[order.status]}</b></div>
    <PickupAppointment start={order.pickupSlot}/>
    {latestPickup&&<p className="muted" role="status">{latestPickup.actor==="staff"?"店家已將取餐時段從":"取餐時段已從"} {previousWindow} 改到 {newWindow}。</p>}
    {calendarStatus&&<PickupCalendar key={"pickup-calendar-"+route.token+calendarStatus} id={order.id} token={route.token}
      status={calendarStatus} onChange={refreshReceipt}/>}
    {order.pickupSlot!=null&&<ReschedulePickup key={"pickup-reschedule-"+route.token} order={order} onChange={refreshReceipt} ticket={route.token}
      submit={(change,signal)=>request("/api/ticket/reschedule",{method:"POST",headers:{"Content-Type":"application/json","X-Ticket":route.token},
        body:JSON.stringify(change),signal})}/>}
    {latestMove&&<p className="muted" role="status">店家已將餐單從 {latestMove.from} 桌移到 {latestMove.to} 桌。</p>}
    <p>{refundBeforeHandoff?"這張餐單已全額退款，請聯絡店家確認交餐安排。":
      ({pending:pendingMessage,preparing:"廚房正在準備餐點。",ready:order.table?"餐點已完成，請留意桌邊送餐。":"餐點已完成，請出示取餐號碼。",completed:"這張餐單已完成。",cancelled:cancellationMessages[cancellationActor]??"店家已取消這張餐單。"})[order.status]}</p>
    {showHold&&<p className="muted">付款保留至 <time dateTime={new Date(order.paymentDueAt).toISOString()}>{progressTime.format(order.paymentDueAt)}</time></p>}
    {!error&&order.pickupDelay&&<p role="status" className="pickupDelayNotice">{order.pickupDelay.passed?
      <>原預計 <PickupDelayTime at={order.pickupDelay.readyAt}/> 備妥。店家仍在準備餐點。</>:
      <>店家通知 · 預計 <PickupDelayTime at={order.pickupDelay.readyAt}/> 備妥。</>}</p>}
    {!error&&!order.pickupDelay&&order.kitchenQuote&&<section className="cartQuote" aria-label="餐單出餐估算">
      <span>目前廚房排程</span>
      <QuoteSummary quote={order.kitchenQuote}/>
      <small>工時按完整批次估算，餐點備妥時會更新進度。</small>
    </section>}
    {order.mode==="pickup"&&order.status==="ready"&&payable&&<>
      <PickupCode key={"pickup-code-"+route.token} number={numberOf(order.id)}/>
      <PickupPassShare key={"pickup-pass-"+route.token} token={route.token}/>
    </>}
    {order.mode==="pickup"&&<PickupArrival key={"pickup-arrival-"+route.token} arrivedAt={order.pickupArrivedAt}
      eligible={["preparing","ready"].includes(order.status)&&payable} token={route.token} onChange={refreshReceipt}/>}
    <OrderProgress history={order.statusHistory}/>
    <ul className="orderLines">{order.items.map(d=><li key={d.id}><div><b>{d.name} × {d.qty}</b><ItemNote note={d.note}/></div><span>NT$ {d.price*d.qty}</span></li>)}</ul>
    {order.combo&&<p>餐點原價 NT$ {order.combo.quote.subtotal} · 套餐折抵 NT$ {order.combo.quote.discount}</p>}
    {order.note&&<p>備註　{order.note}</p>}<div className="total"><span>{methods[order.paymentMethod]}</span><b>NT$ {order.total}</b></div>
    {order.cashReceipt&&<CashReceipt record={order.cashReceipt}/>}
    <TextDownload key={"order-details-"+route.token} kind="order" token={route.token} id={order.id}/>
    {order.paymentMethod!=="cash"&&!closedBeforePayment&&<Payment key={"payment-"+route.token} order={order} token={route.token} onChange={refreshReceipt}/>}
    {canCustomerCancel(order)&&<CancelReceipt key={route.token} token={route.token} onChange={refreshReceipt}/>}
    <button className="outline" onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={16}/> 更新進度</button></>}
    {order&&reorderable(order)&&<p><a className="outline" href={menu+"#reorder="+encodeURIComponent(route.token)}>再次點餐</a></p>}
    <a className="textLink" href={menu}>回到點餐菜單</a></article>
    {order && order.status!=="cancelled" && order.paymentState!=="refunded" && <BillShares key={order.id+":"+order.created} order={order}/>}
    </main><Footer/></>;
}
