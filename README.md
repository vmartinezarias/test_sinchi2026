# Focalización del paisaje · Resultado final, escenarios y propuestas personalizadas

Visor estático listo para GitHub Pages, sin instalación ni servidor de análisis. El ZIP entregado contiene `index.html` directamente en su raíz.


## Actualización: resultado final al inicio

Al abrir se muestra **Resultado final del procesamiento**: propuesta original de núcleos en morado, corredores consolidados delineados en naranja y fondo OpenStreetMap. No se carga un rankmap ni se recalculan núcleos al entrar. La primera vista conserva exactamente los archivos originales suministrados.

- **Descargar resultado final original (.zip)**: núcleos y corredores con sus SHP originales en EPSG:9377, sus atributos completos, GeoJSON WGS84, tablas y un GeoTIFF de IDs de núcleos en la malla de 30 m. Estos archivos son fijos e independientes de cualquier filtro personalizado.
- **¿Cómo se llegó a esto?**: explica la secuencia MSPA → A1/B/C → corredores consolidados → propuesta original de núcleos. A1 participa en la evaluación de los corredores; la selección original de núcleos exige B o C ≥ 0,75 en al menos tres de cuatro MSPA, dentro de corredores, ocho vecinos y área ≥ 1 ha, excluyendo agua y tierras degradadas.
- **Escenarios de priorización**: abre la exploración de los 24 rankmaps. Los filtros de cobertura se aplican a las selecciones exploratorias y personalizadas, nunca al archivo original.
- **Crear propuesta personalizada de núcleos**: reemplaza el nombre «Crear núcleos». Conserva umbrales, intervalos, acuerdo, coberturas y área mínima editables. Sus resultados se identifican como personalizados y se descargan con sus parámetros.
- **Gráficas**: incluye las 18 imágenes aportadas (dos localidades × tres modelos × tres tipos: curva completa, detalle 0–30 %, barras Top 5/10/15 %). Incluye explicación de ejes, atributos, denominador de paisaje o matriz restaurable y descarga de PNG.

Las gráficas están identificadas por localidad y modelo; sus archivos no especifican S1_BASE/S2_BASE/S1_RH30/S2_RH30. El visor no les atribuye un MSPA ni las recalcula al cambiar filtros. Los porcentajes de paisaje/matriz retenidos en las curvas y los valores de rank del mapa se explican como cantidades distintas.

La pestaña **Resultado final** permite volver a la propuesta original después de explorar o crear alternativas. Los controles de sus capas aparecen en la parte superior de esa vista. Las descargas originales siguen disponibles aunque se haya calculado una propuesta personalizada.

### Regenerar las descargas originales y las figuras

Después de preparar los rankmaps con `tools/preparar_datos.py`, ejecuta:

```bash
python tools/preparar_resultado_final.py /ruta/SALIDAS_FINALES \
  --graficas-cachicamo /ruta/Cachicamo_Graficas.zip \
  --graficas-mesetas /ruta/Mesetas_Graficas.zip \
  --web .
```

Esto conserva los SHP fuente dentro de las descargas, genera GeoJSON/CSV/TIFF, copia las figuras sin alterarlas y actualiza sus catálogos y sumas SHA-256.

## Publicar en tu GitHub Pages actual

1. Descomprime `Focalizacion_MSPA_actualizada.zip`.
2. Copia **todo su contenido**, conservando las carpetas `data/`, `lib/`, `tools/` y `version_anterior/`, a la carpeta que publica tu repositorio. Reemplaza `index.html`, `styles.css` y `app.js`. No subas solo el ZIP.
3. Incluye `.nojekyll` (archivo vacío). Si tu configuración publica `/docs`, coloca el contenido dentro de `/docs`; si publica la raíz, colócalo allí.
4. Confirma los cambios. Conserva la configuración de Pages que ya tienes; no se necesita un nuevo servicio.
5. Abre la URL habitual y recarga sin caché (Ctrl+Shift+R).

Las rutas son relativas: funcionan en `https://usuario.github.io/repositorio/`. No se ha modificado tu repositorio ni tu web publicada. Puedes conservar una copia de la versión anterior antes de reemplazarla; también se incluye como enlace dentro del visor.

Para probar el paquete en tu equipo, desde la carpeta descomprimida:

```bash
python -m http.server 8000
```

