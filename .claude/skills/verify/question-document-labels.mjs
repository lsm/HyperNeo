import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const [port, directory] = process.argv.slice(2);
assert(port && directory, 'usage: question-document-labels.mjs <port> <run-dir>');
assert.notEqual(port, '8399');
const run = resolve(directory);
const log = readFileSync(`${run}/daemon.log`, 'utf8');
assert(log.includes('HyperNeo Test Server') && log.includes(`Database: ${run}/data/daemon.db`));
const opened = JSON.parse(execFileSync('bun', ['.claude/skills/verify/rpc.ts', 'neo.open', '{}'], {
  env: { ...process.env, VERIFY_PORT: port }, encoding: 'utf8',
})).reply;
assert(opened.ok);
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const fixtures = [false, true].map(home => ({ home, ask: crypto.randomUUID() }));
const now = Date.now();
const document = 'Full literal content\n<script>window.documentInjected=true</script>\nEnd of report';
const confirm = JSON.stringify({path:'direction.md',sha256:'a'.repeat(64)});
let sql = '';
for (const { home, ask } of fixtures) {
  sql += `INSERT INTO neo_asks(id,session_id,title,request,status,created_at,updated_at) VALUES(${quote(ask)},${quote(opened.sessionId)},${quote(home?'Home proposal':'Ordinary report')},'Synthetic verification only','open',${now},${now});`;
  for (const state of ['open','answered','retired']) {
    sql += `INSERT INTO neo_questions(id,ask_id,text,kind,state,answer,answered_by,answered_at,retired_reason,created_at,document,confirm_json) VALUES(${quote(crypto.randomUUID())},${quote(ask)},${quote(home?'direction.md '+ 'a'.repeat(64):'Ordinary question with a document')},'yesno',${quote(state)},${state==='answered'?quote('"yes"'):'NULL'},${state==='answered'?"'button'":'NULL'},${state==='answered'?now:'NULL'},${state==='retired'?"'Synthetic retirement'":'NULL'},${now},${quote(document)},${home?quote(confirm):'NULL'});`;
  }
}
execFileSync('sqlite3', [`${run}/data/daemon.db`, sql]);
const { chromium } = createRequire(import.meta.url)('playwright');
const browser = await chromium.launch({headless:true,...(process.env.VERIFY_BROWSER?{executablePath:process.env.VERIFY_BROWSER}:{})});
const results = [];
try {
  for (const language of ['en','zh-CN']) {
    const page = await browser.newPage({viewport:{width:1280,height:1000},locale:language});
    try {
      await page.goto(`http://127.0.0.1:${port}/neo`);
      for (const {home,ask} of fixtures) {
        const card=page.locator(`[data-ask="${ask}"]:visible`);
        await card.waitFor();
        await card.getByText(home?'direction.md '+ 'a'.repeat(64):'Ordinary question with a document',{exact:true}).first().waitFor();
        const label=language==='en'?(home?'View full versions':'View full report'):(home?'查看完整版本':'查看完整内容');
        const wrong=language==='en'?(home?'View full report':'View full versions'):(home?'查看完整内容':'查看完整版本');
        assert.equal(await card.getByRole('button',{name:wrong,exact:true}).count(),0);
        for (const [index,state] of ['open','answered','retired'].entries()) {
          if(index===1) await card.locator('[data-ask-details-toggle]').click();
          const scope=index===0?card:page.getByRole('dialog').first();
          await scope.getByRole('button',{name:label,exact:true}).nth(index===0?0:index-1).click();
          const dialog=page.getByRole('dialog').last();
          assert.equal(await dialog.locator('pre').innerText(),document);
          assert((await dialog.innerText()).includes(label));
          assert.equal(await dialog.locator('script').count(),0);
          const screenshot=`question-document-${language}-${home?'home':'report'}-${state}.png`;
          await page.screenshot({path:`${run}/evidence/${screenshot}`,fullPage:true,animations:'disabled'});
          results.push({language,home,state,label,literalContent:true,screenshot});
          await dialog.getByRole('button',{name:/close|关闭/i}).click();
        }
        await page.getByRole('dialog').first().getByRole('button',{name:/close|关闭/i}).click();
      }
      assert.equal(await page.evaluate(()=>window.documentInjected),undefined);
    } catch(error) { await page.screenshot({path:`${run}/evidence/question-document-${language}-failure.png`,fullPage:true,animations:'disabled'}); throw error; } finally { await page.close(); }
  }
  writeFileSync(`${run}/evidence/question-document-labels.json`,JSON.stringify({passed:true,results},null,2));
} catch(error) { writeFileSync(`${run}/evidence/question-document-labels.json`,JSON.stringify({passed:false,error:String(error),results},null,2));throw error; } finally { await browser.close(); }
