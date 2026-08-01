import { useEffect, useRef } from "react";
import { weaponAimIndicator } from "./WeaponAimIndicator";

const ARM_LENGTH_PIXELS = 7;
const MIN_RADIUS_PIXELS = 4;
const MAX_RADIUS_PIXELS = 72;

export function HipfireCrosshair() {
  const root = useRef<SVGSVGElement>(null);
  const group = useRef<SVGGElement>(null);
  const left = useRef<SVGLineElement>(null);
  const right = useRef<SVGLineElement>(null);
  const top = useRef<SVGLineElement>(null);
  const bottom = useRef<SVGLineElement>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const indicator = weaponAimIndicator;
      const svg = root.current;
      const marks = group.current;
      if (svg && marks) {
        svg.style.opacity = indicator.visible ? String(indicator.opacity) : "0";
        if (!indicator.visible) {
          frame = requestAnimationFrame(update);
          return;
        }
        const radius = Math.min(
          MAX_RADIUS_PIXELS,
          Math.max(MIN_RADIUS_PIXELS, indicator.coneRadiusPixels)
        );
        marks.setAttribute(
          "transform",
          `translate(${indicator.centreXPixels} ${indicator.centreYPixels})`
        );
        if (left.current) {
          left.current.x1.baseVal.value = -radius - ARM_LENGTH_PIXELS;
          left.current.x2.baseVal.value = -radius;
        }
        if (right.current) {
          right.current.x1.baseVal.value = radius;
          right.current.x2.baseVal.value = radius + ARM_LENGTH_PIXELS;
        }
        if (top.current) {
          top.current.y1.baseVal.value = -radius - ARM_LENGTH_PIXELS;
          top.current.y2.baseVal.value = -radius;
        }
        if (bottom.current) {
          bottom.current.y1.baseVal.value = radius;
          bottom.current.y2.baseVal.value = radius + ARM_LENGTH_PIXELS;
        }
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, []);

  const lineProps = {
    stroke: "rgba(255, 157, 46, 0.98)",
    strokeWidth: 1.25,
    strokeLinecap: "square" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };

  return (
    <svg
      ref={root}
      aria-hidden="true"
      width="100%"
      height="100%"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 11,
        overflow: "visible",
        opacity: 0,
        pointerEvents: "none",
        filter: "drop-shadow(0 1px 2px rgba(0, 0, 0, 0.9))",
      }}
    >
      <g ref={group}>
        <line ref={left} y1="0" y2="0" {...lineProps} />
        <line ref={right} y1="0" y2="0" {...lineProps} />
        <line ref={top} x1="0" x2="0" {...lineProps} />
        <line ref={bottom} x1="0" x2="0" {...lineProps} />
        <circle cx="0" cy="0" r="1.35" fill="rgba(255, 157, 46, 0.98)" />
      </g>
    </svg>
  );
}
