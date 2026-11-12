import fs from "node:fs";
import path from "node:path";

// 브리지와 연결 절차가 같은 파일을 읽고 쓴다.
// 이 파일은 exe에 넣지 않고 각 PC의 %APPDATA%에만 둔다(토큰이 PC마다 따로 회전하기 때문).
export interface DiscordConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

// 저장된 설정이 없는 PC에서 처음 연결할 때 쓰는 앱 id. 비밀값이 아니라 공개 값이다.
export const DEFAULT_CLIENT_ID = "1569931918345117717";

export const discordConfigPath = (appData: string): string => path.join(appData, "Notch", "discord.json");

export function readDiscordConfig(appData: string): DiscordConfig | null {
  try {
    const raw = JSON.parse(fs.readFileSync(discordConfigPath(appData), "utf8")) as Partial<DiscordConfig>;
    if (!raw.clientId || !raw.clientSecret || !raw.refreshToken) return null;
    return { clientId: raw.clientId, clientSecret: raw.clientSecret, refreshToken: raw.refreshToken };
  } catch {
    return null;
  }
}

// 반쯤 쓴 파일이 남지 않도록 임시 파일에 쓴 뒤 바꿔치기한다.
export function writeDiscordConfig(appData: string, config: DiscordConfig): boolean {
  try {
    const file = discordConfigPath(appData);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(config, null, 2) + "\n", "utf8");
    fs.renameSync(temp, file);
    return true;
  } catch {
    return false;
  }
}
