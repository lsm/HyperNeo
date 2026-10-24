import { MODEL_ID } from '../../../src/storage/repositories/agent-memory-transformers.ts';
import { loadRecoveredEmbedding } from '../../../src/storage/repositories/embedding-assets.ts';

const embed = await loadRecoveredEmbedding(process.argv[2], MODEL_ID);
const vector = await embed('lunar geology');
console.log(JSON.stringify({ dimensions: vector.length, norm: Math.hypot(...vector) }));
