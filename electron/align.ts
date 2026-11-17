import fs from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-node";

// 가사 정렬기. wav2vec2 CTC 음향 모델의 프레임 확률 위에서 Viterbi를 돌려
// "이 글자가 오디오 어디에서 시작하는지"를 찾는다. 곡 식별이 아니라 정렬이라,
// 같은 가사 텍스트만 있으면 어떤 소스(뮤비·가사영상)든 같은 방식으로 맞는다.
export type AlignLang = "ko" | "en";

interface ModelSpec {
  blank: number;
  delimiter: string;
}

// 모델은 사용자 데이터 폴더에 두고(수백 MB), 없으면 정렬을 쓰지 않고 LRCLIB 가사로 돌아간다.
const SPECS: Record<AlignLang, ModelSpec> = {
  ko: { blank: 1204, delimiter: "|" },
  en: { blank: 0, delimiter: "|" },
};

// 20ms/프레임. 두 모델 모두 conv_stride 합이 320샘플(16kHz)이다.
export const FRAME_SECONDS = 0.02;
const WINDOW_LIMIT_SECONDS = 30;

interface LoadedModel {
  session: ort.InferenceSession;
  labels: string[];
  spec: ModelSpec;
}

export interface TokenSpan {
  start: number;
  end: number;
}


function normalize(samples: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < samples.length; i += 1) mean += samples[i];
  mean /= samples.length || 1;
  let variance = 0;
  for (let i = 0; i < samples.length; i += 1) variance += (samples[i] - mean) ** 2;
  variance /= samples.length || 1;
  const std = Math.sqrt(variance) || 1;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] - mean) / std;
  return out;
}

function readSpec(baseDir: string, lang: AlignLang): ModelSpec {
  const base = { ...SPECS[lang] };
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(baseDir, lang, "meta.json"), "utf8")) as {
      blank_id?: number;
      word_delimiter_token?: string;
    };
    if (typeof meta.blank_id === "number") base.blank = meta.blank_id;
    if (typeof meta.word_delimiter_token === "string" && meta.word_delimiter_token) base.delimiter = meta.word_delimiter_token;
  } catch {
    // meta.json이 없으면 내장 기본값을 쓴다.
  }
  return base;
}

export class CtcAligner {
  private models = new Map<AlignLang, LoadedModel>();
  private loading = new Map<AlignLang, Promise<LoadedModel | null>>();

  constructor(private readonly baseDir: string) {}

  // 어느 폴더에서 무엇을 찾았는지 진단용으로 돌려준다.
  describe(): string {
    return `${this.baseDir} ko=${this.has("ko")} en=${this.has("en")}`;
  }

  // 모델 파일이 모두 있는지. 없으면 정렬을 시도조차 하지 않는다.
  has(lang: AlignLang): boolean {
    if (this.models.has(lang)) return true;
    return (
      fs.existsSync(path.join(this.baseDir, lang, "model.onnx")) &&
      fs.existsSync(path.join(this.baseDir, lang, "vocab.json"))
    );
  }

  private async load(lang: AlignLang): Promise<LoadedModel | null> {
    const ready = this.models.get(lang);
    if (ready) return ready;
    const inFlight = this.loading.get(lang);
    if (inFlight) return inFlight;
    const task = (async () => {
      if (!this.has(lang)) return null;
      try {
        const vocab = JSON.parse(fs.readFileSync(path.join(this.baseDir, lang, "vocab.json"), "utf8")) as Record<string, number>;
        const labels = Object.entries(vocab)
          .sort((a, b) => a[1] - b[1])
          .map(([label]) => label);
        const session = await ort.InferenceSession.create(path.join(this.baseDir, lang, "model.onnx"), {
          intraOpNumThreads: 2,
        });
        const model: LoadedModel = { session, labels, spec: readSpec(this.baseDir, lang) };
        this.models.set(lang, model);
        return model;
      } catch {
        return null;
      }
    })();
    this.loading.set(lang, task);
    const result = await task;
    this.loading.delete(lang);
    return result;
  }

  async warm(lang: AlignLang): Promise<boolean> {
    return (await this.load(lang)) !== null;
  }

  // 텍스트를 토큰으로 바꾼다. 공백은 모델이 학습한 구분자 토큰으로 넣는다.
  tokenize(labels: string[], text: string, delimiter: string): number[] {
    const tokens: number[] = [];
    const delimiterId = labels.indexOf(delimiter);
    for (const char of Array.from(text.replace(/\s+/g, " ").trim())) {
      if (char === " ") {
        if (delimiterId >= 0) tokens.push(delimiterId);
        continue;
      }
      let id = labels.indexOf(char);
      if (id < 0) id = labels.indexOf(char.toUpperCase());
      if (id >= 0) tokens.push(id);
    }
    return tokens;
  }

