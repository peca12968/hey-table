import {useEffect,useRef,useState} from "react";
import {request} from "../shared";

const endpoint="/api/kitchen/cash-corrections";
const draftKey=id=>"he-ri-cash-correction:"+id;
const taipei=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"short",timeStyle:"medium"});

function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}
function savedOperation(id){
  try{return JSON.parse(sessionStorage.getItem(draftKey(id)));}
  catch{return null;}
}
function remember(id,payload){
  try{
    if(payload)sessionStorage.setItem(draftKey(id),JSON.stringify(payload));
    else sessionStorage.removeItem(draftKey(id));
  }catch{/* The server can still match a retry from the current page. */}
}

export default function CashCorrection({id,record,disabled,onChange}){
  const revision=record.revision??0;
  const [pending,setPending]=useState(()=>savedOperation(id));
  const [opened,setOpened]=useState(()=>Boolean(pending));
  const [draft,setDraft]=useState(null);
  const [history,setHistory]=useState(null),[historyError,setHistoryError]=useState(""),[reload,setReload]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const inFlight=useRef(false);
  const editable=draft??{revision,tendered:String(record.tendered),reason:""};
  const {tendered,reason}=pending??editable;
  const entered=/^\d+$/.test(String(tendered))?Number(tendered):NaN;
  const validAmount=Number.isSafeInteger(entered)&&entered>=record.amount;
  const stale=editable.revision!==revision;
  const canSubmit=Boolean(pending)||(!stale&&validAmount&&entered!==record.tendered&&reason.trim());
  const locked=disabled||busy||Boolean(pending);

  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();
    request(endpoint+"?id="+id,{headers:staffHeaders(),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])})
      .then(value=>{if(!controller.signal.aborted){setHistory(value.corrections);setHistoryError("");}})
      .catch(failure=>{if(!controller.signal.aborted)setHistoryError(failure.message);});
    return ()=>controller.abort();
  },[id,opened,revision,reload]);

  async function confirm(event){
    event.preventDefault();
    if(inFlight.current||disabled||!canSubmit)return;
    const payload=pending??{id,revision,operationId:crypto.randomUUID(),tendered:entered,reason:reason.trim()};
    remember(id,payload);
    inFlight.current=true;
    setPending(payload);setBusy(true);setError("");setNotice("");
    try{
      const updated=await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
      remember(id,null);setPending(null);setDraft(null);
      setNotice("已保存第 "+updated.cashReceipt.revision+" 版更正。");
      setReload(value=>value+1);
    }catch(failure){
      if([400,403,404,409].includes(failure.status)){
        remember(id,null);setPending(null);setDraft({...payload,tendered:String(payload.tendered)});setError(failure.message);
      }else setError("尚未收到更正結果。請重試同一筆更正。");
    }finally{inFlight.current=false;setBusy(false);onChange();}
  }

  return <details className="cashCollection cashCorrection" open={opened} onToggle={event=>setOpened(event.currentTarget.open)}>
    <summary>更正現金收款</summary>
    <form onSubmit={confirm}>
      <label>更正後實收金額<input type="text" inputMode="numeric" maxLength={16} value={tendered} disabled={locked}
        onChange={event=>{setError("");setNotice("");setDraft({...editable,tendered:event.target.value});}}/></label>
      <label>更正原因<textarea maxLength={120} value={reason} disabled={locked}
        onChange={event=>{setError("");setNotice("");setDraft({...editable,reason:event.target.value});}}/></label>
      {validAmount&&<p>更正後找零 NT$ {entered-record.amount}</p>}
      {stale&&!pending&&<p role="status">已有更新的版本，請核對新的實收金額。</p>}
      <div className="actions">
        {stale&&!pending&&<button className="outline" type="button" disabled={locked} onClick={()=>{setDraft(null);setError("");}}>載入最新實收</button>}
        <button className="outline" disabled={busy||disabled||!canSubmit}>{busy?"正在更正…":pending?"重試更正":"確認更正"}</button>
      </div>
    </form>
    {error&&<p className="error" role="alert">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {historyError&&<p role="status">{historyError} <button className="outline" onClick={()=>setReload(value=>value+1)}>重讀更正紀錄</button></p>}
    {history?.length>0&&<ul className="cashCorrectionHistory" aria-label="現金更正紀錄">{history.map(change=><li key={change.revision}>
      <strong>第 {change.revision} 版</strong> · NT$ {change.previousTendered} 改為 NT$ {change.tendered}
      <p>{change.reason} · <time dateTime={new Date(change.correctedAt).toISOString()}>{taipei.format(change.correctedAt)}</time></p>
    </li>)}</ul>}
  </details>;
}
