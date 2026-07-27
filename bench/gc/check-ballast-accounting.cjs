const path=require('path');
const {chromium}=require(path.join(process.cwd(),'node_modules','playwright'));
const {Cdp}=require(path.join(process.cwd(),'bench','gc','cdp.cjs'));
(async()=>{
  const ctx=await chromium.launchPersistentContext(path.join(process.env.TEMP,'ca-gc-check'),{
    headless:true,serviceWorkers:'block',args:['--remote-debugging-port=9455','--disable-dev-shm-usage']});
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto('http://localhost:8899/bench/blank.html',{waitUntil:'load'}).catch(async()=>{await page.goto('http://localhost:8899/',{waitUntil:'domcontentloaded'});});
  const cdp=await Cdp.connect(9455);
  const t=await cdp.attach(x=>x.type==='page');
  await cdp.send('HeapProfiler.enable',{},t.sessionId);
  const gc=async()=>{await cdp.send('HeapProfiler.collectGarbage',{},t.sessionId);await cdp.send('HeapProfiler.collectGarbage',{},t.sessionId);};
  const use=async()=>(await cdp.send('Runtime.getHeapUsage',{},t.sessionId));
  await gc(); console.log('before',JSON.stringify(await use()));
  const r=await page.evaluate((mb)=>{
    const chunk=1<<20; const n=Math.round(mb/2); const arr=[];
    for(let i=0;i<n;i++){let s=String.fromCharCode(0x4e00+i).repeat(chunk)+i;arr.push(s.slice(0));}
    window.__gcBallast=arr; window.__gcBallastMB=n*2;
    return {n, len:arr[0].length, sample:arr[0].charCodeAt(0), total:arr.reduce((a,s)=>a+s.length,0)};
  },120);
  console.log('alloc',JSON.stringify(r));
  await gc(); console.log('after ',JSON.stringify(await use()));
  const held=await page.evaluate(()=>({has:!!window.__gcBallast,len:window.__gcBallast&&window.__gcBallast.length}));
  console.log('held',JSON.stringify(held));
  cdp.close(); await ctx.close();
})().catch(e=>{console.error(e);process.exit(1);});
