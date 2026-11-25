"use client";
import {useEffect,useRef,useState,useSyncExternalStore} from "react";
import {Header,Footer,Mode,PickupAppointment,request} from "../../shared";
import {ItemNote} from "../../item-notes";
import {numberOf} from "../../../lib/menu.mjs";
import {stationBatchLimit,stationLabels,stationReview,stationReviewDigest} from "../../../lib/kitchen-timing.mjs";

const batchEndpoint="/api/kitchen/station-work/batch",batchStorageKey="he-ri-station-batch";
const ignoreStorageChanges=()=>()=>{},serverDraft=()=>null;

function readDraft(){
  try{return sessionStorage.getItem(batchStorageKey);}catch{return null;}
}

function parseDraft(raw){
  try{
    const value=JSON.parse(raw);
    return value&&Object.hasOwn(stationLabels,value.station)&&typeof value.operationId==="string"&&
      Array.isArray(value.orders)&&value.orders.length>=2?value:null;
  }catch{return null;}
}

function saveDraft(value){
  try{
    if(value)sessionStorage.setItem(batchStorageKey,JSON.stringify(value));
    else sessionStorage.removeItem(batchStorageKey);
  }catch{/* The active tab can still recover the result from memory. */}
}

function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}

function StationItems({order}){
  return <>
    <PickupAppointment start={order.pickupSlot}/>
    <ul className="orderLines">{order.items.map(({id,name,qty,note})=><li key={id}><div>{name}<ItemNote note={note}/></div><b>×{qty}</b></li>)}</ul>
    {order.note&&<p>備註　{order.note}</p>}
  </>;
}

