// Synthetic but structurally realistic brain: departments -> routers -> files.
// Shape matters more than content — builders tune layout/render against THIS.
import { writeFileSync } from 'node:fs';
const DEPTS = ['BUSINESS','CONTENT','CLIENTS','ENGINEERING','PERSONAL','COMMUNITY'];
const N = 60000;
let seed = 1337; const rnd = () => (seed = (seed*1664525+1013904223)>>>0) / 4294967296;

const nodes = [], links = [];
// 0 = CLAUDE.md root
nodes.push({ id:0, name:'CLAUDE.md', kind:'root', dept:-1, size:35000 });
const deptRoot = [];
DEPTS.forEach((d,i) => { const id = nodes.length; deptRoot.push(id);
  nodes.push({ id, name:`${d}.md`, kind:'router', dept:i, size:8000+rnd()*30000 });
  links.push([0,id,'spoke']); });

// routers per dept, then files under routers — power-law-ish fan-out
for (let i=0;i<DEPTS.length;i++){
  const nRouters = 8 + Math.floor(rnd()*14);
  const routers=[];
  for (let r=0;r<nRouters;r++){ const id=nodes.length;
    nodes.push({id,name:`${DEPTS[i].toLowerCase()}/router-${r}.md`,kind:'router',dept:i,size:2000+rnd()*12000});
    links.push([deptRoot[i],id,'link']); routers.push(id); }
  routers.forEach(rt => { const fan = 20 + Math.floor(Math.pow(rnd(),2)*900);
    for (let f=0; f<fan && nodes.length<N; f++){ const id=nodes.length;
      const ext = ['md','md','md','ts','png','pdf','json'][Math.floor(rnd()*7)];
      nodes.push({id,name:`${DEPTS[i].toLowerCase()}/f${rt}-${f}.${ext}`,kind:'file',dept:i,size:Math.floor(rnd()*80000)});
      links.push([rt,id,'link']);
      if (rnd()<0.06) links.push([id, routers[Math.floor(rnd()*routers.length)], 'xref']); } }); }
while (nodes.length<N){ const id=nodes.length, d=Math.floor(rnd()*DEPTS.length);
  nodes.push({id,name:`orphan/${id}.md`,kind:'file',dept:d,size:Math.floor(rnd()*4000)});
  links.push([deptRoot[d],id,'link']); }
// cross-department references — the interesting edges
for (let i=0;i<4000;i++){ const a=Math.floor(rnd()*nodes.length), b=Math.floor(rnd()*nodes.length);
  if (nodes[a].dept!==nodes[b].dept) links.push([a,b,'xref']); }

writeFileSync(new URL('../public/brain.json',import.meta.url),
  JSON.stringify({ depts:DEPTS, nodes, links }));
console.log(`nodes=${nodes.length} links=${links.length} depts=${DEPTS.length}`);
