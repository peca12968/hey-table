const promiseWallets = {easy_wallet:"easyWallet", pi_wallet:"piWallet", plus_pay:"plusPay"};
const callbackProviders = {line_pay:"linePay", px_pay_plus:"pxPayPlus", jko_pay:"jkoPay", card:"card"};

export async function paymentPrime(sdk, method) {
  const failure = "無法取得付款授權，請確認資料後重試";
  let result;
  try {
    // In SDK 5.26 the three promise wallets use error-first callbacks internally.
    if (Object.hasOwn(promiseWallets,method)) {
      result = await sdk[promiseWallets[method]].getPrime();
    } else {
      result = await new Promise(resolve => sdk[callbackProviders[method]].getPrime(resolve));
    }
  } catch {
    throw Error(failure);
  }
  const prime = method === "card" ? result?.card?.prime : result?.prime;
  if (result?.status !== 0 || typeof prime !== "string" || !prime.trim()) throw Error(failure);
  return prime;
}

export function openPaymentUrl(sdk, method, url, location) {
  if (Object.hasOwn(promiseWallets,method)) {
    const wallet = sdk?.[promiseWallets[method]];
    if (typeof wallet?.pay === "function") return wallet.pay(url);
  }
  if (["line_pay","jko_pay"].includes(method) && typeof sdk?.redirect === "function")
    return sdk.redirect(url);
  location.assign(url);
}
