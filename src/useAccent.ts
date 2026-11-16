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
    const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
    if (!dominant) return FALLBACK;
    const rgb = [dominant.r, dominant.g, dominant.b].map((v) => v / dominant.count);
    const luminance = (values: number[]) => {
      const linear = values.map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };
    let mix = 0;
    while (luminance(rgb.map((v) => v + (255 - v) * mix)) < 0.175 && mix < 1) mix += 0.01;
    return `#${rgb.map((v) => Math.round(v + (255 - v) * mix).toString(16).padStart(2, "0")).join("")}`;
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
