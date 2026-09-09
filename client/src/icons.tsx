/**
 * Inline SVG icon primitives — the project's icon system.
 *
 * No icon library dependency: these are the same stroke style used across the
 * app. If a new icon is needed and it is not here, prefer omitting a decorative
 * icon over adding an emoji or a heavyweight dependency.
 */
interface IconProps {
  className?: string;
  size?: number;
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { display: "inline-block", flexShrink: 0 } as const,
  };
}

/** Filled check — used for completed stages. */
export function CheckIcon({ className, size = 12 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2.5"
      style={{ ...svgProps(size).style, verticalAlign: "-1px" }}
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/** Filled dot — used for the current stage and running experiments. */
export function DotIcon({ className, size = 10 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      stroke="none"
      fill="currentColor"
      style={{ ...svgProps(size).style, verticalAlign: "-1px" }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="6" />
    </svg>
  );
}

/** Hollow circle — pending stages/experiments. */
export function CircleIcon({ className, size = 10 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2"
      style={{ ...svgProps(size).style, verticalAlign: "-1px" }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/** Cross — failed stages/experiments. */
export function CrossIcon({ className, size = 12 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2.5"
      style={{ ...svgProps(size).style, verticalAlign: "-1px" }}
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

/** Circle-slash — cancelled investigations. */
export function BanIcon({ className, size = 14 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2"
      style={{ ...svgProps(size).style, verticalAlign: "-2px" }}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m5.5 5.5 13 13" />
    </svg>
  );
}

/** Triangle alert — execution/probe limitations (distinct from findings). */
export function AlertIcon({ className, size = 14 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2"
      style={{ ...svgProps(size).style, verticalAlign: "-2px" }}
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** Left arrow — back navigation. */
export function ArrowLeftIcon({ className, size = 14 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2"
      style={{ ...svgProps(size).style, verticalAlign: "-2px" }}
      aria-hidden="true"
    >
      <path d="m12 19-7-7 7-7" />
      <path d="M19 12H5" />
    </svg>
  );
}

/** Magnifier — brand mark. */
export function SearchIcon({ className, size = 18 }: IconProps) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}
