// Off-thread binary parser worker operating under COEP require-corp
self.onmessage = (e: MessageEvent<{ buffer: ArrayBuffer }>) => {
  const { buffer } = e.data;
  if (!buffer) return;

  const byteLength = buffer.byteLength;
  const view = new Uint8Array(buffer);
  let checksum = 0;
  const sampleSize = Math.min(byteLength, 128);
  for (let i = 0; i < sampleSize; i++) {
    checksum = (checksum + (view[i] ?? 0)) & 0xff;
  }

  // Transfer ArrayBuffer back to main thread
  (self as unknown as Worker).postMessage(
    { status: 'PARSED', byteLength, checksum },
    { transfer: [buffer] }
  );
};
