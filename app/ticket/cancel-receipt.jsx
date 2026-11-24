"use client";
import {useRef,useState} from "react";
import {request} from "../shared";

export default function CancelReceipt({token,onChange}){
  const [confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false);
  const [failure,setFailure]=useState("");
  const inFlight=useRef(false);
  async function cancel(){
    if(inFlight.current)return;
    inFlight.current=true;
    setBusy(true);setFailure("");
    try{
      await request("/api/ticket/cancel",{method:"POST",
        headers:{"X-Ticket":token,"Content-Type":"application/json"},body:"{}"});
      setConfirmed(true);
    }catch(error){
      setFailure(error.status===409?error.message:"目前無法確認取消結果，可更新收據或再試一次。");
    }finally{
      onChange();
      setBusy(false);inFlight.current=false;
    }
  }
  if(confirmed)return <p className="cancelReceipt" role="status">餐單已取消，正在更新收據。</p>;
  return <section aria-label="取消餐單" className="cancelReceipt">
    {confirm?<><p>確定取消這張餐單？取消後會釋回餐點份數。</p>
      <div className="actions">
        <button className="outline" disabled={busy} onClick={()=>{setFailure("");setConfirm(false);}}>保留餐單</button>
        <button className="outline" disabled={busy} onClick={cancel}>{busy?"正在取消…":"確認取消餐單"}</button>
      </div></>:<button className="outline" onClick={()=>setConfirm(true)}>取消這張餐單</button>}
    {failure&&<p className="error" role="alert">{failure}</p>}
  </section>;
}
