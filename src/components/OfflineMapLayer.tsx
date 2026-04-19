import { useEffect, useRef } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import { tileStore, getCacheKey } from '../lib/offlineMaps';

const OfflineCapableTileLayer = L.TileLayer.extend({
  createTile(coords: any, done: any) {
    const tile = document.createElement('img');
    tile.alt = '';
    tile.setAttribute('role', 'presentation');

    const key = getCacheKey(coords.z, coords.x, coords.y);
    const url = this.getTileUrl(coords); 
    const setBlobTile = (blob: Blob) => {
      const objectUrl = URL.createObjectURL(blob);
      const revoke = () => URL.revokeObjectURL(objectUrl);
      tile.addEventListener('load', revoke, { once: true });
      tile.addEventListener('error', revoke, { once: true });
      tile.src = objectUrl;
      done(null, tile);
    };

    // Try finding tile in offline storage first
    tileStore.getItem<Blob>(key).then((blob) => {
      if (blob) {
        setBlobTile(blob);
      } else {
        // Fallback to network
        fetch(url, { mode: 'cors' })
          .then(res => {
            if (!res.ok) throw new Error('Fetch failed');
            return res.blob();
          })
          .then(b => {
             // Save to cache for future offline usage (Auto-Caching)
            tileStore.setItem(key, b).catch(() => {});
            setBlobTile(b);
          })
          .catch(err => {
            done(err, tile);
          });
      }
    }).catch(() => {
      // In case IndexedDB fails, try normally
      tile.src = url;
      done(null, tile);
    });

    return tile;
  }
});

export default function OfflineMapLayer({ url, attribution }: { url: string, attribution: string }) {
  const map = useMap();
  const layerRef = useRef<any>(null);

  useEffect(() => {
    const LayerClass = OfflineCapableTileLayer as any;
    const layer = new LayerClass(url, { attribution, maxNativeZoom: 19, maxZoom: 22, crossOrigin: true });
    layerRef.current = layer;
    layer.addTo(map);

    return () => {
      if (layerRef.current) map.removeLayer(layerRef.current);
      layerRef.current = null;
    };
  }, [map, url, attribution]);

  return null;
}
