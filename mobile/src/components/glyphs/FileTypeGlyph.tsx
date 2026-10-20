import type { ReactElement } from "react";
import { Path, Rect } from "react-native-svg";

import type { AttachedFileKind } from "../../features/conversations/attachedFiles";
import { useTheme } from "../../theme/ThemeProvider";
import type { ThemeColors } from "../../theme/tokens";
import { GlyphFrame, iconSize, type GlyphProps } from "./Glyph";

// The office kinds of the desktop's FileTypeGlyph (components/ui there), the
// marks a file a person attached to a message wears on its card. Copied
// coordinate-for-coordinate on the 16 grid it draws on, so a PDF wears the
// same page with a P on both screens; the code kinds' letter tiles are left
// on the desktop, and a file of any other kind is the plain page.
//
// The desktop's sent card inks the glyph in its kind's identity hue (the
// `mark*` tokens): PDF red, documents blue, spreadsheets teal, presentations
// orange. Text, archives and the plain page stay in the card's quiet ink: they
// name no kind worth a colour. The hue identifies; it never grades.

const FRAME = 1.2;
const LINE = 1.3;

const KIND_INK: Record<AttachedFileKind, keyof ThemeColors> = {
  pdf: "markRed",
  document: "markBlue",
  spreadsheet: "markTeal",
  presentation: "markOrange",
  text: "textMuted",
  archive: "textMuted",
  generic: "textMuted",
};

/** A page with its corner turned down: the desktop's `DocumentOutline`. */
function DocumentOutline() {
  return (
    <>
      <Path
        d="M4.25 1.75h5.4l2.1 2.1v10.4H4.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5Z"
        stroke="currentColor"
        strokeWidth={LINE}
        strokeLinejoin="round"
      />
      <Path d="M9.5 1.9v2.25h2.25" stroke="currentColor" strokeWidth={LINE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  );
}

const BODY: Record<AttachedFileKind, () => ReactElement> = {
  // A page with a P on it: the page is what a PDF is, the letter which kind.
  pdf: () => (
    <>
      <DocumentOutline />
      <Path
        d="M6 12.5V7.25h1.75c.9 0 1.5.55 1.5 1.35s-.6 1.4-1.5 1.4H6"
        stroke="currentColor"
        strokeWidth={LINE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // A page with a W on it: the word processor's page, as against text's plain lines.
  document: () => (
    <>
      <DocumentOutline />
      <Path
        d="M4.9 7.5l.95 4.75 1.35-3.4 1.35 3.4.95-4.75"
        stroke="currentColor"
        strokeWidth={LINE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // The grid: a header row and a first column ruled off from the cells.
  spreadsheet: () => (
    <>
      <Rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth={LINE} />
      <Path d="M2.25 6.25h11.5M2.25 9.85h11.5M6.25 2.75v10.5" stroke="currentColor" strokeWidth={LINE} />
    </>
  ),
  // A slide on its stand.
  presentation: () => (
    <>
      <Rect x="2" y="2.5" width="12" height="8.25" rx="1.25" stroke="currentColor" strokeWidth={LINE} />
      <Path
        d="M8 10.75v2.75M5.75 13.5h4.5M5 7.75l1.9-1.9 1.6 1.4L11 4.9"
        stroke="currentColor"
        strokeWidth={LINE}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  // A page zipped down its middle, the pull at the foot of the teeth.
  archive: () => (
    <>
      <DocumentOutline />
      <Path
        d="M7.25 2.4v1.1M8.75 3.9v1.1M7.25 5.4v1.1M8.75 6.9v1.1"
        stroke="currentColor"
        strokeWidth={LINE}
        strokeLinecap="round"
      />
      <Rect x="6.6" y="9" width="2.8" height="3.25" rx="0.7" stroke="currentColor" strokeWidth={FRAME} />
    </>
  ),
  text: () => (
    <>
      <DocumentOutline />
      <Path d="M5.25 7.25h4M5.25 9.75h4M5.25 12.25h2.5" stroke="currentColor" strokeWidth={LINE} strokeLinecap="round" />
    </>
  ),
  generic: () => <DocumentOutline />,
};

interface FileTypeGlyphProps extends GlyphProps {
  kind: AttachedFileKind;
}

/** A file's kind, by shape, in its kind's identity hue. Decorative unless `label` is given. */
export function FileTypeGlyph({ kind, size = iconSize.sm, label }: FileTypeGlyphProps) {
  const { colors } = useTheme();
  const Body = BODY[kind];
  return (
    <GlyphFrame viewBox="0 0 16 16" color={colors[KIND_INK[kind]]} size={size} label={label}>
      <Body />
    </GlyphFrame>
  );
}
