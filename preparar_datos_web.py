"""
Prepara los datos de la plataforma web de Focalización Cachicamo (GitHub Pages).

Toma los rásters de Zonation, el GPKG de estadísticas por cobertura y las veredas,
y genera en <SALIDA>/data/:
  - <raster>.u16.gz   valores 0–1 cuantizados a uint16 (0 = sin dato), malla EPSG:3857
  - coberturas.u8.gz  código de cobertura por píxel (0 = sin cobertura)
  - veredas.u8.gz     id de vereda por píxel (0 = fuera de veredas)
  - veredas.geojson   contornos de veredas en EPSG:4326 (para dibujar)
  - meta.json         malla, nombres, colores y estadísticas globales por cobertura

Todo se rasteriza en la malla nativa (EPSG:9377, 30 m) y luego se reproyecta
a EPSG:3857 con vecino más cercano, que es la proyección del mapa web.

Uso en PyCharm: ajustar ENTRADA, VEREDAS y SALIDA, y ejecutar.
Requisitos: pip install rasterio geopandas numpy
"""

import argparse
import gzip
import json
from pathlib import Path

import numpy as np
import geopandas as gpd
import rasterio
from rasterio.features import rasterize
from rasterio.warp import calculate_default_transform, reproject, Resampling, transform_bounds

# ----------------------------------------------------------------------------
# CONFIGURACIÓN (valores por defecto; también se pueden pasar por línea de comandos)
# ----------------------------------------------------------------------------
ENTRADA = Path("/home/vmartinezarias/Dropbox/SINCHI2026/OUTPUTS_VMMA/Focalizacion/Salidas_pruebas")
VEREDAS = ENTRADA / "veredas.gpkg"
SALIDA = ENTRADA / "web_focalizacion"   # carpeta del sitio (la que se sube a GitHub)

RASTERS = [
    # archivo, id corto, nombre visible, nombre corto (tablas)
    ("CAZ2_consolidacion.tif", "caz2", "Consolidación (CAZ2)", "CAZ2"),
    ("ABF_expansion_nucleos.tif", "abf_exp", "Expansión de núcleos (ABF)", "ABF expansión"),
    ("ABF_reconexion_matriz.tif", "abf_rec", "Reconexión de matriz (ABF)", "ABF reconexión"),
]
COBERTURAS = "Estadisticas_coberturas_Cachicamo.gpkg"
COL_COB = "cob_agrup_"
COL_VEREDA = "NOMBRE_VER"
COL_MPIO = "NOMB_MPIO"
COL_COD = "CODIGO_VER"

COLORES_COB = {
    "Bosques": "#0f4a2a",
    "Arbustales": "#7a8f3c",
    "Vegetación secundaria": "#8cc56b",
    "Herbazales": "#c9d36a",
    "Pastizales": "#f1d77a",
    "Cultivos": "#e39a4c",
    "Territorios artificializados": "#c2453a",
    "Tierras degradadas": "#8a5a3c",
    "Áreas abiertas con poca vegetación": "#d8c3a5",
    "Superficies de agua": "#2f6fbf",
    "Áreas húmedas": "#4fb3bf",
}
COLOR_DEFECTO = "#9a9a9a"


def guardar_gz(ruta, arr):
    with gzip.open(ruta, "wb", compresslevel=9) as f:
        f.write(np.ascontiguousarray(arr).tobytes())
    return ruta.stat().st_size


