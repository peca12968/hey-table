import {downloadFile} from "./download-file.mjs";

export function downloadCsv(rows,name){
  const csv=rows.map(row=>row.map(value=>{
    if(typeof value==="number")return String(value);
    const text=String(value);
    const escaped=/^\s*[=+@-]|^[\t\r\n]/.test(text)?"'"+text:text;
    return '"'+escaped.replaceAll('"','""')+'"';
  }).join(",")).join("\r\n")+"\r\n";
  downloadFile(new Blob(["\uFEFF",csv],{type:"text/csv;charset=utf-8"}),name);
}
