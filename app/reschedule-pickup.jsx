import {useRef,useState} from "react";
import {pickupBookingDays,pickupWindow} from "../lib/pickup-slots.mjs";
import {businessDate} from "../lib/business-day.mjs";
import {PickupDate,usePickupSlotAvailability} from "./pickup-slots";
import {PickupChoiceList} from "./pickup-suggestion";
import {useBusinessToday} from "./use-business-today.mjs";
import {request} from "./shared";

export default function ReschedulePickup({order,canReschedule=order.canReschedulePickup,disabled=false,submit,onChange,ticket,staffKey}){
  const [review,setReview]=useState(null);
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState("");
  const [finding,setFinding]=useState(null),[suggestionStatus,setSuggestionStatus]=useState("");
  const [comparison,setComparison]=useState(null);
  const inFlight=useRef(false);
  const revision=order.pickupRevision??order.pickupChanges?.length??0;
  const latest=order.latestPickupChange??order.pickupChanges?.at(-1);
  const locked=busy||disabled||finding;
  const confirmed=review?.uncertain&&revision===review.revision+1&&latest?.from===review.from&&latest.to===review.to;
  const opened=!!review&&!confirmed;
  const day=review?.day??"";
  const today=useBusinessToday();
  const date=day||today;
  const crossesDay=date&&businessDate(order.pickupSlot)!==date;
  const optionsUrl=ticket?"/api/ticket/reschedule-options?"+new URLSearchParams({date}):
    "/api/kitchen/pickup-reschedule-options?"+new URLSearchParams({date,id:String(order.id)});
  const requestUrl=crossesDay?optionsUrl:undefined;
  const validReview=opened&&canReschedule&&review.from===order.pickupSlot&&review.revision===revision;
  const count=order.items.reduce((sum,item)=>sum+item.qty,0);
  const {slots,snapshot,error,selectedBlocked,refresh}=usePickupSlotAvailability({
    selected:review?.to??null,count,active:validReview&&!review.uncertain,revision,day,alwaysOpen:true,
    requestUrl,ticket:crossesDay?ticket:undefined,staffKey:crossesDay?staffKey:undefined,
  });
  const canConfirm=validReview&&review.to!==null&&(review.uncertain||!selectedBlocked);

  function showChoices(){
    setFailure("");setSuggestionStatus("");refresh();
    const orderDay=businessDate(order.pickupSlot);
    const [, ...future]=pickupBookingDays(Date.now());
    setReview({from:order.pickupSlot,to:null,day:future.includes(orderDay)?orderDay:"",revision,uncertain:false});
  }
  function choose(slot){
    refresh();
    setReview(current=>current===review?{...current,day:slot.date,to:slot.start}:current);
    setComparison(null);setFailure("");
    setSuggestionStatus(`已選擇 ${slot.date} ${pickupWindow(slot.start)}，請核對時段後確認。`);
  }
  async function find(compare){
    if(locked||!validReview)return;
    setFinding(compare?"compare":"next");setComparison(null);setSuggestionStatus("");setFailure("");
    try{
      const headers=ticket?{"X-Ticket":ticket}:staffKey?{Authorization:"Bearer "+staffKey}:{};
      const preferred=review.to??(businessDate(review.from)===date?review.from:null);
      const query=compare?"&alternatives=1"+(preferred===null?"":"&fromSlot="+preferred):"&suggest=1";
      const result=await request(optionsUrl+query,{headers,signal:AbortSignal.timeout(10_000)});
      if(compare&&(result.from!==review.from||result.revision!==review.revision)){
        setSuggestionStatus("餐單預約已更新，請核對目前時段。");
        onChange();
      }else if(compare&&result.suggestions.length){
        setComparison({review,choices:result.suggestions});
        setSuggestionStatus(`找到 ${result.suggestions.length} 個可用時段。選擇後會重新核對供應。`);
      }else if(result.suggestion){
        choose(result.suggestion);
      }else setSuggestionStatus("接下來的可預約日期沒有符合這張餐單的時段。");
    }catch{setSuggestionStatus("暫時無法尋找可用日期，請再試一次。");}
    finally{setFinding(null);}
  }
  async function confirm(event){
    event.preventDefault();
    if(inFlight.current||locked||!canConfirm)return;
    inFlight.current=true;setBusy(true);setFailure("");setSuggestionStatus("");
    const {from,to,revision}=review;
    try{
      await submit({from,to,revision},AbortSignal.timeout(15_000));
      setReview(null);
    }catch(error){
      if(error.status===409||error.status===400){
        setFailure(error.message);
        setReview({...review,to:null,uncertain:false});
        refresh();
      }else{
        setFailure("尚未收到改期結果。可用原資料重試。");
        setReview({...review,uncertain:true});
      }
    }finally{inFlight.current=false;setBusy(false);onChange();}
  }
  if(!opened)return canReschedule?<button className="outline pickupSlotsButton" disabled={disabled} onClick={showChoices}>更改取餐時段</button>:null;

  const alternatives=slots.filter(slot=>slot.start!==review.from&&slot.remaining>=count);
  const shortages=snapshot?.shortages??[];
  const canSuggest=validReview&&!review.uncertain&&snapshot&&
    (snapshot.paused||shortages.length>0||alternatives.length===0||selectedBlocked);
  return <form className="pickupSlots pickupReschedule" aria-label="更改取餐時段" onSubmit={confirm}>
    {validReview?<>
      <PickupDate label="新的取餐日期" value={day} disabled={locked||review.uncertain} onChange={value=>{
        setFailure("");setSuggestionStatus("");refresh();setReview({...review,day:value,to:null});
      }}/>
      <label>新的取餐時段<select value={review.to??""} disabled={locked||review.uncertain} onChange={event=>{
        setFailure("");setSuggestionStatus("");setReview({...review,to:event.target.value===""?null:Number(event.target.value)});
      }}>
        <option value="">選擇時段</option>
        {review.to!==null&&!alternatives.some(slot=>slot.start===review.to)&&<option value={review.to}>{pickupWindow(review.to)}</option>}
        {alternatives.map(slot=><option key={slot.start} value={slot.start}>{pickupWindow(slot.start)} · 剩 {slot.remaining} 份</option>)}
      </select></label>
      {!busy&&!review.uncertain&&<p className="muted">改期確認後，才會釋放原預約。</p>}
      {!review.uncertain&&<>
        {snapshot?.paused?<p role="status">這個日期已暫停時段預約。</p>:
          shortages.length>0?<p role="status">取餐日份數不足的餐點為 {shortages.map(id=>order.items.find(item=>item.id===id)?.name??id).join("、")}。原預約仍有效。</p>:
          snapshot&&selectedBlocked?<p role="status">新時段目前無法容納這張餐單，原預約仍有效。</p>:
          snapshot&&alternatives.length===0?<p role="status">目前沒有可容納這張餐單的其他時段。</p>:null}
        {error?<p role="status">{error}</p>:!snapshot&&<p role="status">正在讀取可選時段…</p>}
      </>}
    </>:<p role="status">餐單已更新，請核對最新預約時段。</p>}
    {validReview&&suggestionStatus&&<p role="status">{suggestionStatus}</p>}
    {validReview&&!review.uncertain&&comparison?.review===review&&
      <PickupChoiceList choices={comparison.choices} disabled={locked} onChoose={choose}/>}
    {failure&&<p className="error" role="alert">{failure}</p>}
    <div className="actions">
      {validReview&&<button className="primary" disabled={locked||!canConfirm}>{busy?"改期確認中…":review.uncertain?"重試同一次改期":"確認改期"}</button>}
      {validReview&&!review.uncertain&&(error||snapshot)&&<button type="button" className="outline" disabled={locked} onClick={refresh}>
        {error?"重讀時段":"重新檢查時段"}
      </button>}
      {validReview&&!review.uncertain&&<button type="button" className="outline" disabled={locked} onClick={()=>find(true)}>
        {finding==="compare"?"正在尋找時段…":"比較可用取餐時段"}
      </button>}
      {(canSuggest||finding==="next")&&<button type="button" className="outline" disabled={locked} onClick={()=>find(false)}>
        {finding==="next"?"正在尋找…":"找下一個可用日期"}
      </button>}
      {!validReview&&canReschedule&&<button type="button" className="outline" disabled={locked} onClick={showChoices}>重新選擇時段</button>}
      <button type="button" className="outline" disabled={locked} onClick={()=>setReview(null)}>關閉改期</button>
    </div>
  </form>;
}
