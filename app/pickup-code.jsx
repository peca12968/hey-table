"use client";

import {useMemo,useSyncExternalStore} from "react";
import qrcode from "qrcode-generator";

const subscribe=()=>()=>{};
const browserOrigin=()=>location.origin;
const serverOrigin=()=>null;

export default function PickupCode({number}){
  const origin=useSyncExternalStore(subscribe,browserOrigin,serverOrigin);
  const image=useMemo(()=>{
    if(!origin)return "";
    const scanUrl=new URL("/kitchen",origin);
    scanUrl.searchParams.set("pickup",number);
    const code=qrcode(0,"M");
    code.addData(scanUrl.href);
    code.make();
    return code.createDataURL(6,24);
  },[origin,number]);
  return <details className="pickupCode">
    <summary>出示取餐 QR 碼</summary>
    {image&&<img src={image} width="184" height="184" alt={"取餐 "+number+" QR 碼"}/>}
    <p>請讓店員掃描，或直接告知取餐號碼 {number}。</p>
  </details>;
}
