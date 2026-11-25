"use client";

import {useRef,useState} from "react";
import {cartShareAddressLimit,cartShareLink,readCartShareAddress} from "../lib/cart-share.mjs";

const focusHeading=node=>node?.focus();

export function ShareCart({items,disabled}){
  const [origin,setOrigin]=useState(""),[notice,setNotice]=useState(null);
  const input=useRef(null);
  const link=origin&&cartShareLink(origin,items);

  async function copy(){
    try{await navigator.clipboard.writeText(link);setNotice({link,text:"已複製點餐清單連結。"});}
    catch{input.current?.select();setNotice({link,text:"已選取連結，可手動複製。"});}
  }

  return <div className="cartShare">
    <button className="outline" aria-expanded={!!link} disabled={disabled} onClick={()=>setOrigin(link?"":location.origin)}>分享點餐清單</button>
    {link&&<section className="supplyReview" aria-label="分享點餐清單連結">
      <p>連結只含品項與份數。開啟可接續自取，掃描桌牌後也可貼到內用餐單。</p>
      <input ref={input} aria-label="點餐清單連結" value={link} readOnly onFocus={event=>event.currentTarget.select()}/>
      <button className="outline" disabled={disabled} onClick={copy}>複製清單連結</button>
      {notice?.link===link&&<p role="status">{notice.text}</p>}
    </section>}
  </div>;
}

export function PasteSharedCart({table,busy,onRead}){
  const [open,setOpen]=useState(false),[input,setInput]=useState(""),[error,setError]=useState("");
  function preview(event){
    event.preventDefault();
    const lines=readCartShareAddress(input,location.origin);
    if(lines)onRead(lines);
    else setError("請貼上這個點餐網站產生的分享清單連結。");
  }
  return <div className="cartShare">
    <button className="outline" aria-expanded={open} disabled={busy} onClick={()=>setOpen(value=>!value)}>貼上點餐清單</button>
    {open&&<form className="supplyReview" onSubmit={preview}>
      <label>分享清單連結<input type="text" inputMode="url" autoComplete="off" maxLength={cartShareAddressLimit}
        value={input} required disabled={busy} aria-invalid={!!error||undefined} onChange={event=>{setInput(event.target.value);setError("");}}/></label>
      {error&&<p role="alert">{error}</p>}
      <button className="outline" disabled={busy}>在{table?table+"桌":"自取餐單"}預覽</button>
    </form>}
  </div>;
}

export function ReviewSharedCart({share,plan,cart,table,busy,pending,notice,onAdd,onClose}){
  return <section className="supplyReview sharedCartReview" aria-labelledby="shared-cart-title">
    <h3 id="shared-cart-title" tabIndex={-1} ref={focusHeading}>核對分享的餐點</h3>
    {!share.lines?<p role="alert">這個清單連結無法讀取，請向分享者取得新連結。</p>:
      <>
        <p>加入至 <strong>{table?table+" 桌內用":"線上自取"}</strong>。請核對目前可加入的份數。</p>
        {plan&&<ul>{plan.map(({id,name,added,reason},index)=><li key={id}>
          <strong>{name}</strong>
          <span>清單 {share.lines[index].qty} 份 · {added?"可加入 "+added+" 份":"目前無法加入"}</span>
          {added>0&&cart[id]>0&&<small>加入後共 {cart[id]+added} 份</small>}
          {reason&&<small>{reason}</small>}
        </li>)}</ul>}
        {pending&&<p>請先確認目前餐單的送單結果。</p>}
        {notice&&<p role="status">{notice}</p>}
        <button className="primary" disabled={busy||pending||!plan?.some(item=>item.added>0)} onClick={onAdd}>確認加入清單餐點</button>
      </>}
    <button className="outline" disabled={busy} onClick={onClose}>關閉清單預覽</button>
  </section>;
}
