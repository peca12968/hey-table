"use client";
import {useEffect,useMemo,useState,useSyncExternalStore} from "react";
import {RefreshCw} from "lucide-react";
import {Header,Footer,Mode,PickupAppointment,request} from "../shared";
import {pickupChangeWindows,pickupPrepLead,pickupRosterPath,pickupSlotsForDay,pickupTime} from "../../lib/pickup-slots.mjs";
import {businessDate,businessDayRange} from "../../lib/business-day.mjs";
import {ItemNote} from "../item-notes";
import ReschedulePickup from "../reschedule-pickup";
import {useBusinessToday} from "../use-business-today.mjs";
import {dishes,labels,numberOf,tables,transitions} from "../../lib/menu.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import Timing from "./timing";
import ReturnReceipt from "./return-receipt";
import PaymentSnapshot from "./payment-snapshot";
import Intake from "./intake";
import CashCollection from "./cash-collection";
import PickupDelayEditor from "./pickup-delay-editor";
import {methods,paymentStates,environmentLabel,canPrepare,canCancel} from "../../lib/payments.mjs";
const action={preparing:"接單製作",ready:"完成製作",completed:"完成交餐",cancelled:"取消訂單"};
const overdueStage={pending:"待接單",preparing:"製作中",ready:"待交餐"};
const paymentCheckMessages={
  noAttempt:"這張餐單還沒有付款嘗試。",
  unavailable:"目前環境無法查詢這筆付款，請用對應的金流後台核對。",
  notQueryable:"這筆付款的狀態目前無法重新查詢，畫面保留最後一次紀錄。",
  recent:"剛發出過金流查詢，請稍候再試。",
  unconfirmed:"本次未取得可核對的金流紀錄，畫面保留最後一次紀錄。",
  changed:"查詢期間付款紀錄有更新，請核對重新載入的狀態。",
};
const browserSearch=()=>window.location.search;
const serverSearch=()=>null;
const browserStaffKey=()=>sessionStorage.getItem("he-ri-staff")||"";
const anonymousKey=()=>"";
const ignoreStorageChanges=()=>()=>{};
const waitingPickup=order=>order.mode==="pickup"&&order.pickupArrivedAt!=null&&
  ["preparing","ready"].includes(order.status)&&canPrepare(order);

function subscribeToLocation(notify){
  window.addEventListener("popstate",notify);
  return ()=>window.removeEventListener("popstate",notify);
}

function kitchenFocus(search){
  if(search===null)return undefined;
  const query=new URLSearchParams(search);
  if(query.has("paymentReview")){
    const number=query.get("paymentReview"),id=Number(number),date=query.get("date");
    const validDate=query.getAll("date").length===1&&Boolean(businessDayRange(date));
    const validNumber=query.getAll("paymentReview").length===1&&/^[0-9]+$/.test(number)&&Number.isSafeInteger(id)&&id>0;
    return {kind:"payment-review",number:validDate&&validNumber?numberOf(id):"",date,
      back:validDate?"/kitchen/daily?"+new URLSearchParams({date}):"/kitchen/daily",signInTarget:"/kitchen"+search};
  }
  const kind=query.has("pickup")?"pickup":"booking";
  const number=query.get(kind);
  if(number===null)return null;
  const id=Number(number);
  const valid=/^[0-9]+$/.test(number)&&Number.isSafeInteger(id)&&id>0;
  const day=query.get("date"),slot=query.get("slot");
  const start=pickupSlotsForDay(day).find(value=>String(value)===slot)??null;
  const roster=kind==="booking"&&businessDayRange(day)?pickupRosterPath(day,start):"/kitchen/pickup-roster";
  return {kind,number:valid?numberOf(id):"",roster,signInTarget:"/kitchen"+search};
}

