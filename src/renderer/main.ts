// AeroShell Renderer bootstrap (M0)
console.log('[renderer] AeroShell renderer initialized.');

const gpuEl = document.getElementById('gpu');
if (gpuEl) {
  gpuEl.textContent = 'GPU: Initializing...';
}

const memEl = document.getElementById('mem');
if (memEl) {
  memEl.textContent = 'Memory: Monitoring...';
}
