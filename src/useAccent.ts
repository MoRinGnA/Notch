import { useEffect, useState } from "react";

const FALLBACK = "#F4F4F6";
const cache = new Map<string, string>();

function readableColor(image: HTMLImageElement): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return FALLBACK;
    context.drawImage(image, 0, 0, 16, 16);
    const pixels = context.getImageData(0, 0, 16, 16).data;
    const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b, alpha] = pixels.subarray(i, i + 4);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (alpha < 200 || max < 55 || min > 235 || max - min < 35) continue;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
      bucket.count++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
    }
    const toHsl = (bucket: { count: number; r: number; g: number; b: number }) => {
      const [r, g, b] = [bucket.r, bucket.g, bucket.b].map((v) => v / bucket.count / 255);
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const delta = max - min;
      const lightness = (max + min) / 2;
      const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
      const hue = delta === 0 ? 0 : max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
      return { hue: hue * 60, saturation, lightness };
    };
    const candidates = [...buckets.values()].map((bucket) => ({ bucket, ...toHsl(bucket) }));
    const saturated = candidates.filter((candidate) => candidate.saturation >= 0.45);
    const dominant = (saturated.length ? saturated : candidates).sort((a, b) => b.bucket.count - a.bucket.count)[0];
    if (!dominant) return FALLBACK;
    const saturation = Math.max(0.45, dominant.saturation);
    const lightness = Math.min(0.8, Math.max(0.72, dominant.lightness));
    return `hsl(${dominant.hue.toFixed(1)} ${(saturation * 100).toFixed(1)}% ${(lightness * 100).toFixed(1)}%)`;
  } catch {
    return FALLBACK;
  }
}

export function useAccent(src: string): string {
  const [accent, setAccent] = useState(FALLBACK);
  useEffect(() => {
    if (!src) {
      setAccent(FALLBACK);
      return;
    }
    const cached = cache.get(src);
    if (cached) {
      setAccent(cached);
      return;
    }
    let cancelled = false;
    setAccent(FALLBACK);
    const image = new Image();
    image.onload = () => {
      const color = readableColor(image);
      cache.set(src, color);
      if (!cancelled) setAccent(color);
    };
    image.onerror = () => {
      cache.set(src, FALLBACK);
      if (!cancelled) setAccent(FALLBACK);
    };
    image.src = src;
    return () => { cancelled = true; };
  }, [src]);
  return accent;
}
