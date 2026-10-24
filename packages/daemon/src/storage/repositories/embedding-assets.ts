import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x } from 'tar';
import { Tokenizer } from '@huggingface/tokenizers';
import superpipe, { type PipelineAPI } from 'superpipe';
import type * as Ort from 'onnxruntime-node';
import { Logger } from '../../lib/logger.ts';

const log = new Logger('EmbeddingAssets');
const RELEASE = 'https://github.com/lsm/HyperNeo/releases/download/embedding-models-v1/';
export const MODEL_CHECKSUMS: Record<string, string> = {
  'config.json': 'sha256:1a1710c20911da8c96179716bf44058e54cca6fa7952cce77be83ef05edae3ee',
  'model_q4.onnx': 'sha256:3a27c53213858379e4938858d8c72711f3792dd2c00cf1bd08cd65d23b8b36ae',
  'model_q4.onnx_data': 'sha256:ac9b1830d3204072803f706581573752f3b80bf4e08e7ff323a7091636cbeaaa',
  'special_tokens_map.json':
    'sha256:ea97ecdbcc73713039d8d64dbb05e3689495c96657fbd9a18f5bed381be81049',
  'tokenizer.json': 'sha256:feeb83348dcb033bc6b9d2e1f7906ca9eb2d122845000c9416d894d7c2927149',
  'tokenizer_config.json':
    'sha256:ce06781b38bb393db68c9e0709bddd31ef5d88f2c6fbb3fd9f369778fb85e451',
};
const RUNTIMES: Record<string, Record<string, string>> = {
  '1.22.0': {
    'onnxruntime-node':
      'sha512:QaAqr7PFekrmEsmu1rpw7OxJYyG+iACjNHoNtQIVt9Oh7st8WDPIIUe6KhF9l35HVJTJd9CV1rePoPmKhSV26g==',
    'onnxruntime-common':
      'sha512:vcuaNWgtF2dGQu/EP5P8UI5rEPEYqXG2sPPe5j9lg2TY/biJF8eWklTMwlDO08iuXq48xJo0awqIpK5mPG+IxA==',
  },
  '1.24.3': {
    'onnxruntime-node':
      'sha512:JH7+czbc8ALA819vlTgcV+Q214/+VjGeBHDjX81+ZCD0PCVCIFGFNtT0V4sXG/1JXypKPgScQcB3ij/hk3YnTg==',
    'onnxruntime-common':
      'sha512:GeuPZO6U/LBJXvwdaqHbuUmoXiEdeCjWi/EG7Y1HNnDwJYuk6WUbNXpF6luSUY8yASul3cmUlLGrCCL1ZgVXqA==',
  },
};

export class UnsupportedEmbeddingPlatform extends Error {
  readonly retryable = false;
}

export async function verifyEmbeddingAsset(file: string, checksum: string): Promise<void> {
  const [algorithm, expected] = checksum.split(':');
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest(algorithm === 'sha512' ? 'base64' : 'hex') !== expected)
    throw new Error(
      'Checksum mismatch for embedding asset ' + basename(file).replace(/\.tmp[.-].*$/, '')
    );
}

