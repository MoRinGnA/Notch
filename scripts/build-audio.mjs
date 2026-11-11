// 오디오 사이드카(native/audio/Program.cs)를 Windows에 기본 포함된 csc.exe로 컴파일한다.
// .NET Framework 4.x는 Windows 10/11에 들어 있어 런타임을 따로 배포할 필요가 없다.
// 사용: node scripts/build-audio.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const SOURCE = path.join(ROOT, "native", "audio", "Program.cs");
const OUT_DIR = path.join(ROOT, "native", "audio", "bin");
const OUT_FILE = path.join(OUT_DIR, "notch-audio.exe");

const WINDIR = process.env.WINDIR ?? "C:\\Windows";
const CSC_CANDIDATES = [
  path.join(WINDIR, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(WINDIR, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];

function upToDate() {
  if (!fs.existsSync(OUT_FILE)) return false;
  const built = fs.statSync(OUT_FILE).mtimeMs;
  return fs.statSync(SOURCE).mtimeMs <= built;
}

if (process.platform !== "win32") {
  console.log("오디오 사이드카는 Windows에서만 빌드합니다.");
  process.exit(0);
}

if (upToDate()) {
  console.log("native/audio/bin/notch-audio.exe 최신 상태");
  process.exit(0);
}

const csc = CSC_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!csc) {
  console.error("csc.exe를 찾지 못했습니다. .NET Framework 4.x가 필요합니다.");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
execFileSync(
  csc,
  [
    "/nologo",
    "/target:exe",
    "/platform:anycpu",
    "/optimize+",
    "/warn:4",
    `/out:${OUT_FILE}`,
    "/r:System.dll",
    "/r:System.Core.dll",
    SOURCE,
  ],
  { stdio: "inherit" },
);
console.log(`native/audio/bin/notch-audio.exe 생성 (${Math.round(fs.statSync(OUT_FILE).size / 1024)}KB)`);
