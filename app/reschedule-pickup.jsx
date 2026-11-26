import {useRef,useState,useSyncExternalStore} from "react";
import {datedPickupWindow,pickupBookingDays,pickupWindow,validPickupChange} from "../lib/pickup-slots.mjs";
import {businessDate} from "../lib/business-day.mjs";
import {read,save,withStorageLock} from "../lib/order-storage.mjs";
import {PickupDate,usePickupSlotAvailability} from "./pickup-slots";
import {PickupChoiceList} from "./pickup-suggestion";
import {useBusinessToday} from "./use-business-today.mjs";
import {request} from "./shared";

const changeStorageEvent="he-ri-reschedule-pending";
const sameChange=(a,b)=>!!a&&!!b&&a.from===b.from&&a.to===b.to&&a.revision===b.revision;
function subscribePending(sync){
  window.addEventListener("storage",sync);
  window.addEventListener(changeStorageEvent,sync);
  return ()=>{
    window.removeEventListener("storage",sync);
    window.removeEventListener(changeStorageEvent,sync);
  };
}
function storedChange(raw){
  try{
    const value=JSON.parse(raw);
    return validPickupChange(value)?value:null;
  }catch{return null;}
}

export default function ReschedulePickup({order,canReschedule=order.canReschedulePickup,disabled=false,submit,onChange,ticket,staffKey}){
  const [review,setReview]=useState(null);
  const [busy,setBusy]=useState(false),[failure,setFailure]=useState("");
  const [finding,setFinding]=useState(null),[suggestionStatus,setSuggestionStatus]=useState("");
  const [comparison,setComparison]=useState(null);
  const [lookupNotice,setLookupNotice]=useState(""),[checked,setChecked]=useState(null);
  const [volatile,setVolatile]=useState(null);
  const inFlight=useRef(false);
  const key="he-ri-reschedule:"+(ticket?"guest:"+ticket:"staff:"+order.id+":"+order.created);
  const savedChange=useSyncExternalStore(subscribePending,()=>{
    try{return localStorage.getItem(key);}catch{return null;}
  },()=>null);
  const pending=storedChange(savedChange)??(volatile?.key===key?volatile.change:null);
  const headers=ticket?{"X-Ticket":ticket}:{Authorization:"Bearer "+staffKey};
  const revision=order.pickupRevision??order.pickupChanges?.length??0;
  const latest=order.latestPickupChange??order.pickupChanges?.at(-1);
  const locked=busy||disabled||finding;
  const confirmed=review?.uncertain&&revision===review.revision+1&&latest?.from===review.from&&latest.to===review.to;
  const opened=!!review&&!confirmed&&(!pending||busy||review.uncertain&&sameChange(pending,review));
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
    setFailure("");setSuggestionStatus("");setLookupNotice("");refresh();
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
  async function forgetChange(change){
    await withStorageLock(key,()=>{
      if(sameChange(read(key,null),change)){
        try{localStorage.removeItem(key);}catch{}
      }
      window.dispatchEvent(new Event(changeStorageEvent));
    });
    setVolatile(null);setChecked(null);
  }
  async function settle(action){
    if(inFlight.current||locked)return;
    inFlight.current=true;setBusy(true);setFailure("");setSuggestionStatus("");setLookupNotice("");
    setChecked(null);
    let change=pending;
    try{
      if(action==="confirm"){
        const {from,to,revision}=review;
        const current={from,to,revision};
        const claimed=await withStorageLock(key,()=>{
          const existing=read(key,null);
          if(validPickupChange(existing))return false;
          save(key,current);
          window.dispatchEvent(new Event(changeStorageEvent));
          return true;
        });
        if(!claimed){setReview(null);return;}
        change=current;
        if(!sameChange(read(key,null),change))setVolatile({key,change});
      }
      if(action==="lookup"){
        const query=new URLSearchParams(change);
        if(!ticket)query.set("id",String(order.id));
        const url=ticket?"/api/ticket/reschedule":"/api/kitchen/pickup-reschedule";
        const result=await request(url+"?"+query,{headers,signal:AbortSignal.timeout(10_000)});
        if(result.state==="retryable"){
          setChecked(change);
          setLookupNotice("目前查無此筆改期紀錄，重送時會再次核對供應。");
          return;
        }
        if(result.state!=="confirmed"&&result.state!=="superseded")throw new Error("Invalid reschedule lookup");
        setLookupNotice(result.state==="confirmed"?`已查回改期紀錄 · ${datedPickupWindow(change.to)}。請核對目前預約。`:
          "原改期未成立或已無法重送，請核對目前預約。");
      }else await submit(change,AbortSignal.timeout(15_000));
      await forgetChange(change);
      setReview(null);
    }catch(error){
      if([400,404,409].includes(error.status)){
        if(change)await forgetChange(change);
        setFailure(error.message);
        if(review)setReview({...review,to:null,uncertain:false});
        refresh();
      }else{
        setFailure(action==="lookup"?"暫時無法查回改期結果，請再試一次。":"尚未收到改期結果。可用原資料重試。");
        if(action!=="lookup"&&review)setReview({...review,uncertain:true});
      }
    }finally{inFlight.current=false;setBusy(false);onChange();}
  }
  function confirm(event){
    event.preventDefault();
    if(canConfirm)void settle(review.uncertain?"retry":"confirm");
  }
  const lookupButton=<button className="outline" type="button" disabled={locked} onClick={()=>settle("lookup")}>查回改期結果</button>;
  const message=lookupNotice&&<p role="status">{lookupNotice}</p>;
  if(!opened){
    if(pending){
      return <section className="pickupSlots" aria-label="待查回的改期">
        <p>有一筆待確認的改期。{datedPickupWindow(pending.from)} → {datedPickupWindow(pending.to)}</p>
        {message}
        {failure&&<p className="error" role="alert">{failure}</p>}
        <div className="actions">
          {lookupButton}
          {sameChange(checked,pending)&&<button className="primary" type="button" disabled={locked} onClick={()=>settle("retry")}>重送原改期</button>}
        </div>
      </section>;
    }
    return <>{message}{failure&&<p className="error" role="alert">{failure}</p>}
      {canReschedule&&<button className="outline pickupSlotsButton" disabled={locked} onClick={showChoices}>更改取餐時段</button>}
    </>;
  }

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
    {message}
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
      {review.uncertain&&pending&&lookupButton}
      {!validReview&&canReschedule&&<button type="button" className="outline" disabled={locked} onClick={showChoices}>重新選擇時段</button>}
      <button type="button" className="outline" disabled={locked} onClick={()=>setReview(null)}>關閉改期</button>
    </div>
  </form>;
}
