#!/usr/bin/env python3
"""Genera las descargas originales y el catálogo de 18 gráficas."""
from pathlib import Path
import zipfile,json,gzip,csv,io,shutil,hashlib
import numpy as np,shapefile,rasterio
from rasterio.features import rasterize
from shapely.geometry import shape,mapping
from shapely.ops import transform
from pyproj import Transformer
import argparse
parser=argparse.ArgumentParser(description='Prepara originales descargables y gráficas para el visor.')
parser.add_argument('input',type=Path)
parser.add_argument('--web',type=Path,default=Path(__file__).resolve().parents[1])
parser.add_argument('--graficas-cachicamo',type=Path,required=True)
parser.add_argument('--graficas-mesetas',type=Path,required=True)
args=parser.parse_args()
root=args.web;inp=args.input;originals={};graphs={}
graph_archives={'Cachicamo':args.graficas_cachicamo,'Mesetas':args.graficas_mesetas}
for loc in ['Cachicamo','Mesetas']:
 dest=root/'data'/loc/'original';dest.mkdir(parents=True,exist_ok=True)
 layers={}
 for key,folder,stem in [('nucleos','Nucleos_preliminares',loc+'_nucleos_candidatos'),('corredores','Corredores',loc+'_consolidados')]:
  path=inp/loc/folder/(stem+'.shp');reader=shapefile.Reader(str(path),encoding='utf-8');records=[r.as_dict() for r in reader.records()]
  gz=root/'data'/loc/('proposal.geojson.gz' if key=='nucleos' else 'corridors.geojson.gz');geo=json.load(gzip.open(gz));(dest/(key+'.geojson')).write_text(json.dumps(geo,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
  with (dest/(key+'.csv')).open('w',newline='',encoding='utf-8-sig') as f:
   writer=csv.DictWriter(f,fieldnames=records[0].keys(),delimiter=';');writer.writeheader();writer.writerows(records)
  layers[key]={'reader':reader,'records':records,'path':path,'stem':stem,'geojson':geo}
 first=next((inp/loc/'Rankmaps').glob('*S1_BASE_consolidacionA1_rankmap.tif'))
 with rasterio.open(first) as src:
  shapes=[(shape(s.__geo_interface__),int(r['nucleo'].lstrip('N'))) for s,r in zip(layers['nucleos']['reader'].shapes(),layers['nucleos']['records'])]
  ids=rasterize(shapes,out_shape=src.shape,transform=src.transform,fill=0,dtype='uint32');profile=src.profile.copy();profile.update(dtype='uint32',nodata=0,compress='deflate',predictor=2)
  with rasterio.open(dest/'nucleos_id.tif','w',**profile) as dst:dst.write(ids,1)
 nuclei=layers['nucleos']['records'];corr=layers['corredores']['records'];summary={'nuclei':len(nuclei),'area_ha':round(sum(r['area_ha'] for r in nuclei),2),'corridors':len(corr),'corridor_area_ha':round(sum(r['a_final_ha'] for r in corr),2),'criteria':{'models':['B','C'],'rank_min':.75,'agreement':3,'mspa_total':4,'min_area_ha':1,'neighbors':8,'excluded_coverages':['Tierras degradadas','Superficies de agua'],'inside_corridors':True},'origin':'Capas originales de SALIDAS_FINALES suministradas por el usuario; no recalculadas al abrir el visor.','crs':'EPSG:9377','nuclei_csv':f'data/{loc}/original/nucleos.csv','nuclei_geojson':f'data/{loc}/original/nucleos.geojson','corridors_geojson':f'data/{loc}/original/corredores.geojson','zip':f'data/{loc}/original/{loc}_resultado_final_original.zip'}
 (dest/'parametros_originales.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
 readme='Resultado final entregado: propuesta original de núcleos y corredores consolidados. Los SHP se conservan exactamente como fueron suministrados, en EPSG:9377. GeoJSON en WGS84. El TIFF de núcleos conserva la malla original de 30 m; cero es NoData y los IDs corresponden a N1, N2, etc. CSV conserva los atributos originales. Estos archivos son independientes de los filtros personalizados del visor.\n'
 with zipfile.ZipFile(dest/f'{loc}_resultado_final_original.zip','w',compression=zipfile.ZIP_DEFLATED) as z:
  for key,layer in layers.items():
   for ext in ['.shp','.shx','.dbf','.prj','.cpg']:
    f=layer['path'].with_suffix(ext)
    if f.exists():z.write(f,f'{key}/{layer["stem"]}{ext}')
   for ext in ['.geojson','.csv']:z.write(dest/(key+ext),key+ext)
  z.write(dest/'nucleos_id.tif','nucleos_id.tif');z.write(dest/'parametros_originales.json','parametros_originales.json');z.writestr('LEEME.txt',readme)
 originals[loc]=summary
 gd=root/'graficas'/loc;gd.mkdir(parents=True,exist_ok=True);graphs[loc]={}
 for entry in sorted(zipfile.ZipFile(graph_archives[loc]).namelist()):
  if not entry.lower().endswith('.png'):continue
  file=Path(entry)
  model='A1' if '_Escenario_A_' in file.name else 'B' if '_Escenario_B_' in file.name else 'C';kind='top' if '_Comparacion_' in file.name else 'zoom' if '_ZOOM_30' in file.name else 'full';name=f'{model}_{kind}.png';(gd/name).write_bytes(zipfile.ZipFile(graph_archives[loc]).read(entry));graphs[loc].setdefault(model,{})[kind]={'file':f'graficas/{loc}/{name}','source_filename':file.name,'mspa':None}
 print(loc,summary['nuclei'],summary['area_ha'],'ha',summary['corridors'],'corridors')
(root/'data/originales.json').write_text(json.dumps(originals,ensure_ascii=False,indent=2))
(root/'data/graficas.json').write_text(json.dumps({'by_locality':graphs,'scope':'Figuras aportadas por localidad y modelo A1/B/C. Los archivos no identifican el escenario MSPA específico; no se asignan a S1_BASE, S2_BASE, S1_RH30 o S2_RH30.'},ensure_ascii=False,indent=2))

data=root/'data'
manifest={str(p.relative_to(data)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(data.rglob('*')) if p.is_file() and p.name!='checksums.json'}
(data/'checksums.json').write_text(json.dumps(manifest,indent=2))
