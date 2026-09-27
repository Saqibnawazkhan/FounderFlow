import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "FounderFlow — Co-Founder Company Management";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "space-between",
        padding: "80px",
        background: "linear-gradient(135deg, #1F2933 0%, #16212B 60%, #0B2F24 100%)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 16,
            background: "#1F2933",
            border: "2px solid #10B981",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "sans-serif",
            fontWeight: 900,
            fontSize: 52,
            color: "#10B981",
          }}
        >
          F
        </div>
        <div
          style={{
            fontFamily: "sans-serif",
            fontSize: 40,
            fontWeight: 700,
            color: "#ffffff",
            letterSpacing: -1,
          }}
        >
          FounderFlow
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
        <div
          style={{
            fontFamily: "sans-serif",
            fontSize: 88,
            fontWeight: 800,
            color: "#ffffff",
            lineHeight: 1.05,
            letterSpacing: -2,
            maxWidth: 900,
          }}
        >
          Finances, tasks, and momentum — one place.
        </div>
        <div
          style={{
            fontFamily: "sans-serif",
            fontSize: 30,
            color: "#10B981",
            fontWeight: 500,
          }}
        >
          Built for co-founders.
        </div>
      </div>
    </div>,
    { ...size }
  );
}