export default function StationWork(){
  const [station,setStation]=useState("hot"),[revision,setRevision]=useState(0);
  const [rows,setRows]=useState(null),[busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[message,setMessage]=useState("");
  const [selected,setSelected]=useState([]),[review,setReview]=useState(null);
  const stored=useSyncExternalStore(ignoreStorageChanges,readDraft,serverDraft);
  const [draft,setDraft]=useState(undefined),[canResend,setCanResend]=useState(false);
  const batch=draft===undefined?parseDraft(stored):draft;
  const reviewButton=useRef(null),reviewHeading=useRef(null),recoveryHeading=useRef(null),batchInFlight=useRef(false);
  const pendingOperation=batch?.operationId;
  const pending=new Map(rows?.filter(order=>order.doneAt===null).map(order=>[order.id,order]));
  const picked=selected.flatMap(id=>pending.has(id)?[pending.get(id)]:[]);
  const stale=review?.some(order=>{
    const current=pending.get(order.id);
    return !current||stationReview(current)!==stationReview(order);
  });
  useEffect(()=>{if(review&&!pendingOperation)reviewHeading.current?.focus();},[review,pendingOperation]);
  useEffect(()=>{if(pendingOperation)recoveryHeading.current?.focus();},[pendingOperation]);
  useEffect(()=>{
    const controller=new AbortController();
    let loading=false;
    async function load(){
      if(loading)return;
      loading=true;
      try{
        const result=await request("/api/kitchen/station-work?station="+station,{
          headers:staffHeaders(),signal:controller.signal,
        });
        if(!controller.signal.aborted){setRows(result.orders);setError("");}
      }catch(failure){
        if(!controller.signal.aborted){setRows(null);setError(failure.message);}
      }finally{loading=false;}
    }
    load();
    const timer=setInterval(load,5000);
    return ()=>{controller.abort();clearInterval(timer);};
  },[station,revision]);

  function choose(value){
    if(value===station)return;
    setRows(null);setError("");setMessage("");setSelected([]);setReview(null);setStation(value);
  }
  async function ready(id){
    setBusy(true);
    setMessage("");
    try{
      const result=await request("/api/kitchen/station-work",{method:"PATCH",
        headers:{"Content-Type":"application/json",...staffHeaders()},body:JSON.stringify({id,station})});
      setMessage("餐單 "+numberOf(id)+(result.status==="preparing"?" 本站已備妥。":" 各站已備妥。"));
    }catch(failure){
      setMessage(failure.message);
    }finally{
      setRows(null);setRevision(value=>value+1);setBusy(false);
    }
  }

  function toggle(id,checked){
    setSelected(picked.filter(order=>order.id!==id).map(order=>order.id).concat(checked?[id]:[]));
  }

  function closeReview(){
    setReview(null);
    setSelected(picked.map(order=>order.id));
    setMessage("");
    reviewButton.current?.focus();
  }

  function storeBatch(value){
    saveDraft(value);
    setDraft(value);
    setCanResend(false);
  }

  async function runBatch(action){
    if(batchInFlight.current)return;
    batchInFlight.current=true;
    setBusy(true);
    setMessage("");
    let operation=batch;
    try{
      if(!operation){
        const orders=await Promise.all(review.map(async order=>({id:order.id,review:await stationReviewDigest(stationReview(order))})));
        operation={operationId:crypto.randomUUID(),station,orders};
        storeBatch(operation);
      }
      const signal=AbortSignal.timeout(15_000);
      const result=action==="lookup"
        ?await request(batchEndpoint+"?operationId="+encodeURIComponent(operation.operationId),{headers:staffHeaders(),signal})
        :await request(batchEndpoint,{method:"PATCH",signal,headers:{"Content-Type":"application/json",...staffHeaders()},
          body:JSON.stringify(operation)});
      storeBatch(null);
      setSelected([]);setReview(null);
      setMessage(stationLabels[result.station]+"已回報 "+result.completed+" 張餐單備妥。");
    }catch(failure){
      if(action==="lookup"&&failure.status===404){
        setCanResend(true);
        setMessage("目前查無備妥紀錄。可用原批次重送。");
      }else if([400,409].includes(failure.status)){
        storeBatch(null);
        setMessage(failure.message);
      }else{
        setMessage(failure.status===403?failure.message:operation?
          "尚未收到批次結果。請查詢原批次。":"無法建立批次，請重新確認。");
      }
    }finally{
      batchInFlight.current=false;
      setRevision(value=>value+1);setBusy(false);
    }
  }

  return <><Header/><main className="shell section">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <div className="menuTitle">
      <h1>分站看板</h1>
      <button className="outline" disabled={busy} onClick={()=>setRevision(value=>value+1)}>更新看板</button>
    </div>
    <nav className="tabs" aria-label="工作站">
      {Object.entries(stationLabels).map(([value,label])=><button key={value} disabled={busy} aria-pressed={station===value} onClick={()=>choose(value)}>{label}</button>)}
    </nav>
    {error&&<p role="alert" className="error">{error}</p>}
    <p className="muted" role="status">{message}</p>
    {batch&&<section className="sheet tableHandoff" aria-labelledby="station-batch-pending">
      <h2 id="station-batch-pending" tabIndex={-1} ref={recoveryHeading}>待確認的{stationLabels[batch.station]}批次</h2>
      <p>餐單 {batch.orders.map(({id})=>"#"+numberOf(id)).join("、")}</p>
      <div className="actions">
        <button className="primary" disabled={busy} onClick={()=>runBatch("lookup")}>查詢批次結果</button>
        {canResend&&<button className="outline" disabled={busy} onClick={()=>runBatch("retry")}>重送原批次</button>}
      </div>
    </section>}
    {!batch&&<div className="actions stationBatchBar">
      <button className="outline" ref={reviewButton} aria-disabled={busy||review!==null||picked.length<2}
        onClick={()=>{if(!busy&&!review&&picked.length>=2){setMessage("");setReview(picked);}}}>
        核對批次備妥{picked.length>0?"（"+picked.length+" 張）":""}
      </button>
      {picked.length>=stationBatchLimit&&<p>每批最多 {stationBatchLimit} 張餐單。</p>}
    </div>}
    {review&&!batch&&<section className="sheet tableHandoff" aria-labelledby="station-batch-review">
      <h2 id="station-batch-review" tabIndex={-1} ref={reviewHeading}>核對{stationLabels[station]}餐單</h2>
      {rows&&stale&&<p className="error" role="alert">餐單已更新，請返回看板重新核對。</p>}
      <ul className="tableHandoffOrders">{review.map(order=><li key={order.id}>
        <div className="menuTitle"><strong>#{numberOf(order.id)}</strong><Mode table={order.table} source={order.source}/></div>
        <StationItems order={order}/>
      </li>)}</ul>
      <div className="actions">
        <button className="primary" disabled={busy||!rows||stale} onClick={()=>runBatch("submit")}>確認 {review.length} 張本站已備妥</button>
        <button className="outline" disabled={busy} onClick={closeReview}>返回勾選</button>
      </div>
    </section>}
    {!rows&&!error&&<p>正在讀取{stationLabels[station]}…</p>}
    {rows?.length===0&&<p className="sheet">{stationLabels[station]}目前沒有製作中的餐單。</p>}
    <div className="kGrid">{rows?.map(order=><article className="sheet kitchenTicket" key={order.id}>
      <div className="menuTitle"><h2>#{numberOf(order.id)}</h2><Mode table={order.table} source={order.source}/></div>
      <p>已備妥 {order.doneStations}／{order.stations} 站</p>
      <StationItems order={order}/>
      {order.doneAt===null?<div className="actions">
        <button className="primary" disabled={busy||!!review||!!batch} onClick={()=>ready(order.id)}>本站已備妥</button>
        <label className="stationBatchChoice"><input type="checkbox" aria-label={"選取餐單 "+numberOf(order.id)}
          checked={selected.includes(order.id)} disabled={busy||!!review||!!batch||(!selected.includes(order.id)&&picked.length>=stationBatchLimit)}
          onChange={event=>toggle(order.id,event.target.checked)}/>加入批次</label>
      </div>:
        <p className="muted">本站已備妥，等待其他工作站。</p>}
    </article>)}</div>
  </main><Footer/></>;
}
