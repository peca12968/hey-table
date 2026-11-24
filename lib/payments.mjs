export const methods = {
  cash:"現場付款", line_pay:"LINE Pay", px_pay_plus:"全支付", jko_pay:"街口支付",
  easy_wallet:"悠遊付", pi_wallet:"Pi 拍錢包", plus_pay:"全盈+PAY", card:"信用卡"
};
export const paymentStates = {unpaid:"待付款", pending:"付款確認中", authorized:"已授權，待請款", paid:"已付款", failed:"付款失敗", cancelled:"付款已取消", partial:"部分退款", refunded:"已退款"};
export const kitchenPaymentStates = ["paid","authorized","partial"];
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