function TableMove({id,table,revision,busy,update}){
  const [destination,setDestination]=useState("");
  return <details className="tableMove">
    <summary>更換桌號</summary>
    <form className="actions" onSubmit={event=>{
      event.preventDefault();
      if(destination&&!busy)update("table",{id,from:table,to:destination,revision});
    }}>
      <label>新桌號<select required value={destination} disabled={busy} onChange={event=>setDestination(event.target.value)}>
        <option value="">選擇桌號</option>
        {tables.filter(value=>value!==table).map(value=><option key={value} value={value}>{value} 桌</option>)}
      </select></label>
      <button className="outline" disabled={busy||!destination}>確認換桌</button>
    </form>
  </details>;
}

function TableHandoff({table,orders,busy,update}){
  const [review,setReview]=useState(null);
  const eligible=orders.length>=2&&orders.every(canPrepare);
  const current=eligible&&review?.length===orders.length&&review.every((order,index)=>
    order.id===orders[index].id&&(order.tableRevision??0)===(orders[index].tableRevision??0));
  if(!review&&orders.length<2)return null;
  return <section className="sheet tableHandoff" aria-label={table+" 桌同桌交餐"}>
    <h2>{table} 桌同桌交餐</h2>
    {!review&&<button className="outline" disabled={busy||!eligible} onClick={()=>setReview(orders)}>
      核對 {orders.length} 張待交餐餐單
    </button>}
    {!review&&!eligible&&<p>請先核對這桌餐單的付款狀態。</p>}
    {review&&<>
      <ul className="tableHandoffOrders">{review.map(order=><li key={order.id}>
        <b>#{numberOf(order.id)}</b>
        <ul className="orderLines">{order.items.map(dish=><li key={dish.id}><div><span>{dish.name}</span><ItemNote note={dish.note}/></div><b>×{dish.qty}</b></li>)}</ul>
        {order.note&&<p>備註　{order.note}</p>}
      </li>)}</ul>
      {!current&&<p role="status">這桌的待交餐餐單已更新，請重新核對。</p>}
      <div className="actions">
        <button className="primary" disabled={busy||!current} onClick={async()=>{
          const confirmed=await update("table-handoff",{table,orders:review.map(order=>({id:order.id,tableRevision:order.tableRevision??0}))});
          if(confirmed)setReview(null);
        }}>確認交餐 {review.length} 張餐單</button>
        {!current&&eligible&&<button className="outline" disabled={busy} onClick={()=>setReview(orders)}>重新核對這桌</button>}
        <button className="outline" disabled={busy} onClick={()=>setReview(null)}>關閉核對</button>
      </div>
    </>}
  </section>;
}

