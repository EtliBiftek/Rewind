import type { CSSProperties } from "react";

const P: Record<string, string> = {
  play: "M5 3.5v13l11-6.5z",
  pause: "M5 3.5h3.5v13H5zM11.5 3.5H15v13h-3.5z",
  prev: "M4 3.5h2v13H4zM17 3.5v13L7 10z",
  next: "M14 3.5h2v13h-2zM3 3.5v13l10-6.5z",
  rew: "M10 4v12L2 10zM18 4v12l-8-6z",
  fwd: "M10 4v12l8-6zM2 4v12l8-6z",
  skull: "M10 2.5a6 6 0 0 0-6 6c0 2 1 3.4 2.2 4.3V16h2v-1.5h1.6V16h2v-3.2C14 11.9 16 10.5 16 8.5a6 6 0 0 0-6-6zM7.6 9.2a1.4 1.4 0 1 1 0 .01zM12.4 9.2a1.4 1.4 0 1 1 0 .01z",
  bomb: "M9 6.5a5.5 5.5 0 1 0 .01 0zM12.5 5l1.8-1.8M15 2.5l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5z",
  clock: "M10 2.5a7.5 7.5 0 1 0 .01 0zM10 5.5V10l3 2",
  defuse: "M4 4l12 12M16 4L4 16",
  mic: "M10 2.5a2.5 2.5 0 0 0-2.5 2.5v4.5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5zM5 9.5a5 5 0 0 0 10 0M10 14.5V17.5",
  micoff: "M10 2.5a2.5 2.5 0 0 0-2.5 2.5v4.5a2.5 2.5 0 0 0 5 0V5A2.5 2.5 0 0 0 10 2.5zM5 9.5a5 5 0 0 0 10 0M3 3l14 14",
  vol: "M3 7.5h3l4-3.5v12l-4-3.5H3zM13 7a4 4 0 0 1 0 6M15.5 4.5a7.5 7.5 0 0 1 0 11",
  mute: "M3 7.5h3l4-3.5v12l-4-3.5H3zM13 7.5l4 5M17 7.5l-4 5",
  folder: "M2.5 5.5h5l1.5 2h8.5v8h-15z",
  film: "M3 4h14v12H3zM6 4v12M14 4v12M3 8h3M3 12h3M14 8h3M14 12h3",
  map: "M3 5l4-1.5 6 2L17 4v11l-4 1.5-6-2L3 16zM7 3.5v11M13 5.5v11",
  cube: "M10 2.5l7 3.8v7.4l-7 3.8-7-3.8V6.3zM3 6.3l7 3.8 7-3.8M10 10.1v7.4",
  split: "M3 4h14v12H3zM10 4v12",
  chart: "M3 16.5h14M5 14V9M9 14V5M13 14v-7M17 14V8",
  user: "M10 3.5a3.2 3.2 0 1 0 .01 0zM3.5 16.5a6.5 6.5 0 0 1 13 0z",
  bulb: "M10 2.5a5 5 0 0 0-3 9v2.5h6V11.5a5 5 0 0 0-3-9zM8 16.5h4",
  target: "M10 2.5a7.5 7.5 0 1 0 .01 0zM10 6a4 4 0 1 0 .01 0zM10 9.2a.8.8 0 1 0 .01 0z",
  help: "M10 2.5a7.5 7.5 0 1 0 .01 0zM7.7 8a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.8-1.1 1.6M10 14.2v.2",
  shield: "M10 2.5l6 2.3v5c0 3.5-2.5 6-6 7.2-3.5-1.2-6-3.7-6-7.2v-5z",
  swap: "M4 7h11l-3-3M16 13H5l3 3",
};
const FILL = new Set(["play", "pause", "prev", "next", "rew", "fwd", "skull", "bomb", "mic", "vol", "folder"]);

export function Icon({ n, size = 16, style, className }: { n: string; size?: number; style?: CSSProperties; className?: string }) {
  const fill = FILL.has(n);
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 20 20" style={style} aria-hidden="true" fill={fill ? "currentColor" : "none"} stroke={fill && n !== "mic" && n !== "vol" && n !== "bomb" ? "none" : "currentColor"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={P[n] ?? ""} />
    </svg>
  );
}
