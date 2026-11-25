export function cashAmount(value,signed=false){
  const pattern=signed?/^-?\d+$/:/^\d+$/;
  return typeof value==="string"&&pattern.test(value)?BigInt(value):null;
}

export function reconcileCash(net,opening,adjustments,counted){
  const expected=opening+BigInt(net)+adjustments;
  return {opening:String(opening),adjustments:String(adjustments),expected:String(expected),
    counted:String(counted),difference:String(counted-expected)};
}
