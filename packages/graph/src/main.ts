/**
 * BASELINE renderer — deliberately plain. This is round-0 champion seed.
 * Gauntlet builders replace/extend this. They MUST preserve the capture contract below.
 *
 * CAPTURE CONTRACT (harness depends on it — breaking it makes artifacts unjudgeable):
 *   window.__BRAIN_READY : boolean          set true once first frame is drawn
 *   window.__brainCamera(t: number)         deterministic camera path, t in [0,1]
 *   window.__brainStats()  : { fps, nodes, links, drawCalls, tris }
 */
import * as THREE from 'three'

type Brain = { depts: string[]; nodes: {id:number;name:string;kind:string;dept:number;size:number}[]; links: [number,number,string][] }

const DEPT_COLORS = [0x4f9dff,0xff6b4f,0xc07bff,0x4fffc0,0xffc94f,0xff4f9d]

const app = document.getElementById('app')!
const renderer = new THREE.WebGLRenderer({ antialias:false, powerPreference:'high-performance' })
renderer.setPixelRatio(Math.min(devicePixelRatio,2))
renderer.setSize(innerWidth, innerHeight)
app.appendChild(renderer.domElement)

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x07070b)
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 8000)

const brain: Brain = await (await fetch('/brain.json')).json()
const N = brain.nodes.length

// --- deterministic rings layout (no physics). Builders may replace with GPU force sim. ---
const pos = new Float32Array(N*3)
const col = new Float32Array(N*3)
const siz = new Float32Array(N)
const c = new THREE.Color()
let s2 = 99991; const rnd2 = () => (s2 = (s2*1103515245+12345)>>>0) / 4294967296
const perDept: number[] = new Array(brain.depts.length).fill(0)
brain.nodes.forEach(n => { if (n.dept>=0) perDept[n.dept]++ })
const cursor = new Array(brain.depts.length).fill(0)
brain.nodes.forEach((n,i) => {
  if (n.kind==='root'){ pos[i*3]=0; pos[i*3+1]=0; pos[i*3+2]=0 }
  else {
    const d = Math.max(0,n.dept)
    const k = cursor[d]++, total = perDept[d]||1
    // spherical-shell per department: real volume, so the structure reads in 3D
    const golden = k*2.399963
    const f = k/total
    const rr = (n.kind==='router' ? 180 : 260 + Math.cbrt(f)*430)
    const dc = (d/brain.depts.length)*Math.PI*2
    const lat = Math.acos(1 - 2*((f*0.82)+0.09))          // even shell distribution
    const lon = dc + golden*0.42
    const jit = n.kind==='file' ? (rnd2()-0.5)*90 : 0
    pos[i*3]   = Math.sin(lat)*Math.cos(lon)*rr + jit
    pos[i*3+1] = Math.cos(lat)*rr*0.72 + jit*0.5
    pos[i*3+2] = Math.sin(lat)*Math.sin(lon)*rr + jit
  }
  c.setHex(n.dept>=0?DEPT_COLORS[n.dept]:0xffffff)
  col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b
  siz[i] = n.kind==='root'?26:n.kind==='router'?9:2.4
})

const g = new THREE.BufferGeometry()
g.setAttribute('position', new THREE.BufferAttribute(pos,3))
g.setAttribute('color', new THREE.BufferAttribute(col,3))
g.setAttribute('aSize', new THREE.BufferAttribute(siz,1))
const nodeMat = new THREE.ShaderMaterial({
  transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
  vertexShader:`attribute float aSize; varying vec3 vC;
    void main(){ vC=color; vec4 mv=modelViewMatrix*vec4(position,1.0);
      gl_PointSize=aSize*(300.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
  fragmentShader:`varying vec3 vC;
    void main(){ float d=length(gl_PointCoord-0.5); if(d>0.5) discard;
      float a=smoothstep(0.5,0.0,d); gl_FragColor=vec4(vC,a); }`,
  vertexColors:true
})
scene.add(new THREE.Points(g,nodeMat))

// edges — plain, one batched draw
const L = brain.links.length
const lp = new Float32Array(L*6)
brain.links.forEach(([a,b],i)=>{ for(let k=0;k<3;k++){ lp[i*6+k]=pos[a*3+k]; lp[i*6+3+k]=pos[b*3+k] } })
const lg = new THREE.BufferGeometry(); lg.setAttribute('position', new THREE.BufferAttribute(lp,3))
scene.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color:0x5570b0, transparent:true, opacity:0.055, blending:THREE.NormalBlending, depthWrite:false })))

// --- capture contract ---
function camAt(t:number){
  const a = t*Math.PI*2, r = 1750 - Math.sin(t*Math.PI)*620
  camera.position.set(Math.cos(a)*r, 620 + Math.sin(t*Math.PI*2)*300, Math.sin(a)*r)
  camera.lookAt(0,0,0)
}
camAt(0)
let frames=0, last=performance.now(), fps=0
;(globalThis as any).__brainCamera = (t:number)=>{ camAt(t); renderer.render(scene,camera) }
;(globalThis as any).__brainStats = ()=>({ fps, nodes:N, links:L,
  drawCalls:renderer.info.render.calls, tris:renderer.info.render.triangles })
addEventListener('resize',()=>{ camera.aspect=innerWidth/innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth,innerHeight) })

let auto = true, rafId = 0, paused = false
;(globalThis as any).__brainAuto = (v:boolean)=>{ auto=v }
// Pause the rAF loop entirely so headless screenshots can reach a stable page.
;(globalThis as any).__brainPause = ()=>{ paused=true; if(rafId) cancelAnimationFrame(rafId); rafId=0 }
;(globalThis as any).__brainResume = ()=>{ if(paused){ paused=false; loop() } }
let t0 = performance.now()
function loop(){
  if (paused) return
  rafId = requestAnimationFrame(loop)
  if (auto) camAt(((performance.now()-t0)/24000)%1)
  renderer.render(scene,camera)
  frames++; const now=performance.now()
  if (now-last>=500){ fps=Math.round(frames*1000/(now-last)); frames=0; last=now
    ;(globalThis as any).__BRAIN_READY = true }
}
loop()