  // 정렬에 쓰이는 토큰 수(공백 구분자 포함). 줄별 시작 토큰 위치를 계산할 때 쓴다.
  async tokenizeCount(text: string, lang: AlignLang): Promise<number> {
    const model = await this.load(lang);
    if (!model) return 0;
    return this.tokenize(model.labels, text, model.spec.delimiter).length;
  }

  // 오디오 구간에 대해 토큰별 시작/끝 프레임을 낸다.
  async align(samples: Float32Array, text: string, lang: AlignLang): Promise<TokenSpan[] | null> {
    const model = await this.load(lang);
    if (!model) return null;
    const tokens = this.tokenize(model.labels, text, model.spec.delimiter);
    if (!tokens.length) return null;

    // 창이 길면 비용이 커지므로 최대 30초만 본다(가사는 앞에서부터 소진한다).
    const limit = Math.min(samples.length, WINDOW_LIMIT_SECONDS * 16000);
    if (limit < 16000 * 0.4) return null;
    // 끝 프레임이 오디오와 무관하게 토큰을 뱉는 모델 버그를 피하려고 무음을 덧대고 끝 2프레임을 버린다.
    const padded = new Float32Array(limit + 1600);
    padded.set(samples.subarray(0, limit));
    const input = normalize(padded);

    const feeds = { [model.session.inputNames[0]]: new ort.Tensor("float32", input, [1, input.length]) };
    const output = await model.session.run(feeds);
    const logits = output[model.session.outputNames[0]];
    const dims = logits.dims;
    const frames = Math.max(1, dims[1] - 2);
    const classes = dims[2];
    const data = logits.data as Float32Array;

    return alignTokens(data, frames, classes, tokens, model.spec.blank);
  }
}

// CTC 강제 정렬: blank + 토큰 + blank 사슬에서 가장 그럴듯한 단조 경로를 찾는다.
function alignTokens(
  data: Float32Array,
  frames: number,
  classes: number,
  tokens: number[],
  blank: number,
): TokenSpan[] {
  const T = frames;
  const L = tokens.length;
  const S = 2 * L + 1;
  const NEG = -1e30;

  // 프레임별 log-softmax. 지연 계산하면 같은 프레임을 여러 번 훑게 되므로 미리 만든다.
  const probs = new Float32Array(T * classes);
  for (let t = 0; t < T; t += 1) {
    const from = t * classes;
    let max = -Infinity;
    for (let c = 0; c < classes; c += 1) max = Math.max(max, data[from + c]);
    let sum = 0;
    for (let c = 0; c < classes; c += 1) sum += Math.exp(data[from + c] - max);
    const logSum = max + Math.log(sum || 1e-30);
    for (let c = 0; c < classes; c += 1) probs[from + c] = data[from + c] - logSum;
  }

  let prev = new Float64Array(S).fill(NEG);
  const back = new Int8Array(T * S).fill(0);
  prev[0] = probs[blank];
  if (L > 0) prev[1] = probs[tokens[0]];

  for (let t = 1; t < T; t += 1) {
    const cur = new Float64Array(S).fill(NEG);
    const frameBase = t * classes;
    const backBase = t * S;
    for (let s = 0; s < S; s += 1) {
      const emit = s % 2 === 0 ? probs[frameBase + blank] : probs[frameBase + tokens[(s - 1) / 2]];
      let score = prev[s];
      let step = 0;
      if (prev[s - 1] > score) {
        score = prev[s - 1];
        step = 1;
      }
      if (s >= 2 && s % 2 === 1 && tokens[(s - 1) / 2] !== tokens[(s - 3) / 2] && prev[s - 2] > score) {
        score = prev[s - 2];
        step = 2;
      }
      cur[s] = score + emit;
      back[backBase + s] = step;
    }
    prev = cur;
  }

  let state = prev[S - 1] >= prev[S - 2] ? S - 1 : Math.max(0, S - 2);
  const starts = new Array<number>(L).fill(-1);
  const ends = new Array<number>(L).fill(-1);
  for (let t = T - 1; t >= 0; t -= 1) {
    if (state % 2 === 1) {
      const index = (state - 1) / 2;
      starts[index] = t;
      if (ends[index] < 0) ends[index] = t;
    }
    if (t === 0) break;
    const step = back[t * S + state];
    state -= step;
  }
  return tokens.map((_, index) => ({
    start: starts[index] < 0 ? 0 : starts[index] * FRAME_SECONDS,
    end: ends[index] < 0 ? 0 : (ends[index] + 1) * FRAME_SECONDS,
  }));
}
