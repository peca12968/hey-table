export const methods = {
  cash:"現場付款", line_pay:"LINE Pay", px_pay_plus:"全支付", jko_pay:"街口支付",
  easy_wallet:"悠遊付", pi_wallet:"Pi 拍錢包", plus_pay:"全盈+PAY", card:"信用卡"
};
export const paymentStates = {unpaid:"待付款", pending:"付款確認中", authorized:"已授權，待請款", paid:"已付款", failed:"付款失敗", cancelled:"付款已取消", partial:"部分退款", refunded:"已退款"};
export const kitchenPaymentStates = ["paid","authorized","partial"];
export const paymentAttentionStates = ["pending","authorized"];
export const onlinePaymentEnvironments = ["demo","sandbox","production"];

const paymentCheckMessages={
  noAttempt:"這張餐單還沒有付款嘗試。",
  unavailable:"目前環境無法查詢這筆付款，請用對應的金流後台核對。",
  notQueryable:"這筆付款的狀態目前無法重新查詢，畫面保留最後一次紀錄。",
  recent:"剛發出過金流查詢，請稍候再試。",
  unconfirmed:"本次未取得可核對的金流紀錄，畫面保留最後一次紀錄。",
  changed:"查詢期間付款紀錄有更新，請核對重新載入的狀態。",
};
export function paymentCheckMessage({outcome,paymentState}){
  if(outcome!=="matched")return Object.hasOwn(paymentCheckMessages,outcome)?paymentCheckMessages[outcome]:"未收到金流查詢結果，請稍後再試。";
  const label=Object.hasOwn(paymentStates,paymentState)?paymentStates[paymentState]:"付款狀態未記錄";
  return "本次金流查詢結果為「"+label+"」。";
}

export function canPrepare(order) {
  return order.paymentMethod === "cash" || kitchenPaymentStates.includes(order.paymentState);
}
export function canCancel(order) {
  return order.paymentMethod === "cash" || ["unpaid","failed","cancelled","refunded"].includes(order.paymentState);
}
export function canCustomerCancel(order) {
  return order.status==="pending" &&
    (order.paymentMethod==="cash" || ["unpaid","failed","cancelled"].includes(order.paymentState));
}
export function environmentLabel(mode) {
  return ({demo:"示範模式・不扣款",sandbox:"TapPay 測試環境",production:"正式付款"})[mode] ?? "";
}
