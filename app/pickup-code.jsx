"use client";

import {useMemo,useSyncExternalStore} from "react";
import {qrImage} from "../lib/qr-image.mjs";

const subscribe=()=>()=>{};
const browserOrigin=()=>location.origin;
const serverOrigin=()=>null;

export default function PickupCode({number,pass}){
  const origin=useSyncExternalStore(subscribe,browserOrigin,serverOrigin);
  const image=useMemo(()=>{
    if(!origin)return "";
    const scanUrl=new URL("/kitchen",origin);
    scanUrl.searchParams.set(pass?"delegate":"pickup",number);
    if(pass)scanUrl.hash=pass;
    return qrImage(scanUrl.href);
  },[origin,number,pass]);
  return <details className="pickupCode">
    <summary>出示取餐 QR 碼</summary>
    {image&&<img src={image} width="184" height="184" alt={"取餐 "+number+" QR 碼"}/>}
    <p>{pass?"請讓店員掃描這張代取 QR 碼，核對後取餐。":<>請讓店員掃描，或直接告知取餐號碼 {number}。</>}</p>
  </details>;
}
