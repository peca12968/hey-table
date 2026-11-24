import {downloadFile} from "./download-file.mjs";

export function downloadJson(prefix, capturedAt, value) {
  const blob = new Blob([JSON.stringify(value,null,2)], {type:"application/json"});
  downloadFile(blob,prefix + new Date(capturedAt).toISOString().replace(/:/g,"-") + ".json");
}
