// The Ribbon Cable logo (images/logo.png) as half-block characters, 44 columns by 11 rows.
// Generated once from the PNG; main.ts colours it with the logo's purple-to-magenta gradient.
export const LOGO: string[] = [
  "      ▄▄██████▄▄▄                 ██▄▄▄     ",
  "   ▄██████████████▄                ▀████▄   ",
  "  ██████████████████▄              ▄▄█████▄ ",
  " ██████▀      ▀███████▄             ▀██████ ",
  "██████          ▀██████▄              ██████",
  "██████            ▀██████▄            ██████",
  "██████              ▀██████▄          ██████",
  " ██████▄             ▀███████▄      ▄██████ ",
  " ▀█████▀▀              ▀██████████████████▀ ",
  "   ▀████▄                ▀██████████████▀   ",
  "     ▀▀▀██▄                ▀▀▀██████▀▀▀     ",
];

/** The logo, left to right from purple (160,85,215) to magenta (222,58,198). Plain text when colour is off. */
export function renderLogo(color: boolean): string[] {
  if (!color) return LOGO;
  const width = LOGO[0].length;
  return LOGO.map((line) => {
    let out = "";
    for (let i = 0; i < line.length; i++) {
      if (line[i] === " ") { out += " "; continue; }
      const t = Math.min(1, i / (width * 0.65)); // the gradient finishes about two thirds across, as in the PNG
      const c = [160 + 62 * t, 85 - 27 * t, 215 - 17 * t].map(Math.round);
      out += `\x1b[38;2;${c[0]};${c[1]};${c[2]}m${line[i]}`;
    }
    return out + "\x1b[0m";
  });
}
