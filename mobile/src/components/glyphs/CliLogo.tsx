import type { ColorValue } from "react-native";
import Svg, { Path, Rect, type SvgProps } from "react-native-svg";

import { useTheme } from "../../theme/ThemeProvider";
import { iconSize } from "./Glyph";
import { resolveCliLogoKind } from "./cliLogoKind";

export { resolveCliLogoKind, type CliLogoKind } from "./cliLogoKind";

// The coding CLI marks, ported path-for-path from the desktop's CliIcon so a
// runtime wears the same logo on both screens. The viewBoxes are the desktop's
// too: these are artwork, not house glyphs, so they are not redrawn on the 16
// grid (and so do not go through GlyphFrame, which only takes 16 and 24).
//
// Claude Code keeps its brand orange in both themes, as on the desktop. Every
// other mark inks from `currentColor`, which is `textPrimary` unless the
// caller passes `color`.

// design-tokens-allow: Anthropic's brand colour, and a logo may not be recoloured.
const CLAUDE_CODE_ORANGE = "#D97757";

const CLAUDE_CODE_PATH =
  "M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z";

const CODEX_PATH =
  "M60.8734,57.2556v-14.9432c0-1.2586.4722-2.2029,1.5728-2.8314l30.0443-17.3023c4.0899-2.3593,8.9662-3.4599,13.9988-3.4599,18.8759,0,30.8307,14.6289,30.8307,30.2006,0,1.1007,0,2.3593-.158,3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629,0l-39.4812,22.9651ZM131.0276,115.4561v-35.7074c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651,12.8982-7.3934c1.1007-.6285,2.0453-.6285,3.1458,0l30.0441,17.3024c8.6523,5.0341,14.4708,15.7296,14.4708,26.1107,0,11.9539-7.0769,22.965-18.2461,27.527v.0021ZM51.593,83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314v-34.6048c0-16.8303,12.8982-29.5722,30.3585-29.5722,6.607,0,12.7403,2.2029,17.9324,6.1349l-30.987,17.9324c-1.8871,1.1007-2.8314,2.6735-2.8314,4.8764v45.6159l-.0014-.0015ZM79.3562,100.0403l-18.4829-10.3811v-22.0209l18.4829-10.3811,18.4812,10.3811v22.0209l-18.4812,10.3811ZM91.2319,147.8591c-6.607,0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005,2.8318-2.6728,2.8318-4.8759v-45.616l13.0564,7.5498c1.1005.6285,1.5723,1.5728,1.5723,2.8314v34.6051c0,16.8297-13.0564,29.5723-30.5147,29.5723v.001ZM53.9522,112.7822l-30.0443-17.3024c-8.652-5.0343-14.471-15.7296-14.471-26.1107,0-12.1119,7.2356-22.9652,18.403-27.5272v35.8634c0,2.2028.9443,3.7756,2.8314,4.8763l39.3248,22.8068-12.8982,7.3938c-1.1007.6287-2.045.6287-3.1456,0ZM52.2229,138.5791c-17.7745,0-30.8306-13.3713-30.8306-29.8871,0-1.2585.1578-2.5169.3143-3.7754l30.987,17.9323c1.8871,1.1005,3.7757,1.1005,5.6628,0l39.4811-22.807v14.9435c0,1.2585-.4721,2.2021-1.5728,2.8308l-30.0443,17.3025c-4.0898,2.359-8.9662,3.4605-13.9989,3.4605h.0014ZM91.2319,157.296c19.0327,0,34.9188-13.5272,38.5383-31.4594,17.6164-4.562,28.9425-21.0779,28.9425-37.908,0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035,1.2595-6.607,1.2595-9.909,0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461,0-8.3363.6285-12.4262,2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331,0-34.9191,13.5268-38.5384,31.4591C11.3255,36.0212,0,52.5373,0,69.3675c0,11.0112,4.7184,21.7065,13.2125,29.4142-.7865,3.3035-1.2586,6.6067-1.2586,9.9092,0,22.4923,18.2466,39.3241,39.3248,39.3241,4.2462,0,8.3362-.6277,12.426-2.0441,7.0776,6.921,16.8302,11.3251,27.5271,11.3251Z";

// The rounded tile the desktop frames its stand-in marks in (Z.AI, Grok, Kimi,
// Cursor, Muse). Each is an original mark, not the vendor's own logo.
function TileFrame() {
  return <Rect x="3.5" y="3.5" width="17" height="17" rx="5" stroke="currentColor" strokeWidth={1.7} />;
}

const TILE_STROKE = {
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function CliLogo({
  cli,
  size = iconSize.sm,
  color,
  label,
}: {
  cli: string | null | undefined;
  size?: number;
  color?: string;
  label?: string;
}) {
  const { colors } = useTheme();
  const ink: ColorValue = color ?? colors.textPrimary;
  const kind = resolveCliLogoKind(cli);

  // Same a11y split as GlyphFrame: named when it stands alone, hidden when
  // adjacent text already says which CLI it is.
  const a11y = label
    ? ({ accessibilityRole: "image", accessibilityLabel: label } as const)
    : ({
        accessibilityElementsHidden: true,
        importantForAccessibility: "no-hide-descendants",
      } as const);

  const frame = (viewBox: string, children: SvgProps["children"]) => (
    <Svg width={size} height={size} viewBox={viewBox} fill="none" color={ink} {...a11y}>
      {children}
    </Svg>
  );

  switch (kind) {
    case "claude-code":
      return frame("0 0 248 248", <Path d={CLAUDE_CODE_PATH} fill={CLAUDE_CODE_ORANGE} />);

    case "opencode":
      return frame(
        "112 80 288 352",
        <>
          <Path
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
          />
          <Path fill="currentColor" d="M320 224V352H192V224H320Z" />
        </>,
      );

    case "zai":
      return frame(
        "0 0 24 24",
        <>
          <TileFrame />
          <Path d="M8.25 8.5H15.75L8.25 15.5H15.75" {...TILE_STROKE} />
        </>,
      );

    case "grok":
      return frame(
        "0 0 24 24",
        <>
          <TileFrame />
          <Path d="M14.75 7.75L9.25 16.25M9.25 7.75L12 12" {...TILE_STROKE} />
        </>,
      );

    case "kimi":
      return frame(
        "0 0 24 24",
        <>
          <TileFrame />
          <Path d="M9.25 7.75V16.25M15 7.75L9.25 13.25M11.6 11L15 16.25" {...TILE_STROKE} />
        </>,
      );

    case "cursor":
      return frame(
        "0 0 24 24",
        <>
          <TileFrame />
          <Path
            d="M9.25 7.75L15.5 12.1L12.4 13L11.2 16.25L9.25 7.75Z"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinejoin="round"
          />
        </>,
      );

    case "muse":
      return frame(
        "0 0 24 24",
        <>
          <TileFrame />
          <Path d="M8 16.25V7.75L12 12L16 7.75V16.25" {...TILE_STROKE} />
        </>,
      );

    case "terminal":
      return frame(
        "0 0 24 24",
        <>
          <Rect x="3.75" y="5" width="16.5" height="14" rx="2.25" stroke="currentColor" strokeWidth={1.7} />
          <Path
            d="M7.5 9L10.75 12L7.5 15"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <Path d="M12.75 15H16.75" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" />
        </>,
      );

    case "codex":
      return frame("0 0 158.7128 157.296", <Path fill="currentColor" d={CODEX_PATH} />);
  }
}
