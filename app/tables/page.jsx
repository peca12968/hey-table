"use client";
import {Printer} from "lucide-react";
import {Header,Footer} from "../shared";
import {tables} from "../../lib/menu.mjs";
export default function Tables(){
  return <><Header/><main className="shell section"><div className="menuTitle"><div><p className="eyebrow">TABLE ORDERING</p><h1>桌邊點餐牌</h1></div><button className="outline" onClick={()=>window.print()}><Printer size={16}/> 列印桌牌</button></div>
  <p className="muted">每桌使用專屬 QR Code。掃描後，餐單會自動帶入桌號。</p>
  <div className="tableGrid">{tables.map(t=><article className="qrCard" key={t}><p>禾日食堂</p><h2>{t} 桌</h2><img src={"/api/qr?table="+t} alt={t+" 桌點餐 QR Code"} width="180" height="180"/><p>掃描點餐</p><a className="textLink" href={"/?table="+t}>開啟桌邊菜單</a></article>)}</div></main><Footer/></>;
}