export async function fetchEmbeddingAsset(
  file: string,
  url: string,
  checksum: string
): Promise<void> {
  try {
    await verifyEmbeddingAsset(file, checksum);
    return;
  } catch {}
  await mkdir(dirname(file), { recursive: true });
  const temporary = file + '.tmp-' + crypto.randomUUID();
  log.info('Fetching embedding asset', basename(file));
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body)
      throw new Error('Embedding asset fetch failed: ' + response.status + ' ' + basename(file));
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(temporary)
    );
    await verifyEmbeddingAsset(temporary, checksum);
    await rename(temporary, file);
    log.info('Embedding asset checksum verified', basename(file));
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function embeddingRuntime(
  cacheDir: string,
  platform: string = process.platform,
  arch: string = process.arch
): Promise<typeof Ort> {
  if (
    ![
      'darwin/x64',
      'darwin/arm64',
      'linux/x64',
      'linux/arm64',
      'win32/x64',
      'win32/arm64',
    ].includes(platform + '/' + arch)
  )
    throw new UnsupportedEmbeddingPlatform(
      'Unsupported embedding platform: ' + platform + '/' + arch
    );
  const version = platform === 'darwin' && arch === 'x64' ? '1.22.0' : '1.24.3';
  const root = join(cacheDir, 'native', platform + '-' + arch, version);
  const marker = join(root, 'verified.json');
  const binding = join(
    root,
    'node_modules/onnxruntime-node/bin/napi-v6',
    platform,
    arch,
    'onnxruntime_binding.node'
  );
  const common = join(root, 'node_modules/onnxruntime-common/dist/cjs/index.js');
  const ready = await Promise.all([readFile(marker, 'utf8'), access(binding), access(common)]).then(
    ([value]) => value === JSON.stringify(RUNTIMES[version]),
    () => false
  );
  if (!ready) {
    const staging = root + '.tmp-' + crypto.randomUUID();
    try {
      for (const [name, checksum] of Object.entries(RUNTIMES[version])) {
        const archive = join(cacheDir, 'archives', name + '-' + version + '.tgz');
        await fetchEmbeddingAsset(
          archive,
          'https://registry.npmjs.org/' + name + '/-/' + name + '-' + version + '.tgz',
          checksum
        );
        const destination = join(staging, 'node_modules', name);
        await mkdir(destination, { recursive: true });
        const prefix = 'package/bin/napi-v6/' + platform + '/' + arch + '/';
        await x({
          file: archive,
          cwd: destination,
          strip: 1,
          filter: (path) =>
            name === 'onnxruntime-common' ||
            path === 'package/package.json' ||
            path.startsWith('package/dist/') ||
            path.startsWith(prefix),
        });
      }
      await writeFile(join(staging, 'verified.json'), JSON.stringify(RUNTIMES[version]));
      await rm(root, { recursive: true, force: true });
      await mkdir(dirname(root), { recursive: true });
      await rename(staging, root);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const require = createRequire(join(root, 'loader.cjs'));
  try {
    const runtime = require(
      join(root, 'node_modules/onnxruntime-node/dist/index.js')
    ) as typeof Ort;
    log.info('Embedding runtime ready', platform, arch, version);
    return runtime;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function embeddingModel(cacheDir: string, modelId: string): Promise<string> {
  const root = join(cacheDir, 'huggingface.co', modelId, 'resolve/main');
  await Promise.all(
    Object.entries(MODEL_CHECKSUMS).map(([name, checksum]) =>
      fetchEmbeddingAsset(
        join(root, name.startsWith('model_') ? 'onnx' : '', name),
        RELEASE + name,
        checksum
      )
    )
  );
  return root;
}

async function openEmbedding(runtime: typeof Ort, modelDir: string) {
  const config = JSON.parse(await readFile(join(modelDir, 'tokenizer_config.json'), 'utf8'));
  const tokenizer = new Tokenizer(
    JSON.parse(await readFile(join(modelDir, 'tokenizer.json'), 'utf8')),
    config
  );
  const session = await runtime.InferenceSession.create(join(modelDir, 'onnx/model_q4.onnx'), {
    executionProviders: ['cpu'],
  });
  return async (text: string): Promise<Float32Array> => {
    const encoded = tokenizer.encode(text);
    const ids = encoded.ids.slice(0, config.model_max_length);
    const feeds = {
      input_ids: new runtime.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
      attention_mask: new runtime.Tensor(
        'int64',
        BigInt64Array.from(encoded.attention_mask.slice(0, ids.length), BigInt),
        [1, ids.length]
      ),
    };
    const result = await session.run(feeds);
    const data = result.sentence_embedding.data;
    if (!(data instanceof Float32Array) || data.length !== 384)
      throw new Error('Embedding model returned an invalid 384-dimensional vector');
    const norm = Math.hypot(...data);
    if (!Number.isFinite(norm) || norm === 0)
      throw new Error('Embedding model returned an invalid norm');
    return Float32Array.from(data, (value) => value / norm);
  };
}

export const loadRecoveredEmbedding = (superpipe({})('embedding-recovery') as PipelineAPI)
  .input(['cacheDir', 'modelId'])
  .pipe(embeddingRuntime, 'cacheDir', 'runtime')
  .pipe(embeddingModel, ['cacheDir', 'modelId'], 'modelDir')
  .pipe(openEmbedding, ['runtime', 'modelDir'], 'result')
  .endAsync('result') as (
  cacheDir: string,
  modelId: string
) => Promise<(text: string) => Promise<Float32Array>>;
