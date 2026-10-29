#!/usr/bin/env python3
"""Prepara SALIDAS_FINALES para el visor. Conserva Float32 y la malla EPSG:9377.
Uso: python tools/preparar_datos.py /ruta/SALIDAS_FINALES
Dependencias: numpy rasterio pyproj shapely pyshp scipy
"""
import argparse, gzip, json, hashlib
from pathlib import Path
import numpy as np
import rasterio as rio
from rasterio.features import rasterize
from rasterio.warp import reproject, calculate_default_transform, Resampling
from pyproj import CRS, Transformer
import shapefile
from shapely.geometry import shape, mapping
from shapely.ops import transform
from shapely import make_valid

SCENARIOS=['S1_BASE','S2_BASE','S1_RH30','S2_RH30']
MODELS={'A1':'consolidacionA1','B':'expansionNucleosB','C':'steppingStonesC'}
COLORS={'Bosques':'#24543b','Pastizales':'#e3cc72','Cultivos':'#d48b49','Herbazales':'#c1ce78','Vegetación secundaria':'#80b361','Superficies de agua':'#4b9aca','Territorios artificializados':'#c76d6b','Tierras degradadas':'#97745c','Arbustales':'#758846','Áreas húmedas':'#60b7b4','Áreas abiertas con poca vegetación':'#c7b591','Sin cobertura':'#929e98'}
def write_gz(path,array):
    with gzip.open(path,'wb',compresslevel=6) as f:f.write(array.tobytes())
def read_vector(path,target=9377):
    sr=shapefile.Reader(str(path),encoding='utf-8')
    crs=CRS.from_wkt(path.with_suffix('.prj').read_text())
    tr=Transformer.from_crs(crs,target,always_xy=True).transform
    return [(transform(tr,make_valid(shape(s.__geo_interface__))),r.as_dict()) for s,r in zip(sr.shapes(),sr.records())]
def geojson(features,target):
    tr=Transformer.from_crs(9377,target,always_xy=True).transform
    return {'type':'FeatureCollection','features':[{'type':'Feature','properties':p,'geometry':mapping(transform(tr,g))} for g,p in features]}
