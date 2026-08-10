# Ruteador Vicente López · Martínez

Aplicación web local para cargar una cantidad abierta de domicilios, ordenar un recorrido eficiente en auto y regresar al punto fijo:

**Juan Bautista Alberdi 1150, Olivos, Vicente López, Buenos Aires**

## Área operativa

El mapa y la validación de domicilios están acotados por el área operativa corregida, basada en:

- vías del Ferrocarril Belgrano Norte (oeste),
- Río de la Plata (este),
- Av. Márquez / sector Hipódromo de San Isidro (norte),
- Av. General Paz (sur).

El corredor **incluye Martínez y el sector al sur de Av. Márquez**, aunque administrativamente parte del área pertenezca al partido de San Isidro. El borde visible del mapa se muestra en rojo y la validación de domicilios utiliza exactamente ese mismo polígono.

## Ejecutar

Requiere **Node.js 18 o superior**.

```bash
cd ruteador-vicente-lopez
node server.js
```

Abrir después:

```text
http://127.0.0.1:3000
```

No hace falta `npm install`: el servidor usa solamente módulos nativos de Node.

## Cómo funciona

1. Pegás una dirección por línea o importás TXT/CSV.
2. El backend geocodifica los domicilios dentro del área sin forzar la localidad “Vicente López”, por lo que acepta correctamente Martínez, Acassuso y San Isidro dentro del corredor.
3. Para conjuntos de hasta 69 paradas + base intenta utilizar una matriz de tiempos viales de OSRM y mejora el orden con 2-opt.
4. Para conjuntos mayores usa una heurística geográfica escalable y 2-opt.
5. La ruta final siempre se solicita como ruta de auto y se divide en bloques para soportar listas grandes.
6. El recorrido empieza y termina en Juan Bautista Alberdi 1150.
7. Al terminar, genera enlaces de Google Maps con las paradas ya ordenadas. Cada enlace usa hasta 10 ubicaciones totales (1 origen + hasta 9 paradas, incluyendo el destino final); si el recorrido supera ese tamaño, genera tramos consecutivos sin perder el orden.

## Importante sobre “sin límite de direcciones”

La aplicación **no tiene un máximo artificial de paradas**. Sin embargo, la configuración gratuita incluida usa servicios públicos de Nominatim y OSRM, que tienen políticas de uso y capacidad práctica. Para operación intensiva o comercial conviene desplegar instancias propias y configurar:

```bash
NOMINATIM_URL=https://tu-nominatim.example \
OSRM_URL=https://tu-osrm.example \
node server.js
```

También podés definir `PORT`, `HOST` y `GEOCODER_USER_AGENT`.

## Precisión del límite

En la versión 1.3 el límite fue corregido siguiendo la referencia marcada en rojo por el usuario: se eliminó la diagonal incorrecta que atravesaba Lomas de San Isidro/Martínez Oeste, se llevó el borde occidental hacia la traza indicada del Belgrano Norte y se ajustó el borde oriental para acompañar la costa en vez de extenderse dentro del Río de la Plata.
