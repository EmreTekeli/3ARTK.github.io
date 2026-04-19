import localforage from 'localforage';
import L from 'leaflet';

export const tileStore = localforage.createInstance({
  name: 'slopefix-map-tiles'
});

export const getCacheKey = (z: number, x: number, y: number) => `${z}/${x}/${y}`;

export function lon2tile(lon: number, zoom: number) {
  return (Math.floor((lon + 180) / 360 * Math.pow(2, zoom)));
}

export function lat2tile(lat: number, zoom: number) {
  return (Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * Math.pow(2, zoom)));
}

export function generateTileCoordsForBounds(bounds: L.LatLngBounds, minZoom: number, maxZoom: number) {
  const coords: {z: number, x: number, y: number}[] = [];

  for (let z = minZoom; z <= maxZoom; z++) {
    const top = bounds.getNorth();
    const bottom = bounds.getSouth();
    const left = bounds.getWest();
    const right = bounds.getEast();

    const xMin = lon2tile(left, z);
    const xMax = lon2tile(right, z);
    const yMin = lat2tile(top, z);
    const yMax = lat2tile(bottom, z);

    const x1 = Math.min(xMin, xMax);
    const x2 = Math.max(xMin, xMax);
    const y1 = Math.min(yMin, yMax);
    const y2 = Math.max(yMin, yMax);

    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        coords.push({ z, x, y });
      }
    }
  }
  return coords;
}
