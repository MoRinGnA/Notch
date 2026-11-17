import fs from "node:fs";
import path from "node:path";
import type { AudioBridge } from "./audio-bridge";
import { CtcAligner, type AlignLang } from "./align";

export interface AlignLine {
  time: number;
  text: string;
}

export interface AlignEvent {
  key: string;
  state: "working" | "ready" | "failed";
  lines: AlignLine[];
}

// 렌더러가 넘기는 가사. LRCLIB 싱크 가사가 있으면 시각을 함께 준다.
export interface AlignSeedLine {
  text: string;
  time?: number;
}

export interface AlignRequest {
  key: string;
  lines: AlignSeedLine[];
  lang: AlignLang;
  position: number;
}

interface SessionLine {
  text: string;
  time: number | null;
  // LRCLIB가 준 원래 시각. 정렬이 이에서 얼마나 벗어났는지 비교하는 데 쓴다.
  seed: number | null;
}

interface Session {
  key: string;
  lang: AlignLang;
  lines: SessionLine[];
  // 다음에 정렬할 줄. 앞쪽 줄은 이미 시각이 확정됐거나 이미 지난 줄이다.
  nextLine: number;
  position: number;
  file: string;
  rate: number;
  bytesRead: number;
  startedAt: number;
  cursorSample: number;
  failures: number;
  mismatch: number;
  // 재앵커링 중에는 캡처를 다시 만들기 전까지 파일을 읽지 않는다.
  reanchoring: boolean;
}

const CHUNK_LINES = 4;
const MIN_WINDOW_SECONDS = 3.5;
const EMIT_MARGIN_SECONDS = 1.4;
const LOOKAHEAD_SKIP_SECONDS = 26;
const TICK_MS = 2500;
const MAX_START_SKEW_SECONDS = 8;
// 이보다 조용하면 정지·음소거 구간으로 본다. 여기서 시각을 만들면 가사가 망가진다.
const MIN_RMS = 0.002;
// 판본 차이는 "모든 줄이 같은 값만큼" 밀리는 형태다. 줄마다 벌어지면 가사와 오디오가 다른 것이라
// 교정을 채택하지 않고 LRCLIB 시각을 그대로 둔다.
const MAX_DEVIATION_SPREAD_SECONDS = 4;
const MAX_MISMATCHES = 2;

// 16kHz로 다시 샘플링한다. 청크 경계에서 위상이 끊기지 않게 남은 샘플을 들고 간다.
class Downsampler {
  private pending = new Float32Array(0);
  private position = 0;

  push(input: Float32Array, rate: number): Float32Array {
    if (rate === 16000) return input;
    const merged = new Float32Array(this.pending.length + input.length);
    merged.set(this.pending, 0);
    merged.set(input, this.pending.length);
    const ratio = rate / 16000;
    const out: number[] = [];
    let pos = this.position;
    while (pos + 1 < merged.length) {
      const i0 = Math.floor(pos);
      const t = pos - i0;
      out.push(merged[i0] * (1 - t) + merged[i0 + 1] * t);
      pos += ratio;
    }
    const consumed = Math.floor(pos);
    this.pending = merged.slice(Math.min(consumed, merged.length));
    this.position = pos - consumed;
    return Float32Array.from(out);
  }
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export function createLyricsSync(options: {
  bridge: () => AudioBridge;
  aligner: CtcAligner;
  tempDir: string;
  emit: (event: AlignEvent) => void;
}) {
  let session: Session | null = null;
  let timer: NodeJS.Timeout | null = null;
  let samples = new Float32Array(0);
  let downsampler = new Downsampler();
  let busy = false;

  const clear = () => {
    if (timer) clearInterval(timer);
    timer = null;
    const current = session;
    session = null;
    samples = new Float32Array(0);
    downsampler = new Downsampler();
    if (!current) return;
    void options.bridge().endCapture().catch(() => 0);
    try {
      fs.unlinkSync(current.file);
    } catch {
      // 이미 지웠거나 캡처가 잡고 있으면 무시한다.
    }
  };

  // 확정된 줄만 내보낸다. 시각이 없는 줄은 렌더러의 LRCLIB 가사를 그대로 두게 한다.
  const snapshot = (current: Session): AlignLine[] => {
    const lines: AlignLine[] = [];
    for (const line of current.lines) {
      if (line.time === null) continue;
      lines.push({ time: line.time, text: line.text });
    }
    return lines.sort((a, b) => a.time - b.time);
  };

  // 캡처 파일에서 아직 읽지 않은 부분만 s16le로 읽어 16kHz 모노로 쌓는다.
  const appendAudio = (current: Session) => {
    let size = 0;
    try {
      size = fs.statSync(current.file).size;
    } catch {
      return;
    }
    if (size <= current.bytesRead) return;
    const length = size - current.bytesRead;
    const buffer = Buffer.allocUnsafe(length);
    const fd = fs.openSync(current.file, "r");
    try {
      fs.readSync(fd, buffer, 0, length, current.bytesRead);
    } finally {
      fs.closeSync(fd);
    }
    current.bytesRead = size;
    const frames = Math.floor(length / 2);
    const chunk = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) chunk[i] = buffer.readInt16LE(i * 2) / 32768;
    const resampled = downsampler.push(chunk, current.rate);
    if (resampled.length === 0) return;
    const merged = new Float32Array(samples.length + resampled.length);
    merged.set(samples, 0);
    merged.set(resampled, samples.length);
    samples = merged;
  };

