# Focalización Cachicamo: visor web

Sitio estático para GitHub Pages. No necesita servidor ni compilación.

## Publicar en GitHub Pages
1. Crea un repositorio y sube **todo el contenido de esta carpeta** a la raíz (incluido `.nojekyll`).
2. En el repositorio: *Settings → Pages → Build and deployment → Deploy from a branch*, rama `main`, carpeta `/ (root)`.
3. En uno o dos minutos queda en `https://<usuario>.github.io/<repositorio>/`.

## Probar en local
Los datos se cargan con `fetch`, así que no funciona abriendo `index.html` con doble clic:

    python -m http.server 8000

y abrir http://localhost:8000

## Actualizar los datos
Ajusta las rutas al inicio de `preparar_datos_web.py` y ejecútalo (PyCharm o consola).
Regenera la carpeta `data/`; luego sube los cambios al repositorio.

## Estructura
- `index.html`, `styles.css`, `app.js`: la aplicación
- `lib/`: Leaflet 1.9.4, Chart.js 4.4.1, fflate 0.8.2 y la fuente Public Sans (incluidas, sin CDN)
- `data/`: rásters cuantizados (uint16, malla EPSG:3857 a 30 m), coberturas, veredas y metadatos
