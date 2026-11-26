import {expirePaymentHolds} from "./payment-holds.mjs";

export const currentOrderNote = "COALESCE(json_extract(note_update,'$.note'),note)";
export const orderNoteRevision = "COALESCE(json_extract(note_update,'$.revision'),0)";

export function orderNote(row) {
  if (!row.note_update) return {note:row.note};
  const {note,revision,updatedAt}=JSON.parse(row.note_update);
  return {note,noteRevision:revision,noteUpdatedAt:updatedAt};
}

export async function updateOrderNote(db,token,note,expectedRevision,now) {
  const change=JSON.stringify({note,revision:expectedRevision+1,updatedAt:now});
  const [,,lookup]=await db.batch([
    expirePaymentHolds(db,now,token),
    db.prepare(`UPDATE orders SET note_update=?
      WHERE token=? AND status='pending' AND ${orderNoteRevision}=? AND ${currentOrderNote}<>?`)
      .bind(change,token,expectedRevision,note),
    db.prepare("SELECT id,status,note,note_update FROM orders WHERE token=?").bind(token),
  ]);
  const row=lookup.results[0];
  if (!row) return {state:"missing"};
  const saved=orderNote(row),revision=saved.noteRevision??0;
  if (saved.note===note && (revision===expectedRevision+1 || revision===expectedRevision&&row.status==="pending"))
    return {state:"saved",receipt:{id:row.id,...saved,noteRevision:revision}};
  return {state:row.status==="pending"?"conflict":"closed"};
}
