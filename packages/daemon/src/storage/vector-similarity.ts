export interface QueryEmbedder {
  embedQuery(text: string): Float32Array | number[] | Promise<Float32Array | number[]>;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number | null {
  if (left.length !== right.length || left.length === 0) return null;
  let dot = 0;
  let leftSize = 0;
  let rightSize = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftSize += left[index] * left[index];
    rightSize += right[index] * right[index];
  }
  return leftSize === 0 || rightSize === 0 ? null : dot / Math.sqrt(leftSize * rightSize);
}

export async function embedQueryOrNull(
  embedder: QueryEmbedder,
  text: string
): Promise<Float32Array | null> {
  try {
    return Float32Array.from(await embedder.embedQuery(text));
  } catch {
    return null;
  }
}
