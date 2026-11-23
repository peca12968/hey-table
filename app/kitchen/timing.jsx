"use client";
import {useEffect,useState} from "react";
import {dishes} from "../../lib/menu.mjs";
import {demoKitchen,importTiming,timingChanges} from "../../lib/kitchen-timing.mjs";
import {downloadJson} from "../../lib/download-json.mjs";
import {request} from "../shared";

const endpoint="/api/kitchen/timing";
const interval=pair=>pair[0]===pair[1]?pair[0]+" 秒":pair.join("–")+" 秒";
export default function Timing({staffKey}) {
  const [expanded,setExpanded]=useState(false);
  return <section className="sheet timing"><h2>出餐工時設定</h2>
    <button type="button" className="outline" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      {expanded?"收合工時設定":"管理出餐工時"}</button>
    {expanded&&<TimingForm key={staffKey} staffKey={staffKey}/>}</section>;
}
function TimingForm({staffKey}) {
  const [data,setData]=useState(null),[revision,setRevision]=useState(0);
  const [preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[stale,setStale]=useState(false);
  const [message,setMessage]=useState("");
  const auth=staffKey?{Authorization:"Bearer "+staffKey}:{};
  useEffect(()=>{
    const controller=new AbortController();
    setData(null);setPreview(null);setStale(false);setMessage("");
    request(endpoint,{headers:staffKey?{Authorization:"Bearer "+staffKey}:{},signal:controller.signal})
      .then(result=>{if(!controller.signal.aborted)setData(result);})
      .catch(e=>{if(!controller.signal.aborted)setMessage(e.message);});
    return ()=>controller.abort();
  },[staffKey,revision]);
  async function readFile(file){
    setPreview(null);setMessage("");
    if(!file)return;
    setBusy(true);
    try{const kitchen=importTiming(JSON.parse((await file.text()).replace(/^\uFEFF/,"")));
      setPreview({kitchen,label:"匯入檔案"});}
    catch(e){setMessage(e instanceof SyntaxError?"檔案不是有效的 JSON。":e.message);}
    finally{setBusy(false);}
  }
  async function apply(){
    if(!data||!preview||stale||busy)return;
    setBusy(true);setMessage("");
    try{
      const current=await request(endpoint,{method:"PATCH",headers:{...auth,"Content-Type":"application/json"},
        body:JSON.stringify({revision:data.current.revision,kitchen:preview.kitchen})});
      setData({current,previous:data.current});setPreview(null);setMessage("已套用，新的購物車試算將使用這組工時。");
    }catch(e){setStale(e.status===409);setMessage(e.message);}
    finally{setBusy(false);}
  }
  const model=data?.current.kitchen,changes=preview&&model?timingChanges(model,preview.kitchen):[];
  function select(kitchen,label){setPreview({kitchen,label});setMessage("");}
  return <div className="timingForm">
    {data&&<><p>目前版本 {data.current.revision}。可下載目前設定供 Batch Clock 校準，再匯入 JSON 比較每批秒數。</p>
      <div className="actions"><button type="button" className="outline" onClick={()=>downloadJson("hey-table-kitchen-",Date.now(),model)}>下載目前工時</button>
      {data.previous&&<button type="button" className="outline" disabled={busy||stale} onClick={()=>select(data.previous.kitchen,"上一版工時")}>預覽上一版</button>}
      {!!timingChanges(demoKitchen,model).length&&<button type="button" className="outline" disabled={busy||stale} onClick={()=>select(demoKitchen,"示範工時")}>預覽示範工時</button>}</div>
      <label>匯入工時 JSON<input type="file" accept=".json,application/json" disabled={busy||stale} onChange={e=>{
        const file=e.target.files?.[0];e.target.value="";readFile(file);
      }}/></label>
      {preview&&<p>{preview.label} · {changes.length?changes.length+" 道餐點工時將調整":"與目前設定相同"}</p>}
      <table><caption>{preview?"工時差異":"目前工時"}</caption><thead><tr><th scope="col">餐點</th><th scope="col">目前每批</th>{preview&&<th scope="col">套用後</th>}</tr></thead>
        <tbody>{dishes.filter(d=>!preview||changes.includes(d.id)).map(d=><tr key={d.id}><th scope="row">{d.name}</th>
          <td>{interval(model.recipes[d.id].seconds)}</td>{preview&&<td>{interval(preview.kitchen.recipes[d.id].seconds)}</td>}</tr>)}</tbody></table>
      {preview&&<div className="actions"><button type="button" className="primary" disabled={busy||stale||!changes.length} onClick={apply}>套用工時</button>
        <button type="button" className="outline" disabled={busy} onClick={()=>{setPreview(null);setMessage("");}}>取消預覽</button></div>}
    </>}
    {message&&<p role="status">{message}</p>}
    {(stale||(!data&&message))&&<button type="button" className="outline" onClick={()=>setRevision(n=>n+1)}>載入最新工時</button>}
    {!data&&!message&&<p>正在讀取工時…</p>}
  </div>;
}
