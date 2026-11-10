from pathlib import Path
import subprocess,os,tempfile
paths=['packages/web/src/neo/NeoComposer.tsx','packages/web/src/neo/NeoPreferences.tsx','packages/web/src/neo/neo.css','packages/web/src/styles.css','packages/web/src/neo/neo-composer.css']
baseline=os.environ.get('VERIFY_COMPOSER_BASE','origin/dev')
subprocess.run(['git','rev-parse','--verify',baseline+'^{commit}'],check=True)
backup={p:Path(p).read_bytes() for p in paths}
root=Path(tempfile.mkdtemp(prefix='composer-source-backup-'))
for i,p in enumerate(paths): (root/str(i)).write_bytes(backup[p])
print('Preserved source bytes:',root,flush=True)
try:
 for p in paths: Path(p).write_bytes(subprocess.check_output(['git','show',baseline+':'+p]))
 subprocess.run(['bun','run','--cwd','packages/web','build'],check=True,stdout=subprocess.DEVNULL)
 env=dict(os.environ,VERIFY_COMPOSER_PHASE='before',VERIFY_KEEP_RUN='1')
 subprocess.run(['bash','.claude/skills/verify/with-run.sh','bash','.claude/skills/verify/composer-frame.sh','19346'],env=env,check=True)
finally:
 for p in paths: Path(p).write_bytes(backup[p])
 print('Restored all current source files byte-for-byte',flush=True)
