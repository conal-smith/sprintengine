import { PROJECT_MARK_CLASS, projectColorStyle } from '../../utils/projectColor'

// A generated project icon: one or two characters on a tile of the project's
// hue. Drawn rather than rasterised, so it is the same for the same text and
// hue on every render and in every theme: the tile and the letters wear the
// hue as ink (`.project-mark`), at the lightness and chroma the folder glyph
// does, which is what already reads on all eleven themes. The tile is a wash
// of that ink rather than a solid fill, so the letters keep their contrast.
export function ProjectMonogram({ text, hue, className }: { text: string; hue: number; className?: string }) {
  const chars = Array.from(text).length
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`${className ?? ''} ${PROJECT_MARK_CLASS}`.trim()}
      style={projectColorStyle(hue)}
      data-project-monogram={text}
    >
      <rect
        x="0.75"
        y="0.75"
        width="14.5"
        height="14.5"
        rx="3.5"
        fill="currentColor"
        fillOpacity="0.16"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <text
        x="8"
        y="8.4"
        textAnchor="middle"
        dominantBaseline="middle"
        fill="currentColor"
        fontSize={chars > 1 ? 7 : 9}
        fontWeight={700}
      >
        {text}
      </text>
    </svg>
  )
}
