import { describe, expect, test } from 'bun:test';
import { cosineSimilarity, embedQueryOrNull } from '../../../../src/storage/vector-similarity';

const v = (...values: number[]) => Float32Array.from(values);

describe('cosineSimilarity', () => {
  test.each([
    ['identical vectors', v(1, 2), v(1, 2), 1],
    ['orthogonal vectors', v(1, 0), v(0, 1), 0],
    ['opposite vectors', v(1, 0), v(-1, 0), -1],
    ['mismatched lengths', v(1), v(1, 0), null],
    ['empty vectors', v(), v(), null],
    ['a zero vector', v(0, 0), v(1, 0), null],
  ])('%s', (_label, left, right, expected) => {
    const similarity = cosineSimilarity(left, right);
    if (expected === null) expect(similarity).toBeNull();
    else expect(similarity).toBeCloseTo(expected);
  });
});

describe('embedQueryOrNull', () => {
  test('returns a Float32Array, or null when the embedder fails', async () => {
    expect(await embedQueryOrNull({ embedQuery: () => [0.5, 1] }, 'q')).toEqual(v(0.5, 1));
    expect(
      await embedQueryOrNull(
        {
          embedQuery: () => {
            throw new Error('offline');
          },
        },
        'q'
      )
    ).toBeNull();
    expect(
      await embedQueryOrNull({ embedQuery: () => Promise.reject(new Error('offline')) }, 'q')
    ).toBeNull();
  });
});
