const lineLimit=24,version="1.";
export const cartShareAddressLimit=4096;
const idPattern=/^[a-z0-9][a-z0-9-]{0,47}$/;
const validLine=({id,qty})=>typeof id==="string"&&idPattern.test(id)&&Number.isInteger(qty)&&qty>=1&&qty<=20;

export function cartShareLink(origin,items){
  if(!items.length||items.length>lineLimit||!items.every(validLine)||new Set(items.map(item=>item.id)).size!==items.length)return "";
  const encoded=version+items.map(({id,qty})=>id+":"+qty).join(",");
  return new URL("/#"+new URLSearchParams({cart:encoded}),origin).href;
}

export function readCartShare(value){
  if(typeof value!=="string"||value.length>1250||!value.startsWith(version))return null;
  const parts=value.slice(version.length).split(",");
  if(parts.length>lineLimit)return null;
  const lines=[];
  const seen=new Set();
  for(const entry of parts){
    const [id,quantity,extra]=entry.split(":");
    const qty=Number(quantity);
    if(extra!==undefined||!validLine({id,qty})||String(qty)!==quantity||seen.has(id))return null;
    seen.add(id);lines.push({id,qty});
  }
  return lines;
}

export function readCartShareHash(hash){
  if(typeof hash!=="string"||!hash.startsWith("#")||hash.length>cartShareAddressLimit)return null;
  const values=new URLSearchParams(hash.slice(1)).getAll("cart");
  return values.length===1?readCartShare(values[0]):null;
}

export function readCartShareAddress(text,origin){
  if(typeof text!=="string"||text.length>cartShareAddressLimit)return null;
  try{
    const url=new URL(text.trim());
    if(url.origin!==origin||!["http:","https:"].includes(url.protocol)||url.pathname!=="/"||url.username||url.password)
      return null;
    return readCartShareHash(url.hash);
  }catch{return null;}
}
