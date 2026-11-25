"use client";
import {useEffect,useRef,useState} from "react";
import {Header,Footer,Mode,PickupAppointment,request} from "../../shared";
import {ItemNote} from "../../item-notes";
import {numberOf} from "../../../lib/menu.mjs";
import {stationBatchLimit,stationLabels,stationReview} from "../../../lib/kitchen-timing.mjs";

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
  const reviewButton=useRef(null),reviewHeading=useRef(null);
  const pending=new Map(rows?.filter(order=>order.doneAt===null).map(order=>[order.id,order]));
  const picked=selected.flatMap(id=>pending.has(id)?[pending.get(id)]:[]);
  const stale=review?.some(order=>{
    const current=pending.get(order.id);
    return !current||stationReview(current)!==stationReview(order);
  });
  useEffect(()=>{if(review)reviewHeading.current?.focus();},[review]);
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

  async function finishSelected(){
    setBusy(true);
    setMessage("");
    try{
      const result=await request("/api/kitchen/station-work/batch",{method:"PATCH",
        headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify({station,orders:review.map(order=>({id:order.id,review:stationReview(order)}))})});
      setSelected([]);setReview(null);
      setMessage(stationLabels[station]+"已回報 "+result.completed+" 張餐單備妥。");
    }catch(failure){
      setMessage(failure.message);
    }finally{
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
    <div className="actions stationBatchBar">
      <button className="outline" ref={reviewButton} aria-disabled={busy||review!==null||picked.length<2}
        onClick={()=>{if(!busy&&!review&&picked.length>=2){setMessage("");setReview(picked);}}}>
        核對批次備妥{picked.length>0?"（"+picked.length+" 張）":""}
      </button>
      {picked.length>=stationBatchLimit&&<p>每批最多 {stationBatchLimit} 張餐單。</p>}
    </div>
    {review&&<section className="sheet tableHandoff" aria-labelledby="station-batch-review">
      <h2 id="station-batch-review" tabIndex={-1} ref={reviewHeading}>核對{stationLabels[station]}餐單</h2>
      {rows&&stale&&<p className="error" role="alert">餐單已更新，請返回看板重新核對。</p>}
      <ul className="tableHandoffOrders">{review.map(order=><li key={order.id}>
        <div className="menuTitle"><strong>#{numberOf(order.id)}</strong><Mode table={order.table} source={order.source}/></div>
        <StationItems order={order}/>
      </li>)}</ul>
      <div className="actions">
        <button className="primary" disabled={busy||!rows||stale} onClick={finishSelected}>確認 {review.length} 張本站已備妥</button>
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
        <button className="primary" disabled={busy||!!review} onClick={()=>ready(order.id)}>本站已備妥</button>
        <label className="stationBatchChoice"><input type="checkbox" aria-label={"選取餐單 "+numberOf(order.id)}
          checked={selected.includes(order.id)} disabled={busy||!!review||(!selected.includes(order.id)&&picked.length>=stationBatchLimit)}
          onChange={event=>toggle(order.id,event.target.checked)}/>加入批次</label>
      </div>:
        <p className="muted">本站已備妥，等待其他工作站。</p>}
    </article>)}</div>
  </main><Footer/></>;
}
