"use client";
import {useRef,useState} from "react";
import {request} from "../shared";
import {ProgressTime} from "../order-progress";
import {orderNoteLimit} from "../../lib/menu.mjs";

export default function ReceiptNote({order,token,onChange}){
  const [draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
  const inFlight=useRef(false);
  const revision=order.noteRevision??0;
  const editable=order.status==="pending";
  const recovered=draft?.sent&&revision===draft.revision+1&&order.note===draft.note.trim();
  const conflict=draft&&draft.revision!==revision&&!recovered;

  function open(){
    setMessage("");setError("");
    setDraft({note:order.note??"",revision});
  }
  function close(){
    setError("");setDraft(null);
  }
  async function save(event){
    event.preventDefault();
    if(inFlight.current||!editable||conflict||!draft||recovered||draft.note.trim()===order.note)return;
    inFlight.current=true;
    setBusy(true);setError("");setDraft({...draft,sent:true});
    try{
      await request("/api/ticket/note",{method:"PATCH",headers:{"Content-Type":"application/json","X-Ticket":token},
        body:JSON.stringify({note:draft.note,expectedRevision:draft.revision}),signal:AbortSignal.timeout(10000)});
      setMessage("餐單備註已更新。");
      close();
    }catch(error){
      setError(error.status===409?error.message:"暫時無法確認備註，正在重新讀取收據。可再試一次。");
    }finally{
      setBusy(false);inFlight.current=false;
      onChange();
    }
  }

  if(!order.note&&!revision&&!editable&&!draft)return null;
  return <section className="receiptNote" aria-label="餐單備註">
    {(order.note||revision>0)&&<p className="orderNoteText">備註　{order.note||"已清除"}</p>}
    {order.noteUpdatedAt!=null&&<p className="muted">更新於 <ProgressTime at={order.noteUpdatedAt}/></p>}
    {(message||recovered)&&<p role="status">餐單備註已更新。</p>}
    {!draft&&editable&&<button className="outline" type="button" onClick={open}>{order.note?"修改餐單備註":"新增餐單備註"}</button>}
    {draft&&(recovered?<button className="outline" type="button" onClick={close}>完成</button>:
      <form onSubmit={save}>
        <label className="note">編輯餐單備註 <small>最多 {orderNoteLimit} 字</small>
          <textarea value={draft.note} maxLength={orderNoteLimit} disabled={!editable||busy} onChange={event=>{
            setDraft({...draft,note:event.target.value,sent:false});setError("");
          }}/>
        </label>
        {conflict&&editable&&<p role="alert">備註已有新版。請先核對收據上的備註，再選擇是否沿用這次編輯。</p>}
        {!editable&&<p role="status">餐單已開始處理或已結束。</p>}
        {error&&!conflict&&editable&&<p className="error" role="alert">{error}</p>}
        <div className="actions">
          {editable&&(conflict?<button className="outline" type="button" disabled={busy}
            onClick={()=>{setDraft({...draft,revision,sent:false});setError("");}}>沿用這次編輯</button>:
            <button className="primary" disabled={busy||draft.note.trim()===order.note}>{busy?"儲存中…":"儲存備註"}</button>)}
          <button className="outline" type="button" disabled={busy} onClick={close}>{editable?"放棄編輯":"關閉編輯"}</button>
        </div>
      </form>)}
  </section>;
}
