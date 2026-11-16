// 유튜브 제목의 [가사/해석/lyrics] 같은 꼬리표를 제거한다.
export function cleanTitle(title: string): string {
  return title
    .replace(/\s*[\[(【][^\])】]*[\])】]/g, "")
    .replace(/\s*\|.*$/, "")
    .replace(/\s+(Official|M\/V|MV|Music Video|Lyrics?|가사|뮤직비디오|Audio)\b.*$/i, "")
    .trim();
}

// 제목에 "아티스트 : 곡명" 형식이 있으면 곡명만 쓴다.
export function trackName(title: string): string {
  const cleaned = cleanTitle(title);
  const quoted = cleaned.match(/^(.*?)["'‘’“”]([^"'‘’“”]+?)["'‘’“”](?:\s|$)/);
  if (quoted && quoted[2].trim()) return quoted[2].trim();
  const match = cleaned.match(/^.+?\s:\s(.+)$/);
  if (match) return match[1].trim();
  // "아티스트 - 곡명" 형식. 뒤가 Live·Remix 같은 꼬리표면 곡명이 아니므로 두고,
  // "Drowning - Live"처럼 뒤가 수식어인 경우는 원래 제목을 그대로 쓴다.
  const dashed = cleaned.match(/^(.+?)\s+[-\u2013\u2014]\s+(.+)$/);
  if (dashed) {
    const tail = dashed[2].trim();
    const qualifier = /^(live|remix|inst|instrumental|version|edit|acoustic|cover|mv|m\/v|official|lyrics|가사|audio|feat\.?)\b/i.test(tail);
    if (!qualifier && tail.length >= 2) return tail;
  }
  return cleaned;
}

// 제목 앞의 "aespa 에스파 'Supernova' MV" 같은 구간은 아티스트다(채널명이 레이블일 때 대신 쓴다).
export function titleArtist(title: string): string {
  const quoted = title.match(/^(.*?)["'‘’“”][^"'‘’“”]+["'‘’“”]/);
  if (!quoted) return "";
  return quoted[1].replace(/[\s\-–—:]+$/, "").trim();
}

// YouTube 업로더(레이블·방송 채널)는 가수가 아니므로 아티스트로 쓰지 않는다.
const CHANNEL_NAMES = ["SMTOWN", "HYBE LABELS", "JYP Entertainment", "YG ENTERTAINMENT", "Mnet K-POP", "KBS Kpop", "1theK (원더케이)", "1theK", "GENIE MUSIC", "Vevo", "YouTube", "BIGHIT MUSIC", "Stone Music Entertainment"];
// 화면에는 YouTube Music의 "- Topic" 꼬리를 빼고 보여준다.
export function displayArtist(artist: string): string {
  return artist.replace(/\s*-\s*Topic$/i, "").trim();
}

export function artistName(artist: string): string {
  const name = artist.trim().replace(/\s*-\s*Topic$/i, "");
  if (!name || /VEVO$/i.test(name) || /(Entertainment|Records|Labels|Official)$/i.test(name)) return "";
  return CHANNEL_NAMES.some((c) => c.toLowerCase() === name.toLowerCase()) ? "" : name;
}
