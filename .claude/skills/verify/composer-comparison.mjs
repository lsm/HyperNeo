import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const [mockPath,before,after,output]=process.argv.slice(2).map(path=>resolve(path));
const {chromium}=createRequire(import.meta.url)(process.env.VERIFY_PLAYWRIGHT || 'playwright');
const browser=await chromium.launch({headless:true,executablePath:process.env.VERIFY_BROWSER});
const mockDir=join(dirname(output),'pr1-mock-reference');mkdirSync(mockDir,{recursive:true});
const states=[['pending','Model switch pending','pending-focus'],['stop','Turn running, nothing drafted (session pane)','running'],['recording','Recording, started from the collapsed pill','collapsed-recording']];
const cards=[],metrics=[];
const embedded=file=>`data:image/png;base64,${readFileSync(file).toString('base64')}`;
try{
 const page=await browser.newPage({viewport:{width:1280,height:900}});await page.goto(`file://${mockPath}`);
 for(const [key,title,suffix]of states)for(const theme of ['light','dark'])for(const width of [390,1280]){
  const section=page.locator('section.state').filter({has:page.getByRole('heading',{name:title,exact:true})});
  const frameElement=await section.locator(`iframe[title="After ${theme} ${width===390?'390':'desk'}"]`).elementHandle();
  await frameElement.scrollIntoViewIfNeeded();
  const frame=await browser.newPage({viewport:{width:width===390?390:760,height:300}});
  await frame.setContent(await frameElement.getAttribute('srcdoc'));
  await frame.locator('form').waitFor();
  const file=join(mockDir,`${key}-${theme}-${width}.png`);await frame.screenshot({path:file,fullPage:true});
  if(key==='pending')metrics.push({theme,width,pill:await frame.getByRole('button',{name:'Model and thinking',exact:true}).evaluate(el=>({height:el.getBoundingClientRect().height,column:getComputedStyle(el.children[1]).display,lineHeight:getComputedStyle(el.children[1]).lineHeight}))});
  await frame.close();
  cards.push(`<section><h2>${title} · ${theme} · ${width}px</h2><div class="grid">${[['Approved mock',file],['Before review',join(before,`review-${theme}-${width}-${suffix}.png`)],['After correction',join(after,`review-${theme}-${width}-${suffix}.png`)]].map(([label,path])=>`<figure><figcaption>${label}</figcaption><img alt="${label}: ${title}, ${theme}, ${width}px" src="${embedded(path)}"></figure>`).join('')}</div></section>`);
 }
}finally{await browser.close();}
writeFileSync(join(mockDir,'metrics.json'),JSON.stringify(metrics,null,2));
const actual=JSON.parse(readFileSync(join(after,'review-findings.json'),'utf8'));
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
writeFileSync(output,`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Composer PR 1 review comparison</title><style>body{font:15px system-ui;margin:20px;background:#f4f4f4;color:#222}section{margin:24px 0;border-top:1px solid #aaa}h2{font-size:18px}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}figure{margin:0;background:white;padding:8px}figcaption{font-weight:600;margin-bottom:8px}img{width:100%;height:auto;display:block}@media(max-width:800px){.grid{grid-template-columns:1fr}}</style><h1>Composer PR 1 · review corrections</h1><p>Source head: <code>${head}</code></p><p>Pending pill: mock ${metrics[0].pill.height}px / after ${actual.cases[0].pill.height}px. Stop: ${actual.cases[0].stop.faceWidth}×${actual.cases[0].stop.faceHeight}, radius ${actual.cases[0].stop.radius}, target ${actual.cases[0].stop.width}×${actual.cases[0].stop.height}, glyph ${actual.cases[0].stop.glyph}px. Pending text: ${actual.cases[0].pill.noticeSize}. Collapsed recording: ${actual.cases[0].padding.top} / ${actual.cases[0].padding.bottom} top/bottom. Keyboard button outline: ${actual.cases[0].outline.style}; face ring remains.</p><p>All images are embedded data URIs; no separate image files or network are needed.</p><p>Compare the pending pill column/height, single keyboard-focus treatment, flat Stop face, and collapsed recording padding. Stop/send slot logic, one-row layout, minimum text rows and dictation UI remain later slices; the mock includes those future changes.</p><p>Actual screenshots include the surrounding page so frame shadows remain visible. Desktop mock uses its approved 760px rail; actual browser viewport is 1280px. Pending/Stop use real-component synthetic state fixtures; recording uses the real /neo UI and fake media.</p>${cards.join('')}</html>`);
console.log(JSON.stringify({output,cards:cards.length,images:cards.length*3,mockMetrics:metrics}));
