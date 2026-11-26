import assert from "node:assert/strict";
import {resolve} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {fileURLToPath} from "node:url";
import {businessDate} from "../lib/business-day.mjs";
import {dishes} from "../lib/menu.mjs";
import {planSupplyReview,supplyReviewRows} from "../lib/supply-review.mjs";
import {api} from "../server/api.mjs";
import {pickupRescheduleOutcome,suggestCartPickupAlternatives,suggestPickupAlternatives} from "../server/pickup-slots.mjs";
import {applyDemoMigrations} from "./apply-demo-migrations.mjs";
import {sqliteD1} from "./sqlite-d1.mjs";

const site=fileURLToPath(new URL("../",import.meta.url));
const linesFor=cart=>dishes.flatMap(({id,name,price})=>cart[id]>0?[{id,name,price,qty:cart[id]}]:[]);
const subtotal=lines=>lines.reduce((total,line)=>total+line.qty*line.price,0);

export async function buildCartSupplyReviewDemo(){
  const sqlite=new DatabaseSync(":memory:");
  try{
    const db=sqliteD1(sqlite),env={DB:db,STAFF_KEY:"demo-only",TAPPAY_MODE:"demo"};
    await applyDemoMigrations(db,site);
    const date=businessDate(Date.now());
    const cart={gyoza:2,sencha:1},table="A05",paymentMethod="line_pay";
    const lines=linesFor(cart);
    const original={table,paymentMethod,lines,total:subtotal(lines)};
    async function call(path,{method="GET",input,token,staff=false,status=200}={}){
      const headers=new Headers({"Content-Type":"application/json"});
      if(token)headers.set("X-Ticket",token);
      if(staff)headers.set("Authorization","Bearer demo-only");
      const response=await api(new Request("https://demo.example/api/"+path,{
        method,headers,body:input===undefined?undefined:JSON.stringify(input),
      }),env);
      assert.equal(response.status,status);
      return response.json();
    }
    const supply=(dish,capacity,revision)=>call("kitchen/daily-limits",{method:"PATCH",staff:true,input:{date,dish,capacity,revision}});
    async function snapshot(){
      const {unavailable,remaining}=await call("menu?date="+date);
      const rows=supplyReviewRows(dishes,cart,unavailable,id=>Math.min(20,remaining[id]??20));
      assert.deepEqual(rows.map(row=>row.id),["gyoza"]);
      const {to,alternatives}=rows[0];
      const options=alternatives.map(({id,name,price,max})=>{
        const plan=planSupplyReview(cart,rows,{gyoza:id});
        return {id,name,price,available:max,total:subtotal(linesFor(plan))};
      });
      return {rows,preview:{remaining:to,options}};
    }
    const submit=(plan,token,status)=>call("orders",{method:"POST",status,input:{token,mode:"table",table,note:"",
      paymentMethod,paymentEnv:"demo",items:linesFor(plan).map(({id,qty})=>({id,qty}))}});
    await supply("gyoza",1,0);
    await supply("karaage",2,0);
    await supply("edamame",3,0);
    const before=await snapshot();
    const stale=planSupplyReview(cart,before.rows,{gyoza:"karaage"});
    await supply("karaage",0,1);
    const rejection=await submit(stale,"00000000-0000-4000-8000-000000000001",409);
    const after=await snapshot();
    assert.equal(planSupplyReview(cart,after.rows,{gyoza:"karaage"}),null);
    const selected=planSupplyReview(cart,after.rows,{gyoza:"edamame"});
    const token="00000000-0000-4000-8000-000000000002";
    await submit(selected,token,200);
    const {id,items,total,table:receiptTable,paymentMethod:method}=await call("ticket",{token});
    assert.deepEqual(items.map(({id,name,price,qty})=>({id,name,price,qty})),linesFor(selected));
    assert.deepEqual([receiptTable,method,total],[table,paymentMethod,subtotal(items)]);
    const at=Date.parse("2026-11-26T10:00:00+08:00"),pickupDay="2026-11-27";
    const fromSlot=Date.parse(pickupDay+"T11:00:00+08:00"),pickupItems=[{id:"sencha",qty:2}];
    const closeSlot=sqlite.prepare("INSERT INTO pickup_slot_limits(start,capacity,revision) VALUES (?,1,1)");
    closeSlot.run(fromSlot);
    const initial=await suggestCartPickupAlternatives(db,at,pickupDay,pickupItems,false,fromSlot);
    const closed=initial.suggestions[0].start;
    assert.equal(closed,fromSlot+900_000);
    closeSlot.run(closed);
    const refreshed=await suggestCartPickupAlternatives(db,at+5_000,pickupDay,pickupItems,false,fromSlot);
    assert.equal(refreshed.suggestions[0].start,fromSlot+1_800_000);
    const bookingDay="2026-11-28",booked=Date.parse(bookingDay+"T11:00:00+08:00");
    const bookingToken="00000000-0000-4000-8000-000000000003",bookingLines=linesFor({sencha:2});
    sqlite.prepare(`INSERT INTO orders(token,mode,note,items,total,created,pickup_slot)
      VALUES (?,'pickup','',?,?,?,?)`).run(bookingToken,JSON.stringify(bookingLines),subtotal(bookingLines),at,booked);
    const {order:beforeReschedule,...beforeChoices}=await suggestPickupAlternatives(db,at,bookingDay,"token",bookingToken,booked);
    const blocked=beforeChoices.suggestions[0].start;
    assert.equal(blocked,booked+900_000);
    closeSlot.run(blocked);
    const {order:afterReschedule,...afterChoices}=await suggestPickupAlternatives(db,at+5_000,bookingDay,"token",bookingToken,booked);
    assert.equal(afterChoices.suggestions[0].start,booked+1_800_000);
    assert.deepEqual([beforeReschedule.pickup_slot,beforeReschedule.status,beforeReschedule.pickup_changes],[booked,"pending",null]);
    assert.deepEqual(afterReschedule,beforeReschedule);
    const operation={from:booked,to:afterChoices.suggestions[0].start,revision:0};
    const retryable=await pickupRescheduleOutcome(db,at,"token",bookingToken,operation);
    const later=operation.to+900_000,firstChange={from:booked,to:operation.to,at:at+5_000};
    sqlite.prepare("UPDATE orders SET pickup_slot=?,pickup_changes=? WHERE token=?").run(later,JSON.stringify([
      firstChange,{from:operation.to,to:later,at:at+10_000,actor:"staff"},
    ]),bookingToken);
    const confirmed=await pickupRescheduleOutcome(db,at+15_000,"token",bookingToken,operation);
    assert.deepEqual(retryable,{state:"retryable",pickupSlot:booked,revision:0});
    assert.deepEqual(confirmed,{state:"confirmed",pickupSlot:later,revision:2,change:firstChange});
    return {format:"hey-table.cart-supply-review-demo.v1",original,before:before.preview,after:after.preview,
      rejected:rejection.code,receipt:{id,table:receiptTable,paymentMethod:method,total,
        lines:items.map(({id,name,price,qty})=>({id,name,price,qty}))},
      pickupAlternatives:{fromSlot,count:pickupItems[0].qty,closed,initial,refreshed},
      rescheduleAlternatives:{fromSlot:booked,count:bookingLines[0].qty,closed:blocked,initial:beforeChoices,
        refreshed:afterChoices,keptOriginal:true},rescheduleRecovery:{operation,retryable,confirmed}};
  }finally{
    sqlite.close();
  }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(await buildCartSupplyReviewDemo(),null,2));
}
