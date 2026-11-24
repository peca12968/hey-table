"use client";
import {useEffect,useState} from "react";
import {intakeLabels} from "../../lib/order-intake.mjs";
import {tables} from "../../lib/menu.mjs";
import {request} from "../shared";

const endpoint="/api/kitchen/intake";
const auth=staffKey=>staffKey?{Authorization:"Bearer "+staffKey}:{};

export default function Intake({staffKey}) {
  const [expanded,setExpanded]=useState(false);
  return <section className="sheet intake"><h2>新訂單接單設定</h2>
    <button type="button" className="outline" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>
      {expanded?"收合接單設定":"管理接單管道"}</button>
    {expanded&&<IntakeForm staffKey={staffKey}/>}</section>;
}

function IntakeForm({staffKey}) {
  const [data,setData]=useState(null),[refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false),[stale,setStale]=useState(false),[error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [table,setTable]=useState(tables[0]);
  useEffect(()=>{
    const controller=new AbortController();
    request(endpoint,{headers:auth(staffKey),signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setData(result);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[staffKey,refresh]);
  async function change(scope) {
    if(!data||busy||stale)return;
    const {mode,table}=scope;
    const {revision,accepting}=mode ? data[mode] : data.tables[table];
    setBusy(true);setError("");setMessage("");
    try{
      const next=await request(endpoint,{method:"PATCH",headers:{...auth(staffKey),"Content-Type":"application/json"},
        body:JSON.stringify({...scope,revision,accepting:!accepting})});
      const state={accepting:next.accepting,revision:next.revision};
      setData(current=>mode ? {...current,[mode]:state} : {...current,tables:{...current.tables,[table]:state}});
      const target=mode ? intakeLabels[mode] : table+" 桌";
      const result=!next.accepting ? "已暫停新訂單。" : table && !data.table.accepting ? "已開放。掃碼內用管道目前暫停。" : "已恢復接單。";
      setMessage(target+result);
    }catch(e){
      setError(e.message);setStale(true);
    }finally{setBusy(false);}
  }
  function reload(){
    setData(null);setStale(false);setError("");setMessage("");setRefresh(value=>value+1);
  }
  const selected=data?.tables?.[table];
  return <div className="intakeControls">
    <p>暫停只影響新訂單。已送出的餐單仍可付款、製作與交餐。</p>
    {data&&Object.entries(intakeLabels).map(([mode,label])=>{
      const accepting=data[mode].accepting;
      return <div className="intakeRow" key={mode}>
        <div><strong>{label}</strong><small>{accepting?"接單中":"已暫停"}</small></div>
        <button type="button" className="outline" disabled={busy||stale} onClick={()=>change({mode})}>
          {accepting?"暫停"+label:"恢復"+label}</button>
      </div>;
    })}
    {selected&&<>
      <div className="intakeRow">
        <label>單桌接單設定 <select value={table} disabled={busy||stale} onChange={event=>{setTable(event.target.value);setMessage("");}}>
          {tables.map(number=><option key={number} value={number}>{number} 桌</option>)}
        </select><small>{selected.accepting?"單桌已開放":"單桌已暫停"}</small></label>
        <button type="button" className="outline" disabled={busy||stale} onClick={()=>change({table})}>
          {selected.accepting?"暫停":"恢復"}{table} 桌</button>
      </div>
      {!data.table.accepting&&<p>掃碼內用管道已暫停。管道恢復後，各桌依自己的設定接單。</p>}
    </>}
    {message&&<p role="status">{message}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {!data&&!error&&<p role="status">正在讀取接單設定…</p>}
    {(stale||error&&!data)&&<button type="button" className="outline" onClick={reload}>載入最新接單設定</button>}
  </div>;
}
