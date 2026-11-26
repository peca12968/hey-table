import {reconcileCash} from "../lib/cash-reconciliation.mjs";

const movements=["tendered","change","net"];
const counts=["opening","adjustments","counted","expected","difference"];
const difference=(before,after)=>String(BigInt(after)-BigInt(before));
const snapshotKeys=["tendered","change","amount","recordedAt","correctionRevision","correctedAt"];

function indexRows(report){
  const rows=new Map();
  const totals={tendered:0n,change:0n,net:0n};
  for(const row of report.receipts){
    const {orderId,tendered,change,amount,recordedAt,correctionRevision=0,correctedAt=null}=row;
    if(!Number.isSafeInteger(orderId)||orderId<1||rows.has(orderId)||
      ![tendered,change,amount,recordedAt,correctionRevision].every(value=>Number.isSafeInteger(value)&&value>=0)||
      tendered-amount!==change||(correctionRevision>0&&(!Number.isSafeInteger(correctedAt)||correctedAt<recordedAt)))
      throw new Error("Invalid receipt in saved cash close");
    rows.set(orderId,{tendered:String(tendered),change:String(change),amount:String(amount),recordedAt,correctionRevision,correctedAt});
    totals.tendered+=BigInt(tendered);
    totals.change+=BigInt(change);
    totals.net+=BigInt(amount);
  }
  if(rows.size!==report.totals.receipts||movements.some(key=>String(totals[key])!==report.totals[key]))
    throw new Error("Saved cash close totals differ from receipts");
  const {opening,adjustments,counted}=report.reconciliation;
  const verified=reconcileCash(totals.net,BigInt(opening),BigInt(adjustments),BigInt(counted));
  if(counts.some(key=>verified[key]!==report.reconciliation[key]))
    throw new Error("Saved cash close counted balance does not reconcile");
  return rows;
}

export function compareCashCloses(before,after){
  const previous=indexRows(before.report),current=indexRows(after.report);
  const totals={...Object.fromEntries(movements.map(key=>[key,{before:before.report.totals[key],after:after.report.totals[key],
    delta:difference(before.report.totals[key],after.report.totals[key])}])),
  receipts:{before:before.report.totals.receipts,after:after.report.totals.receipts,
    delta:after.report.totals.receipts-before.report.totals.receipts}};
  const reconciliation=Object.fromEntries(counts.map(key=>[key,{before:before.report.reconciliation[key],
    after:after.report.reconciliation[key],delta:difference(before.report.reconciliation[key],after.report.reconciliation[key])}]));
  const receipts=[];
  for(const orderId of [...new Set([...previous.keys(),...current.keys()])].sort((a,b)=>a-b)){
    const prior=previous.get(orderId)??null,next=current.get(orderId)??null;
    if(prior&&next&&snapshotKeys.every(key=>prior[key]===next[key]))continue;
    const kind=!prior?"added":!next?"missing":
      prior.amount===next.amount&&prior.recordedAt===next.recordedAt&&next.correctionRevision>prior.correctionRevision?"corrected":"changed";
    const delta=Object.fromEntries([["tendered","tendered"],["change","change"],["net","amount"]]
      .map(([key,field])=>[key,difference(prior?.[field]??"0",next?.[field]??"0")]));
    receipts.push({orderId,kind,before:prior,after:next,delta});
  }
  const anchor=version=>({revision:version.revision,savedAt:version.savedAt,capturedAt:version.report.capturedAt});
  return {format:"hey-table.cash-close-comparison.v1",date:before.date,timeZone:"Asia/Taipei",
    from:anchor(before),to:anchor(after),totals,reconciliation,receipts};
}