def main(entrada, veredas_path, salida):
    datos = salida / "data"
    datos.mkdir(parents=True, exist_ok=True)

    # --- Malla de referencia (primer ráster) ---------------------------------
    with rasterio.open(entrada / RASTERS[0][0]) as ref:
        src_crs, src_tf = ref.crs, ref.transform
        src_w, src_h = ref.width, ref.height
        src_bounds = ref.bounds

    dst_crs = "EPSG:3857"
    dst_tf, dst_w, dst_h = calculate_default_transform(
        src_crs, dst_crs, src_w, src_h, *src_bounds, resolution=30
    )
    print(f"Malla web: {dst_w} x {dst_h} px, EPSG:3857 a 30 m")

    def a_web(arr, nodata, dtype):
        out = np.full((dst_h, dst_w), nodata, dtype=dtype)
        reproject(arr, out, src_transform=src_tf, src_crs=src_crs,
                  dst_transform=dst_tf, dst_crs=dst_crs,
                  src_nodata=nodata, dst_nodata=nodata,
                  resampling=Resampling.nearest)
        return out

    meta = {"grid": {}, "rasters": [], "coberturas": [], "veredas": []}

    # --- Rásters de prioridad ------------------------------------------------
    for archivo, rid, nombre, corto in RASTERS:
        with rasterio.open(entrada / archivo) as s:
            if s.shape != (src_h, src_w) or s.transform != src_tf:
                raise ValueError(f"{archivo} no comparte la malla de {RASTERS[0][0]}")
            a = s.read(1).astype("float32")
        valido = np.isfinite(a)
        if s.nodata is not None and np.isfinite(s.nodata):
            valido &= a != s.nodata
        q = np.zeros(a.shape, dtype="uint16")
        q[valido] = (np.clip(a[valido], 0, 1) * 65534).round().astype("uint16") + 1
        qw = a_web(q, 0, "uint16")
        tam = guardar_gz(datos / f"{rid}.u16.gz", qw)
        meta["rasters"].append({"id": rid, "archivo": archivo, "nombre": nombre, "corto": corto,
                                "file": f"data/{rid}.u16.gz"})
        print(f"  {archivo}: {int((qw > 0).sum())} px válidos, {tam/1e6:.1f} MB")

    # --- Coberturas ----------------------------------------------------------
    cob = gpd.read_file(entrada / COBERTURAS).to_crs(src_crs)
    cob = cob.sort_values(COL_COB).reset_index(drop=True)
    cob_codes = rasterize(
        ((g, i + 1) for i, g in enumerate(cob.geometry) if g is not None and not g.is_empty),
        out_shape=(src_h, src_w), transform=src_tf, fill=0, dtype="uint8")
    cw = a_web(cob_codes, 0, "uint8")
    tam = guardar_gz(datos / "coberturas.u8.gz", cw)
    print(f"  coberturas: {len(cob)} clases, {tam/1e6:.1f} MB")

    cols_est = [c for c in cob.columns if c not in ("geometry", COL_COB)]
    for i, fila in cob.iterrows():
        nombre = fila[COL_COB]
        est = {c: (None if fila[c] is None or (isinstance(fila[c], float) and np.isnan(fila[c]))
                   else float(fila[c])) for c in cols_est}
        meta["coberturas"].append({"code": i + 1, "nombre": nombre,
                                   "color": COLORES_COB.get(nombre, COLOR_DEFECTO),
                                   "stats": est})

    # --- Veredas -------------------------------------------------------------
    ver = gpd.read_file(veredas_path).to_crs(src_crs)
    ver["geometry"] = ver.geometry.make_valid()
    ver = ver.sort_values(COL_VEREDA).reset_index(drop=True)
    ver["vid"] = np.arange(1, len(ver) + 1)
    ver_ids = rasterize(((g, int(v)) for g, v in zip(ver.geometry, ver["vid"])),
                        out_shape=(src_h, src_w), transform=src_tf, fill=0, dtype="uint8")
    vw = a_web(ver_ids, 0, "uint8")
    tam = guardar_gz(datos / "veredas.u8.gz", vw)
    print(f"  veredas: {len(ver)} veredas, {tam/1e6:.2f} MB")

    for _, f in ver.iterrows():
        meta["veredas"].append({"vid": int(f["vid"]), "nombre": str(f[COL_VEREDA]).title(),
                                "municipio": str(f.get(COL_MPIO, "")).title(),
                                "codigo": str(f.get(COL_COD, "")),
                                "area_ha": round(float(f.geometry.area) / 1e4, 1)})

    ver_web = ver[["vid", COL_VEREDA, "geometry"]].copy()
    ver_web["geometry"] = ver_web.geometry.simplify(5)
    ver_web = ver_web.rename(columns={COL_VEREDA: "nombre"})
    ver_web["nombre"] = ver_web["nombre"].str.title()
    ver_web.to_crs(4326).to_file(datos / "veredas.geojson", driver="GeoJSON",
                                 COORDINATE_PRECISION=6)

    # --- Metadatos de la malla -----------------------------------------------
    x0, y0 = dst_tf.c, dst_tf.f
    res = dst_tf.a
    x1, y1 = x0 + dst_w * res, y0 - dst_h * res
    w, s, e, n = transform_bounds(dst_crs, "EPSG:4326", x0, y1, x1, y0)
    meta["grid"] = {"width": dst_w, "height": dst_h, "res": res,
                    "x0": x0, "y0": y0, "x1": x1, "y1": y1,
                    "bounds_latlon": [[s, w], [n, e]], "escala_u16": 65534}

    with open(datos / "meta.json", "w", encoding="utf-8") as fh:
        json.dump(meta, fh, ensure_ascii=False)
    (salida / ".nojekyll").touch()
    print(f"\nListo. Datos en {datos}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--entrada", type=Path, default=ENTRADA)
    ap.add_argument("--veredas", type=Path, default=VEREDAS)
    ap.add_argument("--salida", type=Path, default=SALIDA)
    a = ap.parse_args()
    main(a.entrada, a.veredas, a.salida)
