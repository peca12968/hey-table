const lineLimit=24,version="1.";
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
