"use client";
import {useEffect,useState} from "react";
import {Header,Footer,Mode,PickupAppointment,request} from "../../shared";
import {ItemNote} from "../../item-notes";
import {numberOf} from "../../../lib/menu.mjs";
import {stationLabels} from "../../../lib/kitchen-timing.mjs";

function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}

export default function StationWork(){
  const [station,setStation]=useState("hot"),[revision,setRevision]=useState(0);
  const [rows,setRows]=useState(null),[busy,setBusy]=useState(false);
  const [error,setError]=useState(""),[message,setMessage]=useState("");
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
    setRows(null);setError("");setMessage("");setStation(value);
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
    {!rows&&!error&&<p>正在讀取{stationLabels[station]}…</p>}
    {rows?.length===0&&<p className="sheet">{stationLabels[station]}目前沒有製作中的餐單。</p>}
    <div className="kGrid">{rows?.map(order=><article className="sheet kitchenTicket" key={order.id}>
      <div className="menuTitle"><h2>#{numberOf(order.id)}</h2><Mode table={order.table} source={order.source}/></div>
      <PickupAppointment start={order.pickupSlot}/>
      <p>已備妥 {order.doneStations}／{order.stations} 站</p>
      <ul className="orderLines">{order.items.map(({id,name,qty,note})=><li key={id}><div>{name}<ItemNote note={note}/></div><b>×{qty}</b></li>)}</ul>
      {order.note&&<p>備註　{order.note}</p>}
      {order.doneAt===null?<button className="primary" disabled={busy} onClick={()=>ready(order.id)}>本站已備妥</button>:
        <p className="muted">本站已備妥，等待其他工作站。</p>}
    </article>)}</div>
  </main><Footer/></>;
}