  // 창 안의 가사 줄들을 한 번에 정렬하고, 충분히 지난 줄만 확정한다.
  const alignWindow = async (current: Session) => {
    if (current.nextLine >= current.lines.length) return;
    const chunks = current.lines.slice(current.nextLine, current.nextLine + CHUNK_LINES);
    if (chunks.length === 0) return;

    const windowStartSample = current.cursorSample;
    const audio = samples.subarray(windowStartSample);
    if (audio.length < 16000 * MIN_WINDOW_SECONDS) return;
    const limit = Math.min(audio.length, 30 * 16000);
    const windowSeconds = limit / 16000;

    // 정지·음소거 구간에는 시각을 만들지 않고 그대로 기다린다.
    if (rms(audio.subarray(0, limit)) < MIN_RMS) return;

    const baseTime = current.position + windowStartSample / 16000;
    const joined = chunks.map((line) => line.text).join("\n");
    const spans = await options.aligner.align(audio, joined, current.lang);
    if (!spans) return;

    // 줄마다 앞선 줄들의 토큰 수를 더해 시작 토큰 위치를 구한다.
    const offsets: number[] = [];
    let prefix = "";
    for (const line of chunks) {
      offsets.push(await options.aligner.tokenizeCount(prefix, current.lang));
      prefix = prefix ? `${prefix}\n${line.text}` : line.text;
    }

    // 확정할 줄들의 시각을 먼저 모은다.
    const emitted: { index: number; time: number; sample: number }[] = [];
    for (let i = 0; i < chunks.length; i += 1) {
      const span = spans[offsets[i]];
      if (!span) continue;
      const time = baseTime + span.start;
      if (time > baseTime + windowSeconds - EMIT_MARGIN_SECONDS) break;
      emitted.push({ index: current.nextLine + i, time, sample: windowStartSample + Math.round(span.start * 16000) });
    }
    // 교정은 "전체가 같은 값만큼 이동"일 때만 받아들인다.
    const deviations: number[] = [];
    for (const line of emitted) {
      const seed = current.lines[line.index].seed;
      if (seed !== null) deviations.push(line.time - seed);
    }
    if (deviations.length >= 3) {
      deviations.sort((a, b) => a - b);
      const spread = deviations[deviations.length - 1] - deviations[0];
      if (spread > MAX_DEVIATION_SPREAD_SECONDS) {
        current.mismatch += 1;
        current.cursorSample = windowStartSample + Math.round(windowSeconds * 16000);
        if (current.mismatch >= MAX_MISMATCHES) {
          options.emit({ key: current.key, state: "failed", lines: snapshot(current) });
          clear();
        }
        return;
      }
      current.mismatch = 0;
    }
    if (emitted.length === 0) {
      // 노래가 나오지 않는 구간이 길면 창을 버리고 뒤에서 다시 잡는다.
      if (windowSeconds >= LOOKAHEAD_SKIP_SECONDS) {
        current.cursorSample = windowStartSample + Math.round(LOOKAHEAD_SKIP_SECONDS * 16000);
      }
      return;
    }

    for (const line of emitted) {
      current.lines[line.index] = { ...current.lines[line.index], time: line.time };
    }
    const last = emitted[emitted.length - 1];
    current.nextLine = last.index + 1;
    current.cursorSample = last.sample;
    const done = current.nextLine >= current.lines.length;
    options.emit({ key: current.key, state: done ? "ready" : "working", lines: snapshot(current) });
  };

