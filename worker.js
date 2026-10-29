'use strict';
importScripts('lib/fflate.js','lib/proj4.js','engine.js','shapefile.js');
let catalog,loc,cover,corridor,vereda,lookup,cache={},result=null;
let queue=Promise.resolve();self.onmessage=e=>{queue=queue.then(()=>handle(e.data)).catch(error=>postMessage({id:e.data.id,error:error.message,stack:error.stack}));};
const enc=new TextEncoder();
const note=(message)=>postMessage({progress:message});
async function bin(url,Type){const r=await fetch(url);if(!r.ok)throw Error(`No se pudo cargar ${url}: HTTP ${r.status}`);let b=new Uint8Array(await r.arrayBuffer());if(b[0]===31&&b[1]===139)b=fflate.gunzipSync(b);return new Type(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));}
async function rank(s,m){const k=s+'_'+m;if(!cache[k]){note(`Cargando ${loc.id} · ${s} · ${m}`);cache[k]=await bin(`data/${loc.id}/${loc.files[s][m]}`,Float32Array);if(cache[k].length!==cover.length)throw Error('Dimensiones de rankmap incompatibles');}return cache[k];}
function allowed(p,i){return p.coverages.includes(cover[i])&&(!p.corridor||corridor[i]===p.corridor)&&(!p.inside||corridor[i]>0)&&(!p.vereda||vereda?.[i]===p.vereda);}
function color(x){const stops=[[38,48,85],[44,116,142],[51,165,145],[158,207,105],[246,218,93],[224,121,68],[160,43,54]],v=Math.max(0,Math.min(1,x))*(stops.length-1),k=Math.min(stops.length-2,v|0),f=v-k;return stops[k].map((c,i)=>Math.round(c+(stops[k+1][i]-c)*f));}
const palette=Array.from({length:256},(_,i)=>color(i/255));
function render(p,labels,values,votes){const out=new Uint8ClampedArray(lookup.length*4),colors=Object.fromEntries(loc.coverages.map(c=>[c.id,c.color.match(/\w\w/g).map(x=>parseInt(x,16))]));for(let j=0;j<lookup.length;j++){const i=lookup[j]-1;if(i<0||!allowed(p,i))continue;const selected=labels[i]>0;let rgb,alpha;if(p.paint==='coverage'){rgb=colors[cover[i]];alpha=selected?235:90;}else if(p.mode==='core'){if(!selected)continue;rgb=palette[Math.round(votes[i]/p.scenarios.length*255)];alpha=245;}else if(p.paint==='selected'){if(!selected)continue;rgb=[40,204,145];alpha=245;}else {if(!Number.isFinite(values[i]))continue;rgb=palette[Math.round(values[i]*255)];alpha=selected?235:55;}out.set([...rgb,alpha],j*4);}return out;}
const csv=(rows)=>{if(!rows.length)return '\ufeff';const keys=Object.keys(rows[0]);const cell=x=>'"'+String(x??'').replaceAll('"','""')+'"';return '\ufeff'+[keys,...rows.map(r=>keys.map(k=>r[k]))].map(r=>r.map(cell).join(';')).join('\r\n');};
async function compute(p){
 result=null;const n=cover.length,mask=new Uint8Array(n),votes=new Uint8Array(n);let values;
 if(!p.coverages.length)note('Ninguna cobertura seleccionada');
 if(p.mode==='core'){
  if(!p.scenarios.length||!p.models.length)throw Error('Selecciona al menos un escenario y un modelo');
  for(const s of p.scenarios){const arrays=await Promise.all(p.models.map(m=>rank(s,m)));for(let i=0;i<n;i++){if(!allowed(p,i))continue;for(let j=0;j<arrays.length;j++){const range=p.ranges[p.models[j]];if(GeoEngine.passes(arrays[j][i],range[0],range[1])){votes[i]++;break;}}}}
  for(let i=0;i<n;i++)mask[i]=votes[i]>=p.agreement&&allowed(p,i)?1:0;
 }else {values=await rank(p.scenario,p.model);for(let i=0;i<n;i++)mask[i]=allowed(p,i)&&GeoEngine.passes(values[i],p.range[0],p.range[1])?1:0;}
 note('Delimitando parches con ocho vecinos…');const {labels,sizes}=GeoEngine.components(mask,loc.grid.width,loc.grid.height,p.mode==='core'?p.minHa:0,loc.grid.cell_ha);
 const patches=sizes.slice(1).map((cells,j)=>({num:j+1,id:(p.mode==='core'?'N':'P')+(j+1),cells,area_ha:cells*loc.grid.cell_ha,agreement:0,coverCounts:{},corrCounts:{}})),stats={};let selected=0,eligible=0,totalRank=0,valid=0;
 for(let i=0;i<n;i++){
  if(allowed(p,i)&&(p.mode==='core'?p.scenarios.some(s=>p.models.some(m=>Number.isFinite(cache[s+'_'+m][i]))):Number.isFinite(values[i])))eligible++;
  const id=labels[i];if(!id)continue;selected++;const c=cover[i],patch=patches[id-1];patch.agreement+=votes[i];patch.coverCounts[c]=(patch.coverCounts[c]||0)+1;patch.corrCounts[corridor[i]]=(patch.corrCounts[corridor[i]]||0)+1;
  if(!stats[c])stats[c]={coverage:loc.coverages.find(x=>x.id===c)?.name||'Sin cobertura',cells:0,area_ha:0,mean_rank:null,mean_agreement:null,sum:0,n:0,agree:0};const st=stats[c];st.cells++;st.agree+=votes[i];if(values&&Number.isFinite(values[i])){st.sum+=values[i];st.n++;totalRank+=values[i];valid++;}
 }
 const maxKey=o=>Number(Object.keys(o).sort((a,b)=>o[b]-o[a]||Number(a)-Number(b))[0]);
 patches.forEach(q=>{q.agreement=p.mode==='core'?q.agreement/q.cells:null;q.cov_dom=loc.coverages.find(c=>c.id===maxKey(q.coverCounts))?.name||'Sin cobertura';q.corr_dom=loc.corridors.find(c=>c.id===maxKey(q.corrCounts))?.name||'Fuera de corredores';delete q.coverCounts;delete q.corrCounts;});
 const coverStats=Object.values(stats).map(s=>({coverage:s.coverage,cells:s.cells,area_ha:s.cells*loc.grid.cell_ha,mean_rank:s.n?s.sum/s.n:null,mean_agreement:p.mode==='core'?s.agree/s.cells:null})).sort((a,b)=>b.area_ha-a.area_ha);
 const rgba=render(p,labels,values,votes),summary={selected,area_ha:selected*loc.grid.cell_ha,eligible,eligible_ha:eligible*loc.grid.cell_ha,percent:eligible?selected/eligible*100:0,patches:patches.length,mean_rank:valid?totalRank/valid:null};
 result={p:structuredClone(p),labels,sizes,patches,coverStats,summary};return {summary,coverStats,patches,rgba};
}
function features(){
 note('Vectorizando bordes de celdas y huecos…');const pp=GeoEngine.polygonize(result.labels,loc.grid.width,loc.grid.height),g=loc.grid;
 const native=result.patches.map(p=>({type:'Feature',properties:{id:p.id,area_ha:p.area_ha,cells:p.cells,agreement:p.agreement,cov_dom:p.cov_dom,corr_dom:p.corr_dom},geometry:{type:'MultiPolygon',coordinates:pp.get(p.num).map(poly=>poly.map(r=>r.map(([x,y])=>[g.x0+x*g.res,g.y0-y*g.res])))}}));
 const ll=proj4(catalog.proj4,'EPSG:4326');const geo=native.map(f=>({...f,geometry:{type:'MultiPolygon',coordinates:f.geometry.coordinates.map(poly=>poly.map(r=>r.slice().reverse().map(p=>ll.forward(p))))}}));return {native,geo};
}
function patchRows(){const p=result.p;return result.patches.map(({num,...r})=>({...r,locality:loc.id,mode:p.mode,scenarios:(p.scenarios||[p.scenario]).join('|'),models:(p.models||[p.model]).join('|'),rank_intervals:JSON.stringify(p.ranges||{[p.model]:p.range}),agreement_min:p.agreement??'',area_min_ha:p.minHa??0,inside_corridors:p.inside,corridor_filter:p.corridor,vereda_filter:p.vereda,coverages_included:p.coverages.map(id=>loc.coverages.find(c=>c.id===id)?.name).join('|')}));}
async function handle(msg){const {id,type,payload}=msg;let out;
 if(type==='init'){
  catalog=payload.catalog;loc=catalog.localities.find(x=>x.id===payload.locality);if(!loc)throw Error('Localidad inválida');cache={};result=null;note('Cargando malla y coberturas…');
  [cover,corridor,lookup,vereda]=await Promise.all([bin(`data/${loc.id}/cover.u8.gz`,Uint8Array),bin(`data/${loc.id}/corridor.u8.gz`,Uint8Array),bin(`data/${loc.id}/lookup.u32.gz`,Uint32Array),loc.veredas.length?bin(`data/${loc.id}/vereda.u8.gz`,Uint8Array):null]);
  if(cover.length!==loc.grid.width*loc.grid.height||corridor.length!==cover.length)throw Error('Malla de datos incompatible');out={ok:true};
 }else if(type==='compute')out=await compute(payload);
 else if(type==='compare'){
  out=[];for(const s of catalog.scenarios){const a=await rank(s,payload.model);let cells=0,valid=0,sum=0;for(let i=0;i<a.length;i++)if(allowed(payload,i)&&Number.isFinite(a[i])){valid++;if(GeoEngine.passes(a[i],...payload.range)){cells++;sum+=a[i];}}out.push({scenario:s,model:payload.model,valid_ha:valid*.09,selected_ha:cells*.09,percent:valid?100*cells/valid:0,mean_rank:cells?sum/cells:null});}
 }else if(type==='query'){
  const i=payload.i;if(i<0||i>=cover.length)out=null;else {const vals={};for(const m of Object.keys(catalog.models)){const a=await rank(payload.scenario,m);vals[m]=Number.isFinite(a[i])?a[i]:null;}out={cover:loc.coverages.find(c=>c.id===cover[i])?.name,corridor:loc.corridors.find(c=>c.id===corridor[i])?.name||'Fuera de corredores',vereda:loc.veredas.find(v=>v.id===vereda?.[i])?.name,ranks:vals,patch:result?.labels[i]?result.patches[result.labels[i]-1]:null};}
 }else if(type==='export'){
  if(!result)throw Error('Primero calcula una selección');
  const params={locality:loc.id,created_at:new Date().toISOString(),crs_analysis:'EPSG:9377',grid:loc.grid,parameters:result.p,summary:result.summary,method:catalog.method,rank_storage:catalog.rank_storage};
  if(payload.format==='csv')out={bytes:enc.encode(csv(patchRows())),mime:'text/csv',ext:'csv'};
  else if(payload.format==='tif')out={bytes:GeoEngine.tiff(result.labels,loc.grid),mime:'image/tiff',ext:'tif'};
  else if(payload.format==='params')out={bytes:enc.encode(JSON.stringify(params,null,2)),mime:'application/json',ext:'json'};
  else {const f=features(),fc={type:'FeatureCollection',name:loc.id+'_seleccion',metadata:params,features:f.geo};if(payload.format==='geojson')out={bytes:enc.encode(JSON.stringify(fc)),mime:'application/geo+json',ext:'geojson'};
   else {const files={'seleccion.geojson':enc.encode(JSON.stringify(fc)),'seleccion.tif':GeoEngine.tiff(result.labels,loc.grid),'nucleos.csv':enc.encode(csv(patchRows())),'coberturas.csv':enc.encode(csv(result.coverStats)),'parametros.json':enc.encode(JSON.stringify(params,null,2)),'LEEME.txt':enc.encode('Selección de celdas de 30 m, EPSG:9377. SHP y TIFF en EPSG:9377; GeoJSON en longitud/latitud WGS84. TIFF: 0=fondo; enteros positivos=ID de parche. Conectividad 8 vecinos. Áreas planas: 0.09 ha/celda. El filtro por cobertura usa centros de celda, no recorte vectorial a límites subpíxel. Umbrales inclusivos sobre Float32 original. Ver parametros.json para todos los criterios. Los núcleos son candidatos para revisión, no nuevos resultados de Zonation.\n'),...shapeFiles(f.native,payload.wkt)};note('Comprimiendo descarga…');out={bytes:fflate.zipSync(files,{level:6}),mime:'application/zip',ext:'zip'};}
  }
 }else throw Error('Operación desconocida');
 const transfer=[];if(out?.rgba)transfer.push(out.rgba.buffer);if(out?.bytes)transfer.push(out.bytes.buffer);postMessage({id,out},transfer);
}
