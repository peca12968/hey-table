"use client";
import {useEffect,useState} from "react";
import {Header,Footer,request} from "../../shared";
import {dishes,numberOf,withItemNotes} from "../../../lib/menu.mjs";
import {ItemNotesEditor} from "../../item-notes";
import "./pickup.css";

const endpoint="/api/kitchen/create-pickup";
const draftKey="he-ri-staff-pickup-draft";
const empty={quantities:{},lineNotes:{},note:"",attempt:null,result:null};

function staffHeaders(){
  const key=sessionStorage.getItem("he-ri-staff");
  return key?{Authorization:"Bearer "+key}:{};
}

function savedDraft(){
  try{return JSON.parse(sessionStorage.getItem(draftKey))??empty;}
  catch{return empty;}
}

function availableQuantity(menu,id){
  return menu.unavailable.includes(id)?0:Math.min(20,menu.remaining?.[id]??20);
}

export default function CreatePickup(){
  const [draft,setDraft]=useState(null),[menu,setMenu]=useState(null),[revision,setRevision]=useState(0);
  const [busy,setBusy]=useState(false),[denied,setDenied]=useState(false),[menuError,setMenuError]=useState("");
  const [error,setError]=useState(""),[message,setMessage]=useState("");
  useEffect(()=>{
    const controller=new AbortController();
    request(endpoint,{headers:staffHeaders(),signal:controller.signal}).then(value=>{
      if(controller.signal.aborted)return;
      setMenu(value);setMenuError("");setDenied(false);
      setDraft(current=>current??savedDraft());
    }).catch(failure=>{
      if(controller.signal.aborted)return;
      setMenu(null);setDenied(failure.status===403);setMenuError(failure.message);
    });
    return ()=>controller.abort();
  },[revision]);

  function saveDraft(next){
    try{sessionStorage.setItem(draftKey,JSON.stringify(next));}
    catch{return false;}
    setDraft(next);
    return true;
  }

  const {quantities,lineNotes={},note,attempt,result}=draft??empty;
  const lines=dishes.filter(dish=>Number(quantities[dish.id])>0);
  const total=lines.reduce((amount,dish)=>amount+dish.price*Number(quantities[dish.id]),0);
  const exceedsSupply=menu&&lines.some(dish=>Number(quantities[dish.id])>availableQuantity(menu,dish.id));
  const locked=busy||Boolean(attempt);
  const receiptLink=result?"/ticket#"+result.token:"";

  async function submit(event){
    event.preventDefault();
    if(busy||!menu||(!attempt&&(!lines.length||exceedsSupply)))return;
    setError("");
    const payload=attempt??{token:crypto.randomUUID(),note:note.trim(),expectedTotal:total,
      items:withItemNotes(lines.map(dish=>({id:dish.id,qty:Number(quantities[dish.id])})),lineNotes)};
    const pending={...draft,attempt:payload};
    if(!saveDraft(pending)){
      setError("瀏覽器無法保存送單資料。請開啟網站儲存權限後再送單。");
      return;
    }
    setBusy(true);
    try{
      const order=await request(endpoint,{method:"POST",headers:{"Content-Type":"application/json",...staffHeaders()},
        body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});
      const complete={...empty,result:{id:order.id,total:order.total,token:payload.token}};
      if(!saveDraft(complete))setDraft(complete);
    }catch(failure){
      if(failure.status===400||failure.status===409){
        const editable={...pending,attempt:null};
        if(!saveDraft(editable))setDraft(editable);
        setError(failure.message);
        setRevision(value=>value+1);
      }else if(failure.status===403){
        setDenied(true);setMenu(null);setMenuError(failure.message);
      }else setError("尚未收到送單結果。請用原餐單重試。");
    }finally{setBusy(false);}
  }

  async function copyReceipt(){
    try{
      await navigator.clipboard.writeText(new URL(receiptLink,location.origin).href);
      setMessage("已複製收據連結。");
    }catch{setMessage("請開啟顧客收據，再從網址列複製連結。");}
  }

  return <><Header/><main className="shell section narrow staffPickup">
    <a className="textLink" href="/kitchen">返回店家接單台</a>
    <h1>代建自取單</h1>
    {menuError&&<p className="error" role="alert">{menuError}</p>}
    {denied&&<a className="primary" href="/signin-with-chatgpt?return_to=%2Fkitchen%2Fcreate-pickup" target="_top">使用 ChatGPT 登入</a>}
    {!menu&&!menuError&&<p role="status">正在確認店員身分與菜單…</p>}
    {!menu&&menuError&&!denied&&<button className="outline" onClick={()=>setRevision(value=>value+1)}>重新讀取</button>}
    {menu&&result&&<section className="sheet pickupForm" aria-label="已建立自取單">
      <p role="status">已建立自取單</p>
      <h2>取餐號碼 {numberOf(result.id)}</h2>
      <p>現場付款 · NT$ {result.total}</p>
      <div className="actions">
        <a className="primary" target="_blank" rel="noreferrer" href={receiptLink}>開啟顧客收據</a>
        <button className="outline" onClick={copyReceipt}>複製收據連結</button>
        <button className="outline" onClick={()=>{
          if(!saveDraft(empty))return setMessage("瀏覽器無法保存餐單，請開啟網站儲存權限。");
          setMessage("");setError("");setRevision(value=>value+1);
        }}>開始下一張</button>
      </div>
      {message&&<p role="status">{message}</p>}
    </section>}
    {menu&&draft&&!result&&<form className="sheet pickupForm" onSubmit={submit}>
      <div className="menuTitle"><strong>現場付款</strong>
        <button type="button" className="outline" disabled={busy} onClick={()=>setRevision(value=>value+1)}>更新供應</button>
      </div>
      <ul className="orderLines">{dishes.map(dish=><li key={dish.id}>
        <label htmlFor={"qty-"+dish.id}><strong>{dish.name}</strong><small>NT$ {dish.price}{availableQuantity(menu,dish.id)===0?
          " · 已售完":menu.remaining?.[dish.id]!==undefined?" · 今日剩餘 "+menu.remaining[dish.id]+" 份":""}</small></label>
        <input id={"qty-"+dish.id} type="number" inputMode="numeric" min="0" max="20" step="1" value={quantities[dish.id]??""}
          disabled={locked||(!quantities[dish.id]&&availableQuantity(menu,dish.id)===0)} onChange={event=>{
            const value=event.target.value,nextNotes={...lineNotes};
            if(!Number(value))delete nextNotes[dish.id];
            setError("");setDraft({...draft,quantities:{...quantities,[dish.id]:value},lineNotes:nextNotes});
          }}/>
      </li>)}</ul>
      {lines.length>0&&<ItemNotesEditor dishes={lines} notes={lineNotes} disabled={locked}
        onChange={(id,value)=>setDraft({...draft,lineNotes:{...lineNotes,[id]:value}})}/>}
      <label className="note">訂單備註<textarea maxLength={160} value={note} disabled={locked}
        placeholder="例如：不要餐具" onChange={event=>setDraft({...draft,note:event.target.value})}/></label>
      <div className="total"><span>合計</span><b>NT$ {attempt?.expectedTotal??total}</b></div>
      {error&&<p className="error" role="alert">{error}</p>}
      {attempt&&!busy&&!error&&<p role="status">這張餐單的送單結果尚待確認。</p>}
      {exceedsSupply&&!attempt&&<p className="error" role="status">部分餐點已超過可供應份數，請調整餐單。</p>}
      <button className="primary full" disabled={busy||(!attempt&&(!lines.length||exceedsSupply))}>
        {busy?"送單中…":attempt?"重試同一張自取單":"確認建立自取單"}
      </button>
    </form>}
  </main><Footer/></>;
}
