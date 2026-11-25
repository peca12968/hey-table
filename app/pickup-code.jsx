"use client";

import {useMemo,useSyncExternalStore} from "react";
import {qrImage} from "../lib/qr-image.mjs";

const subscribe=()=>()=>{};
const browserOrigin=()=>location.origin;
const serverOrigin=()=>null;

export default function PickupCode({number}){
  const origin=useSyncExternalStore(subscribe,browserOrigin,serverOrigin);
  const image=useMemo(()=>{
    if(!origin)return "";
    const scanUrl=new URL("/kitchen",origin);
    scanUrl.searchParams.set("pickup",number);
    return qrImage(scanUrl.href);
  },[origin,number]);
  return <details className="pickupCode">
    <summary>出示取餐 QR 碼</summary>
    {image&&<img src={image} width="184" height="184" alt={"取餐 "+number+" QR 碼"}/>}
    <p>請讓店員掃描，或直接告知取餐號碼 {number}。</p>
  </details>;
}