function KitchenTicket({order,busy,update,movePickup,recordCash,refresh,today,staffKey,showOverdue=false,handoffOnly=false,paymentReview=false,paymentCheck}){
  const {id,status,table,created,items,note,paymentMethod,paymentEnv,paymentState,total}=order;
  const actions=handoffOnly ? transitions[status].filter(next=>next==="completed") : transitions[status];
  const workingByStation=order.stationProgress&&status==="preparing";
  const tableRevision=order.tableRevision??0;
  const latestPickup=order.latestPickupChange;
  const [previousWindow,newWindow]=latestPickup?pickupChangeWindows(latestPickup):[];
  const prepAt=order.pickupUpcoming?order.pickupSlot-pickupPrepLead:null;
  const prepDay=prepAt===null?"":businessDate(prepAt);
  const canDemoRefund=!handoffOnly&&!paymentReview&&paymentEnv==="demo"&&paymentState==="paid"&&paymentMethod!=="cash";
  const canCheckPayment=!handoffOnly&&paymentMethod!=="cash"&&["sandbox","production"].includes(paymentEnv);
  return <article className="sheet kitchenTicket">
    <div className="menuTitle"><h2>#{numberOf(id)}</h2><Mode table={table} source={order.source}/></div>
    <p aria-live={handoffOnly?"polite":undefined}><b>{labels[status]}</b> · {paymentReview&&businessDate(created)+" "}
      {new Date(created).toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Taipei"})}</p>
    <PickupAppointment start={order.pickupSlot}/>
    {waitingPickup(order)&&<p className="pickupArrived">顧客已到店 · <time dateTime={new Date(order.pickupArrivedAt).toISOString()}>
      {pickupTime(order.pickupArrivedAt)}</time></p>}
    {latestPickup&&<p className="muted" role="status">{latestPickup.actor==="staff"?"店員":"顧客"}已將取餐時段從 {previousWindow} 改到 {newWindow}。</p>}
    {prepAt!==null&&<p className="muted">{prepDay>today?prepDay+" ":""}{pickupTime(prepAt)} 後可接單製作。</p>}
    {showOverdue&&order.overdue&&<p className="kitchenOverdue">逾時 · {overdueStage[status]} {Math.floor(order.overdue.elapsedMs/60_000)} 分鐘</p>}
    <ul className="orderLines">{items.map(dish=><li key={dish.id}><div>{dish.name}<ItemNote note={dish.note}/></div><b>×{dish.qty}</b></li>)}</ul>
    {note&&<p>備註　{note}</p>}
    <p>{Object.hasOwn(methods,paymentMethod)?methods[paymentMethod]:"付款方式未記錄"} {paymentMethod!=="cash"&&
      [environmentLabel(paymentEnv)||"環境未記錄",Object.hasOwn(paymentStates,paymentState)?paymentStates[paymentState]:"付款狀態未記錄"].join(" · ")}</p>
    {paymentReview&&paymentMethod==="cash"&&!order.cashReceipt&&<p>未登記現金</p>}
    {order.cashPaymentChange&&<p className="muted">顧客已由 {methods[order.cashPaymentChange.fromMethod]} 改為現場付款。</p>}
    <div className="total"><span>合計</span><b>NT$ {total}</b></div>
    {paymentMethod==="cash"&&["ready","completed"].includes(status)&&
      <CashCollection order={order} disabled={busy} submit={recordCash} onChange={refresh}/>}
    {!handoffOnly&&order.mode==="pickup"&&status==="preparing"&&canPrepare(order)&&
      <PickupDelayEditor id={id} record={order.pickupDelay} staffKey={staffKey} disabled={busy} onChange={refresh}/>}
    <div className="actions">
      {["ready","completed"].includes(status)&&<a className="outline" href={"/kitchen/handoff?id="+numberOf(id)}>交餐小票</a>}
      {workingByStation&&<a className="primary" href="/kitchen/station-work">查看分站進度</a>}
      {canCheckPayment&&<button className="outline" disabled={busy} onClick={()=>update("payment",{id})}>
        {paymentCheck?.checking?"正在查詢金流…":"查詢金流"}</button>}
      {canDemoRefund&&<button className="outline" disabled={busy} onClick={()=>{
        const effect=["completed","cancelled"].includes(status)?"保留現有餐單狀態。":"同時取消未交餐的餐單並釋回份數。";
        if(window.confirm("確認模擬全額退款 NT$ "+total+"？"+effect))
          update("demo-refund",{id,expectedTotal:total,expectedStatus:status});
      }}>模擬全額退款</button>}
      {!workingByStation&&actions.map(next=><button disabled={busy||(next==="preparing"&&order.pickupUpcoming)||
        (next==="cancelled"?!canCancel(order):!canPrepare(order))} className={next==="cancelled"?"outline":"primary"} key={next}
        onClick={()=>{if(next!=="cancelled"||window.confirm("取消這張訂單？"))
          update("status",{id,from:status,to:next,...(table&&next==="completed"?{tableRevision}:{}),
            ...(next==="preparing"&&order.pickupSlot!=null?{pickupRevision:order.pickupRevision??0}:{})});}}>{action[next]}</button>)}
    </div>
    {canCheckPayment&&paymentCheck?.message&&<p role="status">{paymentCheck.message}</p>}
    {table&&["pending","preparing","ready"].includes(status)&&<TableMove
      key={table+":"+tableRevision} id={id} table={table} revision={tableRevision} busy={busy} update={update}/>}
    {!handoffOnly&&!paymentReview&&order.pickupSlot!=null&&<ReschedulePickup order={order} canReschedule={Boolean(order.pickupUpcoming)} disabled={busy}
      submit={(change,signal)=>movePickup(id,change,signal)} onChange={refresh} staffKey={staffKey}/>}
  </article>;
}

export default function Kitchen(){
  const [entry,setEntry]=useState(""),[denied,setDenied]=useState(false),[rows,setRows]=useState(null);
  const [sold,setSold]=useState([]),[filter,setFilter]=useState("active"),[error,setError]=useState(""),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false),[exportMessage,setExportMessage]=useState("");
  const [scope,setScope]=useState("all"),[search,setSearch]=useState("");
  const [queueAvailable,setQueueAvailable]=useState(false);
  const [actionMessage,setActionMessage]=useState("");
  const [paymentCheck,setPaymentCheck]=useState(null);
  const today=useBusinessToday();
  const key=useSyncExternalStore(ignoreStorageChanges,browserStaffKey,anonymousKey);
  const locationSearch=useSyncExternalStore(subscribeToLocation,browserSearch,serverSearch);
  const focus=useMemo(()=>kitchenFocus(locationSearch),[locationSearch]);
  const focused=Boolean(focus),handoffOnly=focus?.kind==="pickup";
  const paymentReview=focus?.kind==="payment-review";
  const title=paymentReview?"交班付款核對":handoffOnly?"自取交餐":focused?"自取預約餐單":"店家接單台";
  useEffect(()=>{
    if(focus===undefined||focus?.number==="")return;
    const controller=new AbortController();
    const headers=key?{Authorization:"Bearer "+key}:{};
    let inFlight=false;
    async function load(){
      if(inFlight)return;
      inFlight=true;
      try{
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
        const options={headers,signal};
        if(focus){
          const endpoint=focus.kind==="booking"?"pickup-booking":focus.kind;
          const params=new URLSearchParams({id:focus.number,...(paymentReview?{date:focus.date}:{})});
          const order=await request("/api/kitchen/"+endpoint+"?"+params,options);
          if(!controller.signal.aborted)setRows([order]);
        }else{
          const [orders,menu]=await Promise.all([request("/api/kitchen",options),request("/api/menu",{signal})]);
          if(!controller.signal.aborted){setRows(orders);setSold(menu.unavailable);setQueueAvailable(true);}
        }
        if(!controller.signal.aborted){setDenied(false);setError("");}
      }catch(e){
        if(!controller.signal.aborted){
          setQueueAvailable(false);
          setDenied(e.status===403);
          if(e.status===403||focus)setRows(null);
          setError(e.name==="TimeoutError"?"讀取餐單逾時，請稍後重試。":e.message);
        }
      }finally{inFlight=false;}
    }
    load();
    const timer=paymentReview?null:setInterval(load,5000);
    return()=>{controller.abort();clearInterval(timer);};
  },[key,revision,focus,paymentReview]);
  async function update(endpoint,body){
    setBusy(true);setError("");setActionMessage("");
    const checkingPayment=endpoint==="payment";
    if(checkingPayment)setPaymentCheck({id:body.id,checking:true});
    try{
      const result=await request("/api/kitchen/"+endpoint,{method:"PATCH",headers:{"Content-Type":"application/json",...(key?{Authorization:"Bearer "+key}:{})},
        body:JSON.stringify(body),...(checkingPayment?{signal:AbortSignal.timeout(30000)}:{})});
      if(checkingPayment){
        const label=Object.hasOwn(paymentStates,result.paymentState)?paymentStates[result.paymentState]:"付款狀態未記錄";
        const message=result.outcome==="matched"?"本次金流查詢結果為「"+label+"」。":
          paymentCheckMessages[result.outcome]??"未收到金流查詢結果，請稍後再試。";
        setPaymentCheck({id:body.id,message});
      }
      if(focused&&endpoint==="status"){
        setRows(null);
        setActionMessage(handoffOnly?"已完成交餐。":"餐單已更新為「"+labels[body.to]+"」。");
      }
      if(endpoint==="table")setActionMessage("餐單 "+numberOf(body.id)+" 已換到 "+body.to+" 桌。");
      if(endpoint==="demo-refund"){
        setRows(rows=>rows?.map(order=>order.id===result.id?{...order,status:result.status,paymentState:result.paymentState,
          pickupUpcoming:false,overdue:undefined}:order)??null);
        setActionMessage("餐單 "+numberOf(result.id)+" 已模擬全額退款 NT$ "+result.total+"。");
      }
      if(endpoint==="table-handoff"){
        const ids=new Set(body.orders.map(order=>order.id));
        setRows(rows=>rows?.map(order=>ids.has(order.id)?{...order,status:"completed",overdue:undefined}:order)??null);
        setActionMessage(result.table+" 桌已完成 "+result.completed+" 張餐單的交餐。");
      }
      setRevision(v=>v+1);
      return true;
    }catch(e){
      if(checkingPayment){
        setPaymentCheck({id:body.id,message:"無法查詢金流，請稍後再查。"});
        setRevision(v=>v+1);
      }else if(focused){
        setActionMessage(e.status===409?"餐單狀態已更新，請核對最新狀態。":e.message);
        setRows(null);
        setRevision(v=>v+1);
      }else if(endpoint==="table"||endpoint==="table-handoff"||endpoint==="demo-refund"||body.tableRevision!==undefined||body.pickupRevision!==undefined){
        setActionMessage(e.message);
        setRevision(v=>v+1);
      }else setError(e.message);
      return false;
    }finally{setBusy(false);}
  }
  function movePickup(id,change,signal){
    return request("/api/kitchen/pickup-reschedule",{method:"PATCH",headers:{"Content-Type":"application/json",
      ...(key?{Authorization:"Bearer "+key}:{})},body:JSON.stringify({id,...change}),signal});
  }
  function recordCash(input){
    return request("/api/kitchen/cash-receipt",{method:"POST",headers:{"Content-Type":"application/json",
      ...(key?{Authorization:"Bearer "+key}:{})},body:JSON.stringify(input),signal:AbortSignal.timeout(15_000)});
  }
  const refresh=()=>setRevision(value=>value+1);
  async function exportStations(){
    setExporting(true);setExportMessage("");
    try{
      const snapshot=await request("/api/kitchen/stations",{headers:key?{Authorization:"Bearer "+key}:{}});
      downloadJson("hey-table-stations-",snapshot.capturedAt,snapshot);
      const count=snapshot.orders.filter(order=>order.status==="preparing").length;
      setExportMessage("已匯出 "+snapshot.orders.length+" 張訂單，其中 "+count+" 張製作中。");
    }catch(e){setExportMessage("匯出失敗："+e.message);}
    finally{setExporting(false);}
  }
  const ticket=search.trim().normalize("NFKC").replace(/^#\s*/,"");
  const validNumber=!search.trim()||/^\d+$/.test(ticket);
  const exactNumber=ticket.replace(/^0+(?=\d)/,"");
  const orders=rows??[];
  const overdueCount=queueAvailable?orders.filter(order=>order.overdue).length:0;
  const filtered=orders.filter(r=>{
    const statusMatches=filter==="all"||(filter==="active"&&Object.hasOwn(overdueStage,r.status))||
      (filter==="booked"&&r.pickupSlot!=null&&Object.hasOwn(overdueStage,r.status))||
      (filter==="arrived"&&waitingPickup(r))||
      (filter==="overdue"&&queueAvailable&&r.overdue)||r.status===filter;
    const scopeMatches=scope==="all"||scope===r.mode||scope===r.table||scope===r.source;
    return statusMatches&&scopeMatches&&validNumber&&(!exactNumber||exactNumber===String(r.id));
  });
  if(filter==="overdue")filtered.sort((a,b)=>b.overdue.overByMs-a.overdue.overByMs||a.id-b.id);
  if(filter==="booked")filtered.sort((a,b)=>a.pickupSlot-b.pickupSlot||a.id-b.id);
  if(filter==="arrived")filtered.sort((a,b)=>Number(b.status==="ready")-Number(a.status==="ready")||
    a.pickupArrivedAt-b.pickupArrivedAt||a.id-b.id);
  let content;
  if(focus?.number===""){
    content=<p role="alert">{paymentReview?"餐單日期或餐號無效。":handoffOnly?"取餐 QR 碼的號碼無效。":"預約餐單的取餐號碼無效。"}</p>;
  }else if(denied){
    content=<div className="sheet"><h2>店員登入</h2><p>託管網站請使用獲授權的店主帳號。</p><a className="primary" href={"/signin-with-chatgpt?return_to="+encodeURIComponent(focus?.signInTarget??"/kitchen")} target="_top">使用 ChatGPT 登入</a>
      <details><summary>使用自架店員金鑰</summary><form onSubmit={e=>{e.preventDefault();sessionStorage.setItem("he-ri-staff",entry);setEntry("");setRevision(v=>v+1);}}><label>店員金鑰<input type="password" value={entry} onChange={e=>setEntry(e.target.value)} required/></label><button className="outline">登入</button></form></details></div>;
  }else if(rows===null){
    content=!error&&<p>正在讀取{paymentReview?"已交餐單":focused?"自取餐單":"接單台"}…</p>;
  }else if(focused){
    content=<KitchenTicket key={rows[0].id} order={rows[0]} busy={busy} update={update} movePickup={movePickup} recordCash={recordCash}
      refresh={refresh} today={today} staffKey={key} handoffOnly={handoffOnly} paymentReview={paymentReview} showOverdue={!handoffOnly}
      paymentCheck={paymentCheck?.id===rows[0].id?paymentCheck:null}/>;
  }else{
    const showTableHandoff=filter==="ready"&&!search.trim();
    const readyAt=table=>filtered.filter(order=>order.table===table&&order.mode==="table");
    content=<>
    <div className="actions"><a className="outline" href="/kitchen/create-pickup">代建自取單</a>
      <a className="outline" href="/kitchen/order-detail">查詢餐單紀錄</a>
      <a className="outline" href="/kitchen/prep">查看備料單</a>
      <a className="outline" href="/kitchen/daily">每日訂單摘要</a>
      <a className="outline" href="/kitchen/refunds">示範退款紀錄</a>
      <a className="outline" href="/kitchen/return-ledger">退餐試算交班</a>
      <a className="outline" href="/kitchen/cash-close">現金日結</a>
      <a className="outline" href="/kitchen/station-work">分站看板</a>
      <a className="outline" href="/kitchen/pickup-display">櫃台取餐看板</a>
      <a className="outline" href="/kitchen/pickup-roster">自取預約清單</a>
      <a className="outline" href="/kitchen/pickup-week">七天自取預約總覽</a>
      <a className="outline" href="/kitchen/pickup-slots">管理預約時段</a>
      <a className="outline" href="/kitchen/daily-limits">每日限量供應</a>
      <button className="outline" disabled={exporting} onClick={exportStations}>{exporting?"正在擷取訂單…":"下載分站出單檔"}</button></div>
    {exportMessage&&<p role="status">{exportMessage}</p>}
    <Intake key={"intake-"+key} staffKey={key}/>
    <ReturnReceipt key={key} staffKey={key}/>
    <PaymentSnapshot key={"payments-"+key} staffKey={key}/>
    <nav className="tabs" aria-label="餐單狀態">{[["active","處理中"],["pending","待接單"],["ready","待交餐"],["arrived","已到店"],["booked","預約自取"],
      ["overdue",overdueCount?"逾時 ("+overdueCount+")":"逾時"],["all","含近期結單"]].map(([v,n])=><button aria-pressed={v===filter} key={v} onClick={()=>setFilter(v)}>{n}</button>)}</nav>
    <div className="kitchenFilters">
      <label>管道或桌號<select value={scope} onChange={e=>setScope(e.target.value)}>
        <option value="all">全部管道</option><option value="pickup">全部自取</option><option value="staff">店員代建自取</option><option value="table">全部內用</option>
        {tables.map(table=><option key={table} value={table}>{table} 桌</option>)}
      </select></label>
      <label>取餐號碼<input type="search" inputMode="numeric" value={search} placeholder="例如 0007"
        aria-invalid={!validNumber} aria-describedby="kitchen-filter-count" onChange={e=>setSearch(e.target.value)}/></label>
      <button className="outline" disabled={scope==="all"&&!search} onClick={()=>{setScope("all");setSearch("");}}>清除搜尋條件</button>
    </div>
    <p id="kitchen-filter-count" className="muted" aria-live="polite">{filter==="overdue"&&!queueAvailable?"暫時無法更新逾時狀態。":
      !validNumber?"請輸入完整的取餐號碼。":filtered.length?"符合條件 "+filtered.length+" 張餐單":"目前沒有符合條件的訂單。"}</p>
    {actionMessage&&<p role="status">{actionMessage}</p>}
    {showTableHandoff&&["all","table"].includes(scope)&&<div className="actions">
      {tables.map(table=>[table,readyAt(table).length]).filter(([,count])=>count>=2).map(([table,count])=>
        <button className="outline" key={table} onClick={()=>setScope(table)}>{table} 桌 · {count} 張待交餐</button>)}
    </div>}
    {showTableHandoff&&tables.includes(scope)&&<TableHandoff key={scope} table={scope} orders={readyAt(scope)} busy={busy} update={update}/>}
    <div className="kGrid">{filtered.map(order=><KitchenTicket key={order.id} order={order} busy={busy} update={update} today={today}
      movePickup={movePickup} recordCash={recordCash} refresh={refresh} staffKey={key} showOverdue={queueAvailable}
      paymentCheck={paymentCheck?.id===order.id?paymentCheck:null}/>)}</div>
    <section className="sheet stock"><h2>餐點供應</h2>{dishes.map(d=><div key={d.id}><span>{d.name}</span><button className="outline" disabled={busy} onClick={()=>update("availability",{id:d.id,available:sold.includes(d.id)})}>{sold.includes(d.id)?"已售完 · 恢復供應":"供應中 · 標記售完"}</button></div>)}</section>
    <Timing staffKey={key}/>
    {key&&<button className="outline" onClick={()=>{sessionStorage.removeItem("he-ri-staff");setRevision(v=>v+1);}}>登出金鑰</button>}
    </>;
  }

  return <><Header/><main className={focused?"shell section narrow":"shell section"}>
    {focused&&<a className="textLink" href={paymentReview?focus.back:handoffOnly?"/kitchen":focus.roster}>
      {paymentReview?"返回每日訂單摘要":handoffOnly?"返回店家接單台":"返回自取預約清單"}</a>}
    <div className="menuTitle"><div>{!focused&&<p className="eyebrow">KITCHEN</p>}<h1>{title}</h1></div>
      {focus?.number!==""&&<button className="outline" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={16}/> 更新</button>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    {focused&&actionMessage&&<p role="status">{actionMessage}</p>}
    {content}
  </main><Footer/></>;
}
