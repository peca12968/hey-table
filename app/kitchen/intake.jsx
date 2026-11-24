"use client";
import {useEffect,useState} from "react";
import {intakeLabels} from "../../lib/order-intake.mjs";
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
  useEffect(()=>{
    const controller=new AbortController();
    request(endpoint,{headers:auth(staffKey),signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setData(result);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.message);});
    return ()=>controller.abort();
  },[staffKey,refresh]);
  async function change(mode) {
    if(!data||busy||stale)return;
    const {revision,accepting}=data[mode];
    setBusy(true);setError("");setMessage("");
    try{
      const next=await request(endpoint,{method:"PATCH",headers:{...auth(staffKey),"Content-Type":"application/json"},
        body:JSON.stringify({mode,revision,accepting:!accepting})});
      setData(current=>({...current,[mode]:{accepting:next.accepting,revision:next.revision}}));
      setMessage(intakeLabels[mode]+(next.accepting?"已恢復接單。":"已暫停新訂單。"));
    }catch(e){
      setError(e.message);setStale(true);
    }finally{setBusy(false);}
  }
  function reload(){
    setData(null);setStale(false);setError("");setMessage("");setRefresh(value=>value+1);
  }
  return <div className="intakeControls">
    <p>暫停只影響新訂單。已送出的餐單仍可付款、製作與交餐。</p>
    {data&&Object.entries(intakeLabels).map(([mode,label])=>{
      const accepting=data[mode].accepting;
      return <div className="intakeRow" key={mode}>
        <div><strong>{label}</strong><small>{accepting?"接單中":"已暫停"}</small></div>
        <button type="button" className="outline" disabled={busy||stale} onClick={()=>change(mode)}>
          {accepting?"暫停"+label:"恢復"+label}</button>
      </div>;
    })}
    {message&&<p role="status">{message}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
    {!data&&!error&&<p role="status">正在讀取接單設定…</p>}
    {(stale||error&&!data)&&<button type="button" className="outline" onClick={reload}>載入最新接單設定</button>}
  </div>;
}
