/** Identify a size-prefixed zlib stream by its RFC 1950 header. */
export function hasFr3Wrapper(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const cmf = bytes[4]!;
  const flg = bytes[5]!;
  return (cmf & 0x0f) === 8 && (cmf >>> 4) <= 7 && ((cmf << 8) | flg) % 31 === 0;
}

/** Inflate a complete stream, checking the size before retaining each output chunk. */
export async function inflate(
  bytes: Uint8Array,
  format: "deflate" | "deflate-raw",
  expectedSize: number,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      // Copy into an ordinary ArrayBuffer, including when the input is a Buffer
      // subview or backed by SharedArrayBuffer.
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream(format)).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > expectedSize) {
        await reader.cancel();
        throw new Error(`Inflated data exceeds declared size ${expectedSize}`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (size !== expectedSize) {
    throw new Error(`Inflated size ${size} does not match declared size ${expectedSize}`);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export async function unpackFr3Resource(bytes: Uint8Array): Promise<Uint8Array> {
  if (!hasFr3Wrapper(bytes)) return bytes;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  return inflate(bytes.subarray(4), "deflate", size);
}
