"use client";

import {useEffect,useState} from "react";
import {request} from "../shared";
import {paymentStates} from "../../lib/payments.mjs";
import "./payment-attention-notes.css";

const endpoint="/api/kitchen/payment-attention-notes";
const clock=new Intl.DateTimeFormat("zh-TW",{timeZone:"Asia/Taipei",dateStyle:"medium",timeStyle:"short",hourCycle:"h23"});
const time=at=><time dateTime={new Date(at).toISOString()}>{clock.format(at)}</time>;
const staffHeaders=()=>{
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
};

export default function PaymentAttentionNotes({id,autoOpen,attemptId,allNotes}){
  const [open,setOpen]=useState(autoOpen),[version,setVersion]=useState(0),[view,setView]=useState(null);
  const [draft,setDraft]=useState(""),[save,setSave]=useState(null),[more,setMore]=useState(null);
  const [followUp,setFollowUp]=useState("keep"),[deadline,setDeadline]=useState("");
  const current=view?.version===version?view:null;
  const data=current?.data,target=data?.target;
  const params=new URLSearchParams({id,...(attemptId===null?{}:{attempt:attemptId})}).toString();
  const reload=()=>setVersion(value=>value+1);
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    request(endpoint+"?"+params,{headers:staffHeaders(),
      signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10_000)])}).then(data=>{
      if(!controller.signal.aborted)setView({version,data});
    }).catch(error=>{
      if(!controller.signal.aborted)setView({version,error:error.name==="TimeoutError"?"讀取備註逾時，請重新讀取。":error.message});
    });
    return ()=>controller.abort();
  },[params,open,version]);

  async function submit(event){
    event.preventDefault();
    if(save?.busy||(!save?.payload&&(!target||!draft.trim())))return;
    let payload=save?.payload;
    if(!payload){
      payload={id,attemptId:target.attemptId,state:target.state,note:draft.trim(),operationId:crypto.randomUUID()};
      if(followUp!=="keep"){
        const followUpAt=followUp==="cancel"?null:Date.parse(deadline+":00+08:00");
        if(followUpAt!==null&&(!Number.isSafeInteger(followUpAt)||followUpAt<1)){
          setSave({error:"請選擇有效的台灣追蹤時間。"});
          return;
        }
        Object.assign(payload,{followUpAt,followUpVersion:target.followUpVersion??null});
      }
    }
    setSave({busy:true,payload});
    try{
      await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(10_000)});
      setDraft("");
      setFollowUp("keep");
      setDeadline("");
      setSave({message:"已儲存交班備註。"});
      reload();
    }catch(error){
      const definitive=error.status>=400&&error.status<500;
      setSave({payload:definitive?null:payload,error:definitive?error.message:"尚未收到儲存結果，請重試同一筆備註。"});
      if(error.status===409){
        setFollowUp("keep");
        setDeadline("");
        reload();
      }
    }
  }

  async function loadOlder(){
    if(!data?.nextBefore||more?.busy)return;
    setMore({busy:true});
    try{
      const earlier=await request(endpoint+"?"+params+"&"+new URLSearchParams({before:data.nextBefore}),
        {headers:staffHeaders(),signal:AbortSignal.timeout(10_000)});
      setView(previous=>previous?.data===data?{version,data:{...data,notes:[...data.notes,...earlier.notes],
        nextBefore:earlier.nextBefore}}:previous);
      setMore(null);
    }catch{
      setMore({error:"無法載入較早的備註，請再試一次。"});
    }
  }

  return <details id="payment-attention-notes" className="paymentAttentionNotes" open={open}
    onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>付款交班備註</summary>
    {open&&<div>
      {allNotes&&<a className="textLink" href={allNotes}>查看全部付款備註</a>}
      {!current&&<p role="status">正在讀取付款交班備註…</p>}
      {current?.error&&<p className="error" role="alert">{current.error}</p>}
      {save?.message&&<p role="status">{save.message}</p>}
      {save?.error&&<p className="error" role="alert">{save.error}</p>}
      {data&&<>
        {target&&<p>目前付款嘗試 · {time(target.startedAt)} · {paymentStates[target.state]}</p>}
        {target?.followUpAt&&<p>下次付款追蹤 {time(target.followUpAt)}</p>}
        {data.notes.length>0?<ol className="paymentAttentionNoteList" aria-label="付款交班備註歷程">
          {data.notes.map(entry=><li key={entry.id}>
            <p>{time(entry.recordedAt)} · {paymentStates[entry.state]}</p>
            <p>付款開始 {time(entry.startedAt)}</p>
            <p className="paymentAttentionNoteText">{entry.note}</p>
            {entry.followUpAt!==undefined&&<p>{entry.followUpAt===null?"已取消付款追蹤":<>追蹤時間 {time(entry.followUpAt)}</>}</p>}
          </li>)}
        </ol>:<p>{attemptId===null?"這張餐單尚無付款交班備註。":"這次付款尚無交班備註。"}</p>}
        {more?.error&&<p className="error" role="alert">{more.error}</p>}
        {data.nextBefore!==null&&<button className="outline" disabled={more?.busy||save?.busy}
          onClick={loadOlder}>{more?.busy?"載入中…":"載入較早備註"}</button>}
      </>}
      {(target||save?.payload)&&<form onSubmit={submit}>
        <label>交班備註<textarea value={draft} onChange={event=>setDraft(event.target.value)}
          maxLength={240} required rows={2} disabled={Boolean(save?.payload)}/></label>
        <label>追蹤時間處理<select value={followUp} onChange={event=>setFollowUp(event.target.value)} disabled={Boolean(save?.payload)}>
          <option value="keep">保留目前設定</option>
          <option value="set">設定追蹤時間</option>
          {(target?.followUpAt||followUp==="cancel")&&<option value="cancel">取消追蹤時間</option>}
        </select></label>
        {followUp==="set"&&<label>追蹤時間（台灣）<input type="datetime-local" value={deadline} required
          onChange={event=>setDeadline(event.target.value)} disabled={Boolean(save?.payload)}/></label>}
        <button className="primary" disabled={save?.busy||more?.busy||!draft.trim()}>
          {save?.busy?"儲存中…":save?.payload?"重試儲存同一筆備註":"儲存交班備註"}
        </button>
      </form>}
      {current&&<button className="outline paymentAttentionNotesRefresh" onClick={()=>{setMore(null);reload();}}
        disabled={save?.busy||more?.busy}>重新讀取備註</button>}
    </div>}
  </details>;
}
