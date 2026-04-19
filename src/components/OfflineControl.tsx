import React, { useState } from 'react';
import { useMap } from 'react-leaflet';
import { CloudDownload, Trash2 } from 'lucide-react';
import { tileStore, generateTileCoordsForBounds, getCacheKey } from '../lib/offlineMaps';

export default function OfflineControl() {
   const map = useMap();
   const [isDownloading, setIsDownloading] = useState(false);
   const [progress, setProgress] = useState(0);

   const handleDownload = async () => {
      const bounds = map.getBounds();
      const currentZoom = map.getZoom();
      const maxZoom = Math.min(currentZoom + 4, 19); 

      const coords = generateTileCoordsForBounds(bounds, currentZoom, maxZoom);

      if (coords.length > 8000) {
         alert('Seçili alan çok büyük. Lütfen haritaya biraz daha yaklaşın.');
         return;
      }

      if(!window.confirm(`Mevcut alan ve yakınlaştırma seviyeleri için ${coords.length} adet harita karosu indirilecek. Onaylıyor musunuz? (Çevrimdışı kullanım için)`)) return;

      setIsDownloading(true);
      setProgress(0);

      let downloaded = 0;
      for (let i = 0; i < coords.length; i+=10) {
          const chunk = coords.slice(i, i+10);
          await Promise.all(chunk.map(async (coord) => {
              const key = getCacheKey(coord.z, coord.x, coord.y);
              const exists = await tileStore.getItem(key);
              if(!exists) {
                  try {
                      const url = `https://a.tile.openstreetmap.org/${coord.z}/${coord.x}/${coord.y}.png`;
                      const res = await fetch(url, { mode: 'cors' });
                      if(res.ok) {
                          const blob = await res.blob();
                          await tileStore.setItem(key, blob).catch(()=>{});
                      }
                  } catch(e) {}
              }
              downloaded++;
          }));
          setProgress((downloaded / coords.length) * 100);
      }

      setIsDownloading(false);
      alert('Harita verileri başarıyla cihaza kaydedildi. İnternet yokken bile bu alanı görebilirsiniz.');
   };

   const handleClearCache = async () => {
      if(window.confirm('Cihaza kaydedilen tüm çevrimdışı haritalar silinecek. Emin misiniz?')) {
         await tileStore.clear();
         alert('Önbellek temizlendi.');
      }
   };

   return (
      <div className="absolute top-4 right-4 z-[400] flex flex-col gap-2">
         <button 
           onClick={handleDownload} 
           disabled={isDownloading} 
           className="bg-slate-900/90 hover:bg-slate-800 text-white p-2.5 rounded-xl shadow-lg border border-slate-700 flex items-center justify-center transition-all disabled:opacity-50" 
           title="Bu Alanı Çevrimdışı Kaydet"
         >
            {isDownloading ? (
               <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin"></div>
            ) : (
               <CloudDownload className="w-5 h-5 text-indigo-400" />
            )}
         </button>
         {!isDownloading && (
             <button 
               onClick={handleClearCache} 
               className="bg-slate-900/90 hover:bg-slate-800 text-white p-2.5 rounded-xl shadow-lg border border-slate-700 flex items-center justify-center transition-all" 
               title="Çevrimdışı Haritaları Sil (Önbelleği Temizle)"
             >
                <Trash2 className="w-5 h-5 text-rose-400" />
             </button>
         )}
         {isDownloading && (
            <div className="bg-slate-900/90 border border-slate-700 rounded-lg px-3 py-1.5 text-xs font-bold text-white shadow-lg mx-auto whitespace-nowrap">
               %{progress.toFixed(0)}
            </div>
         )}
      </div>
   );
}
