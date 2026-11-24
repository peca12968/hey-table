"use client";
import {useEffect,useState} from "react";
import {RefreshCw} from "lucide-react";
import {Header,Footer,Mode,request} from "../shared";
import {ItemNote} from "../item-notes";
import {dishes,labels,numberOf,tables,transitions} from "../../lib/menu.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import Timing from "./timing";
import ReturnReceipt from "./return-receipt";
import PaymentSnapshot from "./payment-snapshot";
import Intake from "./intake";
import {methods,paymentStates,environmentLabel,canPrepare,canCancel} from "../../lib/payments.mjs";
const action={preparing:"接單製作",ready:"完成製作",completed:"完成交餐",cancelled:"取消訂單"};
const overdueStage={pending:"待接單",preparing:"製作中",ready:"待交餐"};

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

function KitchenTicket({order,busy,update,showOverdue=false,handoffOnly=false}){
  const {id,status,table,created,items,note,paymentMethod,paymentEnv,paymentState,total}=order;
  const actions=handoffOnly ? transitions[status].filter(next=>next==="completed") : transitions[status];
  const workingByStation=order.stationProgress&&status==="preparing";
  const tableRevision=order.tableRevision??0;
  return <article className="sheet kitchenTicket">
    <div className="menuTitle"><h2>#{numberOf(id)}</h2><Mode table={table} source={order.source}/></div>
    <p aria-live={handoffOnly?"polite":undefined}><b>{labels[status]}</b> · {new Date(created).toLocaleTimeString("zh-TW",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Taipei"})}</p>
    {showOverdue&&order.overdue&&<p className="kitchenOverdue">逾時 · {overdueStage[status]} {Math.floor(order.overdue.elapsedMs/60_000)} 分鐘</p>}
    <ul className="orderLines">{items.map(dish=><li key={dish.id}><div>{dish.name}<ItemNote note={dish.note}/></div><b>×{dish.qty}</b></li>)}</ul>
    {note&&<p>備註　{note}</p>}
    <p>{methods[paymentMethod]} {paymentMethod!=="cash"&&[environmentLabel(paymentEnv),paymentStates[paymentState]].join(" · ")}</p>
    <div className="total"><span>合計</span><b>NT$ {total}</b></div>
    <div className="actions">
      {["ready","completed"].includes(status)&&<a className="outline" href={"/kitchen/handoff?id="+numberOf(id)}>交餐小票</a>}
      {workingByStation&&<a className="primary" href="/kitchen/station-work">查看分站進度</a>}
      {!handoffOnly&&["sandbox","production"].includes(paymentEnv)&&<button className="outline" disabled={busy} onClick={()=>update("payment",{id})}>查詢金流</button>}
      {!workingByStation&&actions.map(next=><button disabled={busy||(next==="cancelled"?!canCancel(order):!canPrepare(order))} className={next==="cancelled"?"outline":"primary"} key={next}
        onClick={()=>{if(next!=="cancelled"||window.confirm("取消這張訂單？"))
          update("status",{id,from:status,to:next,...(table&&next==="completed"?{tableRevision}:{})});}}>{action[next]}</button>)}
    </div>
    {table&&["pending","preparing","ready"].includes(status)&&<TableMove
      key={table+":"+tableRevision} id={id} table={table} revision={tableRevision} busy={busy} update={update}/>}
  </article>;
}

export default function Kitchen(){
  const [key,setKey]=useState(""),[entry,setEntry]=useState(""),[denied,setDenied]=useState(false),[rows,setRows]=useState(null);
  const [sold,setSold]=useState([]),[filter,setFilter]=useState("active"),[error,setError]=useState(""),[revision,setRevision]=useState(0),[busy,setBusy]=useState(false);
  const [exporting,setExporting]=useState(false),[exportMessage,setExportMessage]=useState("");
  const [scope,setScope]=useState("all"),[search,setSearch]=useState("");
  const [queueAvailable,setQueueAvailable]=useState(false);
  const [pickup,setPickup]=useState(undefined),[actionMessage,setActionMessage]=useState("");
  const focused=typeof pickup==="string";
  const signInTarget=pickup?"/kitchen?pickup="+pickup:"/kitchen";
  useEffect(()=>{
    setKey(sessionStorage.getItem("he-ri-staff")||"");
    const number=new URLSearchParams(location.search).get("pickup");
    const id=Number(number);
    setPickup(number===null ? null : /^[0-9]+$/.test(number)&&Number.isSafeInteger(id)&&id>0 ? numberOf(id) : "");
  },[]);
  useEffect(()=>{
    if(pickup===undefined||pickup==="")return;
    const controller=new AbortController();
    const headers=key?{Authorization:"Bearer "+key}:{};
    let inFlight=false;
    async function load(){
      if(inFlight)return;
      inFlight=true;
      try{
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)]);
        const options={headers,signal};
        if(focused){
          const order=await request("/api/kitchen/pickup?id="+pickup,options);
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
          if(e.status===403||focused)setRows(null);
          setError(e.name==="TimeoutError"?"讀取餐單逾時，請稍後重試。":e.message);
        }
      }finally{inFlight=false;}
    }
    load();const t=setInterval(load,5000);return()=>{controller.abort();clearInterval(t);};
  },[key,revision,pickup,focused]);
  async function update(endpoint,body){
    setBusy(true);setError("");setActionMessage("");
    try{
      const result=await request("/api/kitchen/"+endpoint,{method:"PATCH",headers:{"Content-Type":"application/json",...(key?{Authorization:"Bearer "+key}:{})},body:JSON.stringify(body)});
      if(focused){setRows(null);setActionMessage("已完成交餐。");}
      if(endpoint==="table")setActionMessage("餐單 "+numberOf(body.id)+" 已換到 "+body.to+" 桌。");
      if(endpoint==="table-handoff"){
        const ids=new Set(body.orders.map(order=>order.id));
        setRows(rows=>rows?.map(order=>ids.has(order.id)?{...order,status:"completed",overdue:undefined}:order)??null);
        setActionMessage(result.table+" 桌已完成 "+result.completed+" 張餐單的交餐。");
      }
      setRevision(v=>v+1);
      return true;
    }catch(e){
      if(focused){
        setActionMessage(e.status===409?"餐單狀態已更新，請核對最新狀態。":e.message);
        setRows(null);
        setRevision(v=>v+1);
      }else if(endpoint==="table"||endpoint==="table-handoff"||body.tableRevision!==undefined){
        setActionMessage(e.message);
        setRevision(v=>v+1);
      }else setError(e.message);
      return false;
    }finally{setBusy(false);}
  }
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
      (filter==="overdue"&&queueAvailable&&r.overdue)||r.status===filter;
    const scopeMatches=scope==="all"||scope===r.mode||scope===r.table||scope===r.source;
    return statusMatches&&scopeMatches&&validNumber&&(!exactNumber||exactNumber===String(r.id));
  });
  if(filter==="overdue")filtered.sort((a,b)=>b.overdue.overByMs-a.overdue.overByMs||a.id-b.id);
  let content;
  if(pickup===""){
    content=<p role="alert">取餐 QR 碼的號碼無效。</p>;
  }else if(denied){
    content=<div className="sheet"><h2>店員登入</h2><p>託管網站請使用獲授權的店主帳號。</p><a className="primary" href={"/signin-with-chatgpt?return_to="+encodeURIComponent(signInTarget)} target="_top">使用 ChatGPT 登入</a>
      <details><summary>使用自架店員金鑰</summary><form onSubmit={e=>{e.preventDefault();sessionStorage.setItem("he-ri-staff",entry);setKey(entry);setEntry("");setRevision(v=>v+1);}}><label>店員金鑰<input type="password" value={entry} onChange={e=>setEntry(e.target.value)} required/></label><button className="outline">登入</button></form></details></div>;
  }else if(rows===null){
    content=!error&&<p>正在讀取{focused?"自取餐單":"接單台"}…</p>;
  }else if(focused){
    content=<KitchenTicket order={rows[0]} busy={busy} update={update} handoffOnly/>;
  }else{
    const showTableHandoff=filter==="ready"&&!search.trim();
    const readyAt=table=>filtered.filter(order=>order.table===table&&order.mode==="table");
    content=<>
    <div className="actions"><a className="outline" href="/kitchen/create-pickup">代建自取單</a>
      <a className="outline" href="/kitchen/prep">查看備料單</a>
      <a className="outline" href="/kitchen/daily">每日訂單摘要</a>
      <a className="outline" href="/kitchen/station-work">分站看板</a>
      <a className="outline" href="/kitchen/pickup-display">櫃台取餐看板</a>
      <a className="outline" href="/kitchen/daily-limits">每日限量供應</a>
      <button className="outline" disabled={exporting} onClick={exportStations}>{exporting?"正在擷取訂單…":"下載分站出單檔"}</button></div>
    {exportMessage&&<p role="status">{exportMessage}</p>}
    <Intake key={"intake-"+key} staffKey={key}/>
    <ReturnReceipt key={key} staffKey={key}/>
    <PaymentSnapshot key={"payments-"+key} staffKey={key}/>
    <nav className="tabs" aria-label="餐單狀態">{[["active","處理中"],["pending","待接單"],["ready","待交餐"],
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
    <div className="kGrid">{filtered.map(order=><KitchenTicket key={order.id} order={order} busy={busy} update={update} showOverdue={queueAvailable}/>)}</div>
    <section className="sheet stock"><h2>餐點供應</h2>{dishes.map(d=><div key={d.id}><span>{d.name}</span><button className="outline" disabled={busy} onClick={()=>update("availability",{id:d.id,available:sold.includes(d.id)})}>{sold.includes(d.id)?"已售完 · 恢復供應":"供應中 · 標記售完"}</button></div>)}</section>
    <Timing staffKey={key}/>
    {key&&<button className="outline" onClick={()=>{sessionStorage.removeItem("he-ri-staff");setKey("");}}>登出金鑰</button>}
    </>;
  }

  return <><Header/><main className={focused?"shell section narrow":"shell section"}>
    {focused&&<a className="textLink" href="/kitchen">返回店家接單台</a>}
    <div className="menuTitle"><div>{!focused&&<p className="eyebrow">KITCHEN</p>}<h1>{focused?"自取交餐":"店家接單台"}</h1></div>
      {pickup!==""&&<button className="outline" onClick={()=>setRevision(v=>v+1)}><RefreshCw size={16}/> 更新</button>}</div>
    {error&&<p className="error" role="alert">{error}</p>}
    {focused&&actionMessage&&<p role="status">{actionMessage}</p>}
    {content}
  </main><Footer/></>;
}
