import {tables} from "./menu.mjs";

export const cartKey = table => "he-ri-cart-v1:" + (table ?? "pickup");

export function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

export function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function openReceipt(scope, token) {
  save("he-ri-last", token);
  if (read(scope, {}).draft?.token === token) save(scope, {});
  location.replace("/ticket#" + token);
}

export function pendingCarts() {
  return [null, ...tables].filter(table => Boolean(read(cartKey(table), {}).draft?.token));
}
