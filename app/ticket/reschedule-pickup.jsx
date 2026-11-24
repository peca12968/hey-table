import {useEffect,useRef,useState} from "react";
import {pickupWindow} from "../../lib/pickup-slots.mjs";
import {request} from "../shared";

export default function ReschedulePickup({order,token,onChange}){
  const [review,setReview]=useState(null),[slots,setSlots]=useState(null),[reload,setReload]=useState(0);
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState(""),[listError,setListError]=useState(false);
  const inFlight=useRef(false);
  const changes=order.pickupChanges??[];
  const latest=changes.at(-1);
  const confirmed=review?.uncertain&&changes.length===review.revision+1&&latest?.from===review.from&&latest.to===review.to;
  const opened=!!review&&!confirmed;
  const validReview=opened&&order.canReschedulePickup&&review.from===order.pickupSlot&&review.revision===changes.length;
  const count=order.items.reduce((sum,item)=>sum+item.qty,0);

  useEffect(()=>{
    if(!opened)return;
    const controller=new AbortController();
    request("/api/pickup-slots",{signal:controller.signal}).then(result=>{
      if(!controller.signal.aborted){setSlots(result.slots);setListError(false);}
    }).catch(()=>{if(!controller.signal.aborted){setSlots(null);setListError(true);}});
    return ()=>controller.abort();
  },[opened,reload]);

  function showChoices(){
    setFailure("");setListError(false);setSlots(null);setReload(value=>value+1);
    setReview({from:order.pickupSlot,to:null,revision:changes.length,uncertain:false});
  }
  async function confirm(event){
    event.preventDefault();
    if(inFlight.current||!validReview||review.to===null)return;
    inFlight.current=true;setBusy(true);setFailure("");
    const {from,to,revision}=review;
    try{
      await request("/api/ticket/reschedule",{method:"POST",headers:{"Content-Type":"application/json","X-Ticket":token},
        body:JSON.stringify({from,to,revision}),signal:AbortSignal.timeout(15_000)});
      setReview(null);
    }catch(error){
      if(error.status===409||error.status===400){
        setFailure(error.message);
        setReview({...review,to:null,uncertain:false});
        setReload(value=>value+1);
      }else{
        setFailure("尚未收到改期結果。可用原資料重試。");
        setReview({...review,uncertain:true});
      }
    }finally{inFlight.current=false;setBusy(false);onChange();}
  }
  if(!opened)return order.canReschedulePickup?<button className="outline pickupSlotsButton" onClick={showChoices}>更改取餐時段</button>:null;

  const alternatives=(slots??[]).filter(slot=>slot.start!==review.from&&slot.remaining>=count);
  return <form className="pickupSlots pickupReschedule" aria-label="更改取餐時段" onSubmit={confirm}>
    {validReview?<>
      <label>新的取餐時段<select value={review.to??""} disabled={busy||review.uncertain} onChange={event=>{
        setFailure("");setReview({...review,to:event.target.value===""?null:Number(event.target.value)});
      }}>
        <option value="">選擇時段</option>
        {review.to!==null&&!alternatives.some(slot=>slot.start===review.to)&&<option value={review.to}>{pickupWindow(review.to)}</option>}
        {alternatives.map(slot=><option key={slot.start} value={slot.start}>{pickupWindow(slot.start)} · 剩 {slot.remaining} 份</option>)}
      </select></label>
      {!busy&&!review.uncertain&&<p className="muted">改期確認後，才會釋放原預約。</p>}
      {slots&&alternatives.length===0&&!review.uncertain&&<p role="status">目前沒有可容納這張餐單的其他時段。</p>}
      {!slots&&!listError&&<p role="status">正在讀取可選時段…</p>}
      {listError&&<p role="status">暫時無法讀取時段。</p>}
    </>:<p role="status">餐單已更新，請核對最新預約時段。</p>}
    {failure&&<p className="error" role="alert">{failure}</p>}
    <div className="actions">
      {validReview&&<button className="primary" disabled={busy||review.to===null}>{busy?"改期確認中…":review.uncertain?"重試同一次改期":"確認改期"}</button>}
      {validReview&&listError&&<button type="button" className="outline" disabled={busy} onClick={()=>setReload(value=>value+1)}>重讀時段</button>}
      {!validReview&&order.canReschedulePickup&&<button type="button" className="outline" disabled={busy} onClick={showChoices}>重新選擇時段</button>}
      <button type="button" className="outline" disabled={busy} onClick={()=>setReview(null)}>關閉改期</button>
    </div>
  </form>;
}
