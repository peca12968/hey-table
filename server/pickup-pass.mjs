import {payableForKitchen} from "./payment-api.mjs";

const lifetime=30*60_000;
const eligible=`orders.mode='pickup' AND orders.status='ready' AND ${payableForKitchen}`;
const passScope=`FROM pickup_passes AS pass JOIN orders ON orders.id=pass.order_id
  WHERE pass.token_hash=? AND pass.expires_at>?`;
const activePass=`${passScope} AND ${eligible}`;
const staffProof=`pass.order_id=orders.id AND pass.token_hash=? AND pass.revision=? AND pass.expires_at>?`;
const completedWithPass=`orders.mode='pickup' AND orders.status='completed'
  AND json_extract(orders.status_history,'$[#-1].pickupPassRevision')=pass.revision`;
const completionAt="json_extract(orders.status_history,'$[#-1].at')";
const encoder=new TextEncoder();
async function hashPass(token){
  const digest=await crypto.subtle.digest("SHA-256",encoder.encode(token.toLowerCase()));
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,"0")).join("");
}

const receiptPass=(db,token)=>db.prepare(`SELECT pass.revision,pass.token_hash,pass.expires_at,(${eligible}) AS eligible
  FROM orders LEFT JOIN pickup_passes AS pass ON pass.order_id=orders.id WHERE orders.token=?`).bind(token);
function passState(row,now){
  const active=Boolean(row.eligible&&row.token_hash&&row.expires_at>now);
  return {revision:row.revision??0,active,expiresAt:active?row.expires_at:null};
}

export async function ownerPickupPass(db,token,now){
  const row=await receiptPass(db,token).first();
  return row?passState(row,now):null;
}

export async function issuePickupPass(db,token,pass,revision,now){
  const digest=await hashPass(pass);
  const [,lookup]=await db.batch([
    db.prepare(`INSERT INTO pickup_passes(order_id,token_hash,expires_at,revision)
      SELECT orders.id,?,?,? FROM orders WHERE orders.token=? AND ${eligible}
      AND COALESCE((SELECT revision FROM pickup_passes WHERE order_id=orders.id),0)=?
      AND NOT EXISTS (SELECT 1 FROM pickup_passes WHERE token_hash=?)
      ON CONFLICT(order_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,revision=excluded.revision`)
      .bind(digest,now+lifetime,revision+1,token,revision,digest),
    receiptPass(db,token),
  ]);
  const row=lookup.results[0];
  if(!row)return null;
  const state=passState(row,now);
  return state.active&&state.revision===revision+1&&row.token_hash===digest?state:false;
}

export async function revokePickupPass(db,token,revision,now){
  const [,lookup]=await db.batch([
    db.prepare(`UPDATE pickup_passes SET token_hash=NULL,expires_at=NULL,revision=revision+1
      WHERE order_id=(SELECT id FROM orders WHERE token=?) AND revision=? AND token_hash IS NOT NULL`).bind(token,revision),
    receiptPass(db,token),
  ]);
  const row=lookup.results[0];
  if(!row)return null;
  return row.revision===revision+1&&row.token_hash===null?passState(row,now):false;
}

export async function readPickupPass(db,token,now,includeHandoff=false){
  const handoff=includeHandoff?
    `,pass.revision,orders.status AS handoffStatus,CASE WHEN orders.status='completed' THEN ${completionAt} END AS completedAt`:"";
  const scope=includeHandoff?`${passScope} AND ((${eligible}) OR (${completedWithPass}))`:activePass;
  const row=await db.prepare(`SELECT orders.id,orders.pickup_slot AS pickupSlot,pass.expires_at AS expiresAt,
    orders.pickup_arrived_at AS pickupArrivedAt${handoff} ${scope}`).bind(await hashPass(token),now).first();
  if(!row||!includeHandoff)return row;
  const {handoffStatus,completedAt,...active}=row;
  if(handoffStatus!=="completed")return active;
  return Number.isSafeInteger(completedAt)?{id:row.id,status:"completed",completedAt,expiresAt:row.expiresAt}:null;
}

export async function reportPickupPassArrival(db,token,now){
  const digest=await hashPass(token);
  const [,lookup]=await db.batch([
    db.prepare(`UPDATE orders SET pickup_arrived_at=? WHERE pickup_arrived_at IS NULL
      AND id=(SELECT orders.id ${activePass})`).bind(now,digest,now),
    db.prepare(`SELECT orders.id,orders.pickup_arrived_at AS pickupArrivedAt ${activePass}`).bind(digest,now),
  ]);
  return lookup.results[0]??null;
}

export async function readStaffPickupPass(db,selectOrders,id,token,revision,now){
  return db.prepare(`${selectOrders} WHERE orders.id=? AND EXISTS (
    SELECT 1 FROM pickup_passes AS pass WHERE ${staffProof} AND ((${eligible}) OR (${completedWithPass})))`)
    .bind(id,await hashPass(token),revision,now).first();
}

export async function completeStaffPickupPass(db,id,token,revision,now){
  const digest=await hashPass(token);
  const [,receipt]=await db.batch([
    db.prepare(`UPDATE orders SET status='completed',
      status_history=json_insert(COALESCE(status_history,'[]'),'$[#]',
        json_object('from','ready','status','completed','at',?,'pickupPassRevision',?))
      WHERE orders.id=? AND ${eligible} AND EXISTS (SELECT 1 FROM pickup_passes AS pass WHERE ${staffProof})`)
      .bind(now,revision,id,digest,revision,now),
    db.prepare(`SELECT ${completionAt} AS completedAt
      FROM orders WHERE orders.id=? AND EXISTS (
        SELECT 1 FROM pickup_passes AS pass WHERE ${staffProof} AND ${completedWithPass})`).bind(id,digest,revision,now),
  ]);
  return receipt.results[0]??null;
}