def prepare(root,out,old_veredas=None):
    out.mkdir(parents=True,exist_ok=True)
    metadata={'version':2,'crs':'EPSG:9377','proj4':CRS(9377).to_proj4(),'scenarios':SCENARIOS,'models':MODELS,'localities':[],'rank_storage':'Float32 little-endian; NaN=NoData; sin cuantización','method':'Centro de celda, 30 m; área plana EPSG:9377; conectividad de parches 8 vecinos'}
    for loc in ['Cachicamo','Mesetas']:
        print('Preparando',loc,flush=True)
        dest=out/loc;dest.mkdir(exist_ok=True)
        first=root/loc/'Rankmaps'/f'{loc}_mspa_S1_BASE_consolidacionA1_rankmap.tif'
        with rio.open(first) as src:
            h,w=src.shape;tf=src.transform;crs=src.crs
            assert crs.to_epsg()==9377 and tf.a==30 and tf.e==-30
            webtf,ww,wh=calculate_default_transform(crs,3857,w,h,*src.bounds,resolution=30)
        cov=read_vector(root/loc/f'{loc}_coberturas.shp')
        names=sorted(set(str(p.get('cob_agrup_') or 'Sin cobertura') for _,p in cov))
        if 'Sin cobertura' not in names:names.append('Sin cobertura')
        codes={n:i+1 for i,n in enumerate(names)}
        cover=rasterize([(g,codes[str(p.get('cob_agrup_') or 'Sin cobertura')]) for g,p in cov],out_shape=(h,w),transform=tf,fill=codes['Sin cobertura'],dtype='uint8')
        write_gz(dest/'cover.u8.gz',cover)
        corridors=read_vector(root/loc/'Corredores'/f'{loc}_consolidados.shp')
        cor=rasterize([(g,i+1) for i,(g,p) in enumerate(corridors)],out_shape=(h,w),transform=tf,fill=0,dtype='uint8')
        write_gz(dest/'corridor.u8.gz',cor)
        for label,features in [('corridors',corridors),('proposal',read_vector(root/loc/'Nucleos_preliminares'/f'{loc}_nucleos_candidatos.shp'))]:
            with gzip.open(dest/f'{label}.geojson.gz','wt',encoding='utf-8') as f:json.dump(geojson(features,4326),f,ensure_ascii=False,separators=(',',':'))
        # Web display lookup references native cells; analysis never resamples ranks.
        lookup=np.zeros((wh,ww),dtype='<u4')
        reproject(np.arange(1,h*w+1,dtype='<u4').reshape(h,w),lookup,src_transform=tf,src_crs=crs,dst_transform=webtf,dst_crs=3857,src_nodata=0,dst_nodata=0,resampling=Resampling.nearest)
        write_gz(dest/'lookup.u32.gz',lookup)
        trans=Transformer.from_crs(3857,4326,always_xy=True)
        west,south=trans.transform(webtf.c,webtf.f-wh*30);east,north=trans.transform(webtf.c+ww*30,webtf.f)
        files={}
        for sc in SCENARIOS:
            files[sc]={}
            for m,tag in MODELS.items():
                file=root/loc/'Rankmaps'/f'{loc}_mspa_{sc}_{tag}_rankmap.tif'
                with rio.open(file) as d:
                    if d.shape!=(h,w) or d.transform!=tf or d.crs!=crs:raise ValueError(f'Malla incompatible: {file}')
                    a=d.read(1,masked=True).filled(np.nan).astype('<f4');a[~np.isfinite(a)]=np.nan
                    if np.nanmin(a)<0 or np.nanmax(a)>1:raise ValueError(f'Rank fuera de [0,1]: {file}')
                name=f'{sc}_{m}.f32.gz';write_gz(dest/name,a);files[sc][m]=name
        veredas=[]
        if loc=='Cachicamo' and old_veredas and old_veredas.exists():
            data=json.loads(old_veredas.read_text());tr=Transformer.from_crs(4326,9377,always_xy=True).transform
            features=[(transform(tr,shape(f['geometry'])),int(f['properties']['vid'])) for f in data['features']]
            ver=rasterize(features,out_shape=(h,w),transform=tf,fill=0,dtype='uint8');write_gz(dest/'vereda.u8.gz',ver)
            (dest/'veredas.geojson').write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8')
            veredas=[{'id':int(f['properties']['vid']),'name':f['properties']['nombre']} for f in data['features']]
        # Reference implementation for default core generation, used in cross-runtime QA.
        from scipy.ndimage import label
        votes=np.zeros((h,w),np.uint8)
        for sc in SCENARIOS:
            bb=np.frombuffer(gzip.open(dest/files[sc]['B'],'rb').read(),'<f4').reshape(h,w)
            cc=np.frombuffer(gzip.open(dest/files[sc]['C'],'rb').read(),'<f4').reshape(h,w)
            votes+=((bb>=.75)|(cc>=.75))
        eligible=(votes>=3)&(cor>0)&~np.isin(cover,[codes.get('Tierras degradadas'),codes.get('Superficies de agua')])
        labels,n=label(eligible,structure=np.ones((3,3)));counts=np.bincount(labels.ravel());counts[0]=0
        keep=counts*0.09>=1
        reference={'patches':int(keep.sum()),'cells':int(counts[keep].sum()),'area_ha':round(float(counts[keep].sum())*.09,2),'proposal_features':len(read_vector(root/loc/'Nucleos_preliminares'/f'{loc}_nucleos_candidatos.shp'))}
        print(loc,reference,flush=True)
        metadata['localities'].append({'id':loc,'grid':{'width':w,'height':h,'x0':tf.c,'y0':tf.f,'res':30,'cell_ha':.09},'display':{'width':ww,'height':wh,'x0':webtf.c,'y0':webtf.f,'res':30,'bounds':[[south,west],[north,east]]},'coverages':[{'id':codes[n],'name':n,'color':COLORS.get(n,'#a3ada7')} for n in names],'corridors':[{'id':i+1,'name':p['corredor'],'class':p.get('clase'),'area_ha':p.get('a_final_ha')} for i,(g,p) in enumerate(corridors)],'veredas':veredas,'files':files,'reference_default':reference})
    (out/'catalog.json').write_text(json.dumps(metadata,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    (out/'crs.wkt').write_text(CRS(9377).to_wkt(version='WKT1_ESRI'))
    manifest={str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob('*') if p.is_file() and p.name!='checksums.json'}
    (out/'checksums.json').write_text(json.dumps(manifest,indent=2))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('input',type=Path);p.add_argument('--output',type=Path,default=Path(__file__).resolve().parents[1]/'data');p.add_argument('--veredas',type=Path);a=p.parse_args();prepare(a.input,a.output,a.veredas)
