import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { rmSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function globalTeardown() {
  console.log('\n🧹 Running global teardown...');

  console.log('🧹 Layer 1: Cleaning up isolated temp directories...');

  const e2eTempBase = join(tmpdir(), 'hyperneo-e2e');

  if (existsSync(e2eTempBase)) {
    try {
      const dirs = readdirSync(e2eTempBase);
      console.log(`📊 Found ${dirs.length} e2e temp directories`);

      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      let cleaned = 0;

      for (const dir of dirs) {
        const dirPath = join(e2eTempBase, dir);
        const match = dir.match(/^e2e-(\d+)-/);
        if (match) {
          const timestamp = parseInt(match[1], 10);
          if (timestamp < oneHourAgo) {
            rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        }
      }

      console.log(`✅ Cleaned ${cleaned} stale e2e temp directories`);
    } catch (error) {
      console.warn('⚠️  Failed to clean e2e temp directories:', error);
    }
  } else {
    console.log('✅ No e2e temp directories found');
  }

  if (!process.env.CI) {
    console.log(
      '🔵 Local environment - skipping git worktree cleanup to protect production sessions\n'
    );
    return;
  }

  console.log('🧹 Layer 2: Git-level worktree cleanup...');

  try {
    const projectRoot = join(__dirname, '..', '..');
    const worktreesDir = join(projectRoot, '.worktrees');

    if (!existsSync(worktreesDir)) {
      console.log('✅ No .worktrees directory found - clean state\n');
      return;
    }

    const worktreeDirs = readdirSync(worktreesDir);
    console.log(`📊 Found ${worktreeDirs.length} worktree directories`);

    console.log('🔧 Pruning git worktree metadata...');
    try {
      const pruneOutput = execSync('git worktree prune -v', {
        cwd: projectRoot,
        encoding: 'utf-8',
      });
      if (pruneOutput) {
        console.log(`   ${pruneOutput.trim()}`);
      }
    } catch (error) {
      console.warn('   ⚠️  Prune failed (continuing):', error);
    }

    console.log('🗑️  Deleting session branches...');
    try {
      const branchesOutput = execSync('git branch --list "session/*"', {
        cwd: projectRoot,
        encoding: 'utf-8',
      });

      const branches = branchesOutput
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean);

      if (branches.length > 0) {
        console.log(`   Found ${branches.length} session branches`);

        for (const branch of branches) {
          try {
            execSync(`git branch -D ${branch}`, {
              cwd: projectRoot,
              encoding: 'utf-8',
            });
          } catch {
            console.warn(`   ⚠️  Failed to delete branch ${branch}`);
          }
        }

        console.log(`   ✅ Deleted ${branches.length} branches`);
      } else {
        console.log('   ✅ No session branches to delete');
      }
    } catch (error) {
      console.warn('   ⚠️  Branch cleanup failed (continuing):', error);
    }

    console.log('📁 Removing .worktrees directory...');
    try {
      rmSync(worktreesDir, { recursive: true, force: true });
      console.log(`   ✅ Removed ${worktreeDirs.length} worktree directories`);
    } catch (error) {
      console.error('   ❌ Failed to remove .worktrees directory:', error);
    }

    console.log('✅ Git cleanup complete\n');
  } catch (error) {
    console.error('❌ Git cleanup failed (non-fatal):', error);
  }
}

export default globalTeardown;
