import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    container: { center: true, padding: "1.5rem" },
    extend: {
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        background: token("background"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        border: token("border"),
        input: token("border"),
        ring: token("sys"),
        foreground: token("foreground"),
        muted: { DEFAULT: token("surface-2"), foreground: token("muted-foreground") },
        primary: { DEFAULT: token("sys"), foreground: token("on-accent") },
        // Semantic accents — keep these meanings consistent everywhere:
        sys: token("sys"), //   cyan   — matched / success / system actions
        attn: token("attn"), // orange — unmatched / needs attention
        crit: token("crit"), // red    — potential fraud / critical / rejected
        warn: token("warn"), // amber  — timing / warning / medium risk
        ai: token("ai"), //     violet — AI-generated content
        ok: token("ok"), //     green  — approved / reconciled
      },
      borderRadius: { lg: "10px", md: "8px", sm: "6px" },
      fontSize: { "2xs": ["0.6875rem", { lineHeight: "1rem" }] },
      keyframes: {
        pulseRing: {
          "0%": { transform: "scale(1)", opacity: "0.6" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "pulse-ring": "pulseRing 1.6s cubic-bezier(0,0,0.2,1) infinite",
      },
    },
  },
  plugins: [animate],
} satisfies Config;
