import { useCallback, useRef } from 'react';

export interface VoiceMetrics {
  direction: string;
  qualityOk: boolean;
  qualityReason: string;
  error: number;
  deltaNorth: number;
  deltaEast: number;
}

interface Options {
  enabled: boolean;
  /** 0 = nokta stakeout (yönlü anlatım), >0 = radyal mesafe (ileri/geri) */
  targetDistance: number;
}

/**
 * Sesli yönlendirme — direction durumu değiştiğinde veya zamanlayıcı dolduğunda konuşur.
 * Spama engel olmak için: yön değişmezse her 4 saniyede bir, değişirse 1.5 saniyede bir.
 */
export function useVoiceGuidance({ enabled, targetDistance }: Options) {
  const lastSpokenRef = useRef<number>(0);
  const lastDirectionRef = useRef<string>('');

  const speak = useCallback((metrics: VoiceMetrics) => {
    if (!enabled || typeof window === 'undefined' || !('speechSynthesis' in window)) return;

    if (!metrics.qualityOk) {
      if (lastDirectionRef.current !== 'QUALITY_WAIT') {
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(`Konum kalitesi yetersiz. ${metrics.qualityReason}`);
        utterance.lang = 'tr-TR';
        utterance.rate = 1.05;
        window.speechSynthesis.speak(utterance);
        lastDirectionRef.current = 'QUALITY_WAIT';
        lastSpokenRef.current = Date.now();
      }
      return;
    }

    const now = Date.now();
    let shouldSpeak = false;
    let message = '';
    const absError = Math.abs(metrics.error);

    if (metrics.direction === 'OK' && lastDirectionRef.current !== 'OK') {
      shouldSpeak = true;
      message = 'Hedef tamam. Noktayı atabilirsiniz.';
    } else if (metrics.direction !== 'OK') {
      const timeThreshold = metrics.direction === lastDirectionRef.current ? 4000 : 1500;
      if (now - lastSpokenRef.current > timeThreshold) {
        shouldSpeak = true;

        let dirText = '';
        if (targetDistance === 0) {
          const nOrS = metrics.deltaNorth >= 0 ? 'Kuzey' : 'Güney';
          const eOrW = metrics.deltaEast >= 0 ? 'Doğu' : 'Batı';
          if (Math.abs(metrics.deltaNorth) > 2 * Math.abs(metrics.deltaEast)) dirText = nOrS;
          else if (Math.abs(metrics.deltaEast) > 2 * Math.abs(metrics.deltaNorth)) dirText = eOrW;
          else dirText = `${nOrS} ${eOrW}`;

          if (metrics.direction === 'RECEDING') {
            dirText = 'Yanlış yön. ' + dirText + ' yönüne dönün,';
          }
        } else {
          if (metrics.direction === 'FORWARD') dirText = 'İleri';
          else if (metrics.direction === 'BACK') dirText = 'Geri';
        }

        if (absError >= 1000) message = `${dirText} ${(absError / 1000).toFixed(1)} kilometre`;
        else if (absError >= 1) message = `${dirText} ${absError.toFixed(1)} metre`;
        else if (absError > 0) message = `${dirText} ${Math.round(absError * 1000)} milimetre`;
        else message = `${dirText} 0 metre`;
      }
    }

    if (shouldSpeak && message) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.lang = 'tr-TR';
      utterance.rate = 1.1;
      utterance.pitch = 1.0;
      window.speechSynthesis.speak(utterance);
      lastSpokenRef.current = now;
      lastDirectionRef.current = metrics.direction;
    }
  }, [enabled, targetDistance]);

  return { speak, lastDirectionRef };
}
