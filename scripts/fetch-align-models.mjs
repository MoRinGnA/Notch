// 가사 정렬 모델을 사용자 데이터 폴더에 내려받는다.
// 앱은 이 폴더에 모델이 있을 때만 정렬을 쓰고, 없으면 LRCLIB 가사만 쓴다.
// 사용: node scripts/fetch-align-models.mjs [대상 폴더]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const target =
  process.argv[2] ?? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Notch", "models");

const MODELS = {
  ko: {
    repo: "smartkdy7/movie-cut-w2v2-ko-onnx",
    files: { "model.onnx": "model.int8.onnx", "vocab.json": "vocab.json", "meta.json": "meta.json" },
  },
  en: {
    repo: "onnx-community/wav2vec2-base-960h-ONNX",
    files: { "model.onnx": "onnx/model_int8.onnx", "vocab.json": "vocab.json" },
  },
};

const download = async (url, file) => {
  if (fs.existsSync(file) && fs.statSync(file).size > 1024) {
    console.log("이미 있음", file);
    return;
  }
  console.log("받는 중", url);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(file, buffer);
  console.log("저장", file, `${(buffer.length / 1024 / 1024).toFixed(1)}MB`);
};

for (const [lang, spec] of Object.entries(MODELS)) {
  const dir = path.join(target, lang);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, remote] of Object.entries(spec.files)) {
    await download(`https://huggingface.co/${spec.repo}/resolve/main/${remote}`, path.join(dir, name));
  }
}
console.log("정렬 모델 준비 완료:", target);