Abre `http://localhost:8000`. No abras `index.html` con doble clic: la carga de datos y el worker requieren HTTP/HTTPS.

## Datos incorporados

- Localidades: Cachicamo y Mesetas.
- MSPA: S1_BASE, S2_BASE, S1_RH30, S2_RH30. Se conservan sus identificadores sin reinterpretar los parámetros morfológicos.
- Tres modelos por MSPA: A1 Consolidación (`consolidacionA1`), B Expansión de núcleos (`expansionNucleosB`), C Stepping stones (`steppingStonesC`). Total: 24 mapas.
- Coberturas agrupadas del campo `cob_agrup_`, incorporadas desde los SHP de ambas localidades del segundo ZIP.
- Corredores consolidados y propuesta original de núcleos como referencias fijas.
- Veredas de Cachicamo procedentes del visor anterior. No se suministraron veredas de Mesetas.
- El enlace al visor anterior conserva sus datos y gráficos originales, que corresponden a la versión previa, no a los 24 mapas actualizados.

## Uso

### Explorar

Elige localidad, MSPA y modelo. Ajusta el intervalo **inclusivo** de rank entre 0 y 1. Un intervalo 0,50–0,85 selecciona los valores en ese rango; un umbral 0,75–1 conserva celdas con rank ≥ 0,75. Son valores de prioridad relativa de cada corrida, no porcentajes del área.

Los cambios actualizan la selección automáticamente. También puedes pulsar **Actualizar selección**. La representación ofrece rank continuo, solo selección y coberturas. **Comparar los cuatro MSPA** calcula área válida, área seleccionada y fracción seleccionada usando el mismo modelo, intervalo y filtros. La comparación se descarga en CSV.

El mapa permite consultar los ranks A1, B y C del MSPA elegido, coordenadas EPSG:9377, cobertura, corredor y pertenencia a un parche de la selección. Al activar referencias, puedes consultar sus atributos.

### Crear propuesta personalizada de núcleos

Por defecto reproduce la regla del script `5-Coberturas_corredores_nucleos.R`:

1. Dentro de cada MSPA, una celda pasa si **B o C** tiene rank ≥ 0,75.
2. Se exige que pase en al menos **3 de los 4 MSPA**.
3. Se limita a los corredores consolidados y se excluyen **Tierras degradadas** y **Superficies de agua**.
4. Se forman parches con **ocho vecinos** y se descartan los menores de **1 ha**.
5. Los parches se ordenan por área y reciben N1, N2, etc. Un empate puede dar diferente numeración respecto a otros programas; la selección espacial se mantiene.

Puedes cambiar modelos activos, intervalo por modelo, MSPA participantes, acuerdo mínimo, área mínima, coberturas y ámbito. Para usar un solo MSPA, desmarca los demás y usa acuerdo 1 de 1. La unión entre modelos se mantiene: basta uno dentro de cada MSPA. El área mínima se aplica a los parches después de los filtros.

**Usar los criterios de la propuesta original** restaura esos parámetros y vuelve a calcular. Las referencias originales permanecen fijas. Cuando cambias criterios, se retira la selección anterior del mapa y se bloquean sus descargas hasta recalcular.

### Filtros compartidos

- Por defecto se trabaja dentro de corredores consolidados. Desmarca esa opción para explorar todo el ámbito disponible de los rankmaps.
- Puedes seleccionar un corredor, una vereda de Cachicamo y cualquier combinación de coberturas.
- El filtro por cobertura clasifica el centro de la celda de 30 m. No hace un recorte vectorial subpíxel al límite de las coberturas.
- «Sin cobertura» significa que no hay una cobertura intersectando el centro de la celda en la capa suministrada. Puede excluirse.
- Por defecto se excluyen agua y tierras degradadas tanto al explorar como al generar núcleos. Usa **Todas** para incluirlas.

## Descargas

**Paquete SIG (.zip)** incluye:

| Archivo | Contenido |
|---|---|
| `seleccion.shp/.shx/.dbf/.prj/.cpg` | Polígonos de parches, EPSG:9377, atributos UTF-8 |
| `seleccion.tif` | GeoTIFF UInt32 en la grilla original, EPSG:9377; 0=NoData/fondo; ID positivo=parche |
| `seleccion.geojson` | Los mismos polígonos en longitud/latitud WGS84, con parámetros de selección en `metadata` |
| `nucleos.csv` | Todos los parches, áreas, cobertura y corredor dominantes, acuerdo medio y criterios |
| `coberturas.csv` | Composición de la selección por cobertura |
| `parametros.json` | Localidad, fecha, modelos, intervalos, MSPA, acuerdo, filtros, malla y resumen |
| `LEEME.txt` | Explicación de formatos y método |

También hay descargas independientes de GeoJSON, GeoTIFF, tabla CSV y parámetros. Los GeoTIFF descargados contienen la **selección etiquetada**, no el rankmap completo. P1/P2 se usan para parches exploratorios y N1/N2 para núcleos candidatos; el TIFF usa sus números enteros. La cobertura y el corredor dominantes resumen cada parche, sin cortar un parche que abarque más de uno. `agreement` es el promedio por celda del número de MSPA que cumplieron el criterio; no es una categoría MSPA.

Las áreas se calculan como número de celdas × 0,09 ha, en la malla plana EPSG:9377. El porcentaje seleccionado usa como denominador las celdas válidas dentro del ámbito y las coberturas activas. En núcleos, válida significa que al menos un modelo y MSPA participantes tiene dato en esa celda. Los NoData nunca cumplen los intervalos; un rank válido igual a 0 sí puede seleccionarse.

## Validación

Con los criterios del R:

| Localidad | Núcleos | Celdas | Área (ha) |
|---|---:|---:|---:|
| Cachicamo | 496 | 39.027 | 3.512,43 |
| Mesetas | 343 | 70.592 | 6.353,28 |

La selección coincide **celda por celda** con los núcleos preliminares entregados. Se verificaron la validez de todas las geometrías SHP/GeoJSON, sus áreas y su correspondencia exacta con el GeoTIFF tras rasterizar de nuevo. El trazado de bordes también pasó los 512 patrones binarios posibles de una malla 3×3, incluidos huecos y contactos diagonales. Ver `VALIDACION.json`.

Se probaron en navegador la carga, los controles y la generación de núcleos. El procesamiento no modifica los datos originales ni vuelve a ejecutar MSPA, Zonation o la consolidación de corredores: aplica filtros a sus resultados precomputados. Los núcleos son candidatos de restauración, no la clase Core de MSPA, ni una nueva priorización optimizada.

## Rendimiento y requisitos

Se recomienda un navegador moderno en computador de escritorio. Los valores de rank conservan Float32 original, sin cuantización. Los datos se cargan por localidad y modelo cuando se necesitan; el primer cálculo de consenso carga ocho mapas y puede tardar más. Los datos están comprimidos y se procesan en un Web Worker. Las localidades se descargan de la memoria del motor al cambiar de área.

El mapa usa OpenStreetMap por defecto; puede cambiarse a imagen satelital Esri o desactivarse. La disponibilidad de cada proveedor puede variar según el navegador o la red. Las bibliotecas están incluidas, sin CDN; las teselas de los mapas base requieren conexión externa. La app no guarda selecciones entre sesiones: descarga el paquete o los parámetros para conservarlas. Para mapas y selecciones muy extensos, la vectorización y compresión pueden requerir varios segundos y suficiente memoria.

## Actualizar datos en el futuro

Se incluye `tools/preparar_datos.py`. Requiere Python con `numpy rasterio pyproj shapely pyshp scipy`:

```bash
python -m pip install -r tools/requirements.txt
python tools/preparar_datos.py /ruta/SALIDAS_FINALES --output data
```

Para conservar el filtro de veredas:

```bash
python tools/preparar_datos.py /ruta/SALIDAS_FINALES --output data --veredas version_anterior/data/veredas.geojson
```

La carpeta debe contener las dos localidades, sus 12 rankmaps, el SHP de coberturas, corredores y núcleos preliminares, con la estructura de tus adjuntos. Todos los rankmaps de una localidad deben compartir grilla EPSG:9377 a 30 m. El preparador verifica esto y conserva los Float32; genera una tabla de consulta para reproyectar únicamente la visualización a Web Mercator. El cálculo de selección permanece siempre en la grilla original.

La aplicación principal está en `index.html`, `app.js`, `styles.css`, `worker.js`, `engine.js` y `shapefile.js`. No necesita compilación ni claves API.
