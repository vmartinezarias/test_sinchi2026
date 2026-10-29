/* Motor espacial: malla original EPSG:9377, Float32 sin cuantizar. Compartido por worker y QA. */
(function(root){
'use strict';
function passes(v,lo,hi){return Number.isFinite(v)&&v>=lo&&v<=hi;}
function components(mask,W,H,minHa,cellHa=.09){
 const n=W*H,labels=new Uint32Array(n),q=new Uint32Array(n),sizes=[0];let id=0;
 for(let i=0;i<n;i++)if(mask[i]&&!labels[i]){
  id++;let a=0,b=1;q[0]=i;labels[i]=id;
  while(a<b){const k=q[a++],x=k%W,y=(k/W)|0;
   for(let dy=-1;dy<=1;dy++){const yy=y+dy;if(yy<0||yy>=H)continue;
    for(let dx=-1;dx<=1;dx++){const xx=x+dx;if((!dx&&!dy)||xx<0||xx>=W)continue;const j=yy*W+xx;if(mask[j]&&!labels[j]){labels[j]=id;q[b++]=j;}}
   }
  }sizes.push(b);
 }
 const kept=sizes.map((n,i)=>({n,i})).filter(o=>o.i&&o.n*cellHa+1e-9>=minHa).sort((a,b)=>b.n-a.n||a.i-b.i),remap=new Uint32Array(sizes.length);
 kept.forEach((o,j)=>remap[o.i]=j+1);for(let i=0;i<n;i++)labels[i]=remap[labels[i]];
 return {labels,sizes:[0,...kept.map(o=>o.n)]};
}
function ringArea(r){let a=0;for(let i=0;i<r.length-1;i++)a+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1];return a/2;}
function inside(p,r){let c=false;for(let i=0,j=r.length-1;i<r.length;j=i++){const a=r[i],b=r[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])c=!c;}return c;}
function polygonize(labels,W,H){
 const groups=new Map(),stride=W+1;
 function edge(id,x,y,d){let m=groups.get(id);if(!m)groups.set(id,m=new Map());const k=y*stride+x;let v=m.get(k);if(!v)m.set(k,v=[]);v.push(d);}
 for(let y=0,k=0;y<H;y++)for(let x=0;x<W;x++,k++){
  const id=labels[k];if(!id)continue;
  if(y===0||labels[k-W]!==id)edge(id,x,y,0);
  if(x===W-1||labels[k+1]!==id)edge(id,x+1,y,1);
  if(y===H-1||labels[k+W]!==id)edge(id,x+1,y+1,2);
  if(x===0||labels[k-1]!==id)edge(id,x,y+1,3);
 }
 const polygons=new Map(),deltas=[1,stride,-1,-stride];
 for(const [id,m] of groups){
  const rings=[];
  while(m.size){const start=m.keys().next().value;let k=start,prev=null;const points=[];let guard=0;
   do{
    points.push([k%stride,Math.floor(k/stride)]);const opts=m.get(k);if(!opts?.length)throw Error('Borde abierto al vectorizar');
    let idx=0;if(prev!==null&&opts.length>1){const order=[(prev+1)%4,prev,(prev+3)%4,(prev+2)%4];idx=opts.reduce((best,d,j)=>order.indexOf(d)<order.indexOf(opts[best])?j:best,0);}
    const d=opts.splice(idx,1)[0];if(!opts.length)m.delete(k);k+=deltas[d];prev=d;
    if(++guard>W*H*4)throw Error('Borde no cerrado');
   }while(k!==start);
   // Split self-touching circuits at repeated vertices into simple rings.
   const stack=[],positions=new Map();
   for(const point of points.concat([points[0]])){
    const key=point[1]*stride+point[0];
    if(positions.has(key)){
     const index=positions.get(key),cycle=stack.slice(index);
     if(cycle.length>=4){const simple=cycle.filter((b,i)=>{const a=cycle[(i+cycle.length-1)%cycle.length],c=cycle[(i+1)%cycle.length];return (b[0]-a[0])*(c[1]-b[1])!==(b[1]-a[1])*(c[0]-b[0]);});simple.push(simple[0]);rings.push(simple);}
     for(let j=index+1;j<stack.length;j++)positions.delete(stack[j][1]*stride+stack[j][0]);stack.length=index+1;
    }else {positions.set(key,stack.length);stack.push(point);}
   }
  }
  const outer=rings.filter(r=>ringArea(r)>0).map(r=>[r]),holes=rings.filter(r=>ringArea(r)<0);
  for(const h of holes){const a=h[0],b=h[1],dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy),p=[(a[0]+b[0])/2+dy/len*1e-5,(a[1]+b[1])/2-dx/len*1e-5],poly=outer.filter(o=>inside(p,o[0])).sort((u,v)=>Math.abs(ringArea(u[0]))-Math.abs(ringArea(v[0])))[0];if(!poly)throw Error('Hueco sin polígono exterior');poly.push(h);}
  polygons.set(id,outer);
 }return polygons;
}
function tiff(array,g){
 // Classic uncompressed GeoTIFF UInt32, EPSG:9377, zero background.
 const ascii=new TextEncoder().encode('0\0');
 const fields=[[256,4,[g.width]],[257,4,[g.height]],[258,3,[32]],[259,3,[1]],[262,3,[1]],[273,4,[0]],[277,3,[1]],[278,4,[g.height]],[279,4,[array.byteLength]],[284,3,[1]],[339,3,[1]],[33550,12,[g.res,g.res,0]],[33922,12,[0,0,0,g.x0,g.y0,0]],[34735,3,[1,1,0,4,1024,0,1,1,1025,0,1,1,3072,0,1,9377,3076,0,1,9001]],[42113,2,Array.from(ascii)]];
 let offset=8+2+12*fields.length+4;for(const f of fields){const size={2:1,3:2,4:4,12:8}[f[1]]*f[2].length;if(size>4){f[3]=offset;offset+=size;}}
 offset=(offset+3)&~3;fields.find(f=>f[0]===273)[2]=[offset];const out=new Uint8Array(offset+array.byteLength),v=new DataView(out.buffer);v.setUint16(0,0x4949,true);v.setUint16(2,42,true);v.setUint32(4,8,true);v.setUint16(8,fields.length,true);
 fields.forEach((f,i)=>{const p=10+i*12,[tag,type,values]=f;v.setUint16(p,tag,true);v.setUint16(p+2,type,true);v.setUint32(p+4,values.length,true);const pos=f[3]??(p+8);if(f[3]!=null)v.setUint32(p+8,f[3],true);const step={2:1,3:2,4:4,12:8}[type];values.forEach((x,j)=>{const k=pos+j*step;if(type===12)v.setFloat64(k,x,true);else if(type===4)v.setUint32(k,x,true);else if(type===3)v.setUint16(k,x,true);else v.setUint8(k,x);});});
 new Uint32Array(out.buffer,offset,array.length).set(array);return out;
}
root.GeoEngine={passes,components,polygonize,ringArea,tiff};if(typeof module!=='undefined')module.exports=root.GeoEngine;
})(typeof self!=='undefined'?self:globalThis);
