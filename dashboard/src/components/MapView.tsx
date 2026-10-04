import { useMemo, useState } from 'react'
import MapGL, { Layer, Source, type MapLayerMouseEvent } from 'react-map-gl/maplibre'
import { setWorkerUrl } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { GraphResponse } from '../api/types'
import { PRIORITY, hasDirectCase } from '../lib/priority'

// MapLibre 6 busca su worker junto a su propio archivo. En el build de producción Vite no lo copia
// y el servidor devuelve index.html en su lugar (mapa negro). Con ?worker&url Vite lo empaqueta junto con
// sus imports y aquí se le dice a MapLibre dónde quedó.
setWorkerUrl(workerUrl)

// Mapa base oscuro gratuito y sin API key (OpenFreeMap).
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/dark'

type Props = {
  graph: GraphResponse
  selectedId: string | null
  onSelect: (id: string | null) => void
}

export function MapView({ graph, selectedId, onSelect }: Props) {
  const [cursor, setCursor] = useState('')

  const nodes = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: graph.nodes.map((n) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [n.longitude, n.latitude] },
        properties: {
          id: n.id,
          label: n.label,
          priority: n.inspection_priority,
          priorityLabel: PRIORITY[n.inspection_priority].label,
          direct: hasDirectCase(n.local_case_status),
          selected: n.id === selectedId,
        },
      })),
    }),
    [graph, selectedId],
  )

  const edges = useMemo(() => {
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    return {
      type: 'FeatureCollection' as const,
      features: graph.edges.flatMap((e) => {
        const a = byId.get(e.source)
        const b = byId.get(e.target)
        if (!a || !b) return []
        return [{
          type: 'Feature' as const,
          geometry: { type: 'LineString' as const, coordinates: [[a.longitude, a.latitude], [b.longitude, b.latitude]] },
          properties: { id: e.id, exposure: e.exposure_strength !== null, strength: e.exposure_strength ?? 0 },
        }]
      }),
    }
  }, [graph])

  const onClick = (e: MapLayerMouseEvent) => {
    const id = e.features?.[0]?.properties?.id
    onSelect(id ? String(id) : null)
  }

  return (
    <MapGL
      initialViewState={{ longitude: -96.95, latitude: 19.3, zoom: 9.2 }}
      mapStyle={MAP_STYLE}
      style={{ position: 'absolute', inset: 0 }}
      interactiveLayerIds={['nodes']}
      onClick={onClick}
      onMouseEnter={() => setCursor('pointer')}
      onMouseLeave={() => setCursor('')}
      cursor={cursor}
      attributionControl={{ compact: true }}
    >
      <Source id="edges" type="geojson" data={edges}>
        {/* Solo similitud ambiental: punteada y gris. Nunca se dibuja como contagio. */}
        <Layer
          id="edges-similarity"
          type="line"
          filter={['==', ['get', 'exposure'], false]}
          paint={{ 'line-color': '#3E4A59', 'line-width': 1.2, 'line-dasharray': [2, 2] }}
        />
        {/* Exposición a un caso fuente activo: sólida, opacidad según exposure_strength. */}
        <Layer
          id="edges-exposure"
          type="line"
          filter={['==', ['get', 'exposure'], true]}
          paint={{
            'line-color': PRIORITY.high.color,
            'line-width': 2,
            'line-opacity': ['interpolate', ['linear'], ['get', 'strength'], 0, 0.35, 1, 0.95],
          }}
        />
      </Source>

      <Source id="nodes" type="geojson" data={nodes}>
        {/* Halo difuso por prioridad: da profundidad y destaca las parcelas urgentes. */}
        <Layer
          id="nodes-glow"
          type="circle"
          paint={{
            'circle-radius': ['match', ['get', 'priority'], 'high', 26, 'medium', 20, 14],
            'circle-color': [
              'match', ['get', 'priority'],
              'high', PRIORITY.high.color,
              'medium', PRIORITY.medium.color,
              'low', PRIORITY.low.color,
              PRIORITY.unknown.color,
            ],
            'circle-opacity': ['match', ['get', 'priority'], 'high', 0.28, 'medium', 0.2, 0.12],
            'circle-blur': 1,
          }}
        />
        {/* Anillo claro = la parcela tiene un reporte directo (no solo exposición). */}
        <Layer
          id="nodes-direct"
          type="circle"
          filter={['==', ['get', 'direct'], true]}
          paint={{ 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#E6EDF3', 'circle-stroke-width': 1.5 }}
        />
        <Layer
          id="nodes"
          type="circle"
          paint={{
            'circle-radius': ['case', ['get', 'selected'], 11, 8],
            'circle-color': [
              'match', ['get', 'priority'],
              'high', PRIORITY.high.color,
              'medium', PRIORITY.medium.color,
              'low', PRIORITY.low.color,
              PRIORITY.unknown.color,
            ],
            'circle-stroke-color': ['case', ['get', 'selected'], '#34D399', '#0B0E13'],
            'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
          }}
        />
        {/* Etiqueta de texto además del color, por accesibilidad. */}
        <Layer
          id="nodes-label"
          type="symbol"
          layout={{
            'text-field': ['concat', ['get', 'label'], '\n', ['get', 'priorityLabel']],
            'text-font': ['Noto Sans Regular'],
            'text-size': 11.5,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
          }}
          paint={{ 'text-color': '#E6EDF3', 'text-halo-color': '#0B0E13', 'text-halo-width': 1.75, 'text-halo-blur': 0.5 }}
        />
      </Source>
    </MapGL>
  )
}