  const tick = async () => {
    const current = session;
    if (!current || busy || current.reanchoring) return;
    busy = true;
    try {
      appendAudio(current);
      await alignWindow(current);
      current.failures = 0;
      // 커서 뒤쪽만 남겨 메모리를 묶어 둔다.
      if (current.cursorSample > 16000 * 45) {
        samples = samples.slice(current.cursorSample);
        current.cursorSample = 0;
      }
    } catch {
      current.failures += 1;
      if (current.failures >= 3) {
        options.emit({ key: current.key, state: "failed", lines: snapshot(current) });
        clear();
      }
    } finally {
      busy = false;
    }
  };

  return {
    async start(request: AlignRequest) {
      clear();
      const debug = (message: string) => {
        if (!process.env.NOTCH_ALIGN_DEBUG) return;
        try {
          fs.appendFileSync(path.join(options.tempDir, "notch-align-debug.log"), `${new Date().toISOString()} ${message}\n`);
        } catch {
          // 진단 로그는 실패해도 무시한다.
        }
      };
      const lines: SessionLine[] = request.lines
        .map((line) => {
          const time = typeof line.time === "number" && Number.isFinite(line.time) ? Math.max(0, line.time) : null;
          return { text: line.text.trim(), time, seed: time };
        })
        .filter((line) => line.text.length > 0);
      if (lines.length === 0) return false;
      if (!options.aligner.has(request.lang)) {
        debug("model missing");
        options.emit({ key: request.key, state: "failed", lines: [] });
        return false;
      }
      const position = Math.max(0, request.position);
      const timed = lines.filter((line) => line.time !== null).length;
      let nextLine: number;
      if (timed * 2 >= lines.length) {
        // 이미 끝난 줄은 LRCLIB 시각을 그대로 두고, 지금 재생 중인 줄부터 다시 맞춘다.
        nextLine = lines.findIndex((line) => line.time === null || line.time + 0.5 >= position);
        if (nextLine < 0) nextLine = lines.length;
      } else if (position > MAX_START_SKEW_SECONDS) {
        // 시각이 없는 가사로 곡 중간부터 맞추면 앞부분이 오디오에 없어 전부 어긋난다.
        debug(`skip untimed start at ${position.toFixed(1)}s`);
        return false;
      } else {
        nextLine = 0;
      }
      if (nextLine >= lines.length) {
        debug("nothing left to align");
        return false;
      }

      const file = path.join(options.tempDir, `notch-align-${Date.now()}.pcm`);
      const rate = await options.bridge().beginCapture(file);
      debug(`start key=${request.key} lang=${request.lang} from=${nextLine}/${lines.length} at=${position.toFixed(2)}`);
      if (!rate) {
        options.emit({ key: request.key, state: "failed", lines: [] });
        return false;
      }
      session = {
        key: request.key,
        lang: request.lang,
        lines,
        nextLine,
        position,
        file,
        rate,
        bytesRead: 0,
        startedAt: Date.now(),
        cursorSample: 0,
        failures: 0,
        mismatch: 0,
        reanchoring: false,
      };
      samples = new Float32Array(0);
      downsampler = new Downsampler();
      options.emit({ key: request.key, state: "working", lines: snapshot(session) });
      timer = setInterval(() => void tick(), TICK_MS);
      return true;
    },
    // 재생 위치가 예상과 크게 어긋나면(탐색) 그 지점에서 다시 잡는다.
    position(seconds: number) {
      const current = session;
      if (!current) return;
      const expected = current.position + (Date.now() - current.startedAt) / 1000;
      if (Math.abs(expected - seconds) < 2.5) return;
      const at = Math.max(0, seconds);
      // 새 지점 이후의 줄은 다시 맞춰야 하므로 시각을 지운다.
      const cut = current.lines.findIndex((line) => line.time === null || line.time + 0.5 >= at);
      const next = cut < 0 ? current.lines.length : cut;
      for (let i = next; i < current.lines.length; i += 1) current.lines[i] = { ...current.lines[i], time: current.lines[i].seed };
      current.mismatch = 0;
      current.reanchoring = true;
      current.position = at;
      current.startedAt = Date.now();
      current.bytesRead = 0;
      current.cursorSample = 0;
      current.nextLine = next;
      samples = new Float32Array(0);
      downsampler = new Downsampler();
      // 캡처 파일을 비우고 같은 위치에서 다시 받는다.
      void options
        .bridge()
        .endCapture()
        .then(() => {
          try {
            fs.truncateSync(current.file, 0);
          } catch {
            // 파일이 비어 있으면 그대로 쓴다.
          }
          return options.bridge().beginCapture(current.file);
        })
        .catch(() => 0)
        .finally(() => {
          current.reanchoring = false;
        });
    },
    stop() {
      clear();
    },
  };
}
