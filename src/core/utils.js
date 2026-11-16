function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
let isRunning = false;
let shouldStop = false;
function sendLog(msg, level = "info") {
  const method =
    level === "error" ? "error" : level === "warn" ? "warn" : "log";
  console[method](`[TobyFlow] ${msg}`);
}
function sendProgress() {}
function updateGlobalProgress() {}
function completeGlobalProgress() {}
function resetGlobalProgress() {}
