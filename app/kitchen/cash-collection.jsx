import {useEffect,useRef,useState} from "react";
import CashReceipt from "../cash-receipt";
import CashCorrection from "./cash-correction";

const draftKey=id=>"he-ri-cash-collection:"+id;

function pendingCollection(id){
  try{return JSON.parse(sessionStorage.getItem(draftKey(id)));}
  catch{return null;}
}

function saveCollection(id,pending){
  try{
    if(pending)sessionStorage.setItem(draftKey(id),JSON.stringify(pending));
    else sessionStorage.removeItem(draftKey(id));
  }catch{/* The server also guards duplicate submissions by order. */}
}

export default function CashCollection({order,disabled,submit,onChange}){
  const [pending,setPending]=useState(()=>pendingCollection(order.id));
  const [tendered,setTendered]=useState(()=>pending?String(pending.tendered):"");
  const [opened,setOpened]=useState(()=>Boolean(pending));
  const [result,setResult]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const inFlight=useRef(false);
  const recorded=order.cashReceipt??result;
  const entered=/^\d+$/.test(tendered)?Number(tendered):NaN;
  const valid=Number.isSafeInteger(entered);
  const change=valid?entered-(pending?.expectedTotal??order.total):null;

  useEffect(()=>{
    if(recorded)saveCollection(order.id,null);
  },[order.id,recorded]);

  async function confirm(event){
    event.preventDefault();
    if(inFlight.current||disabled||(!pending&&(change===null||change<0)))return;
    const payload=pending??{id:order.id,operationId:crypto.randomUUID(),expectedTotal:order.total,tendered:entered};
    saveCollection(order.id,payload);
    inFlight.current=true;
    setPending(payload);setBusy(true);setError("");
    try{
      const response=await submit(payload);
      setResult(response.cashReceipt);
      saveCollection(order.id,null);
    }catch(failure){
      if([400,403,404,409].includes(failure.status)){
        saveCollection(order.id,null);setPending(null);setError(failure.message);
      }else setError("尚未收到收款結果。請用同一筆資料重試確認。");
    }finally{
      inFlight.current=false;setBusy(false);onChange();
    }
  }

  if(recorded)return <><CashReceipt record={recorded}/><CashCorrection id={order.id} record={recorded} disabled={disabled} onChange={onChange}/></>;
  return <details className="cashCollection" open={opened} onToggle={event=>setOpened(event.currentTarget.open)}>
    <summary>登記現金收款</summary>
    <form className="actions" onSubmit={confirm}>
      <label>實收金額<input type="text" inputMode="numeric" maxLength={16} value={tendered}
        disabled={busy||disabled||Boolean(pending)} onChange={event=>{setTendered(event.target.value);setError("");}}/></label>
      <button className="outline" disabled={busy||disabled||(!pending&&(change===null||change<0))}>
        {busy?"收款確認中…":pending?"重試確認收款":"確認現金收款"}
      </button>
    </form>
    {tendered&&!valid&&<p>請輸入整數金額。</p>}
    {change!==null&&<p aria-live="polite">{change<0?"尚差 NT$ "+(-change):"應找零 NT$ "+change}</p>}
    {error&&<p className="error" role="alert">{error}</p>}
  </details>;
}
