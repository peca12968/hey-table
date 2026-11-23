export function downloadJson(prefix, capturedAt, value) {
  const blob = new Blob([JSON.stringify(value,null,2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = prefix + new Date(capturedAt).toISOString().replace(/:/g,"-") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
