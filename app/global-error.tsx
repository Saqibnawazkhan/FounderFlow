"use client";

/**
 * Last-resort error boundary — fires only when the ROOT LAYOUT itself errors
 * (since nested route segments have their own error.tsx files now). Renders
 * its own <html> + <body> because it lives above the root layout.
 *
 * Surfaces the error message + digest so we can debug instead of black-screen.
 */

import { useEffect, useState } from "react";
import * as Sentry from "@sentry/nextjs";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    console.error("global error:", error);
    // Root-layout crash — most urgent class of error. SDK no-ops without DSN.
    Sentry.captureException(error, {
      tags: { boundary: "global", severity: "fatal" },
      extra: { digest: error.digest },
    });
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          background: "#0a0a0a",
          color: "#f7f8f5",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          margin: 0,
        }}
      >
        <div style={{ maxWidth: "32rem", width: "100%" }}>
          <p
            style={{
              fontFamily: "ui-monospace, monospace",
              fontSize: "10px",
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              color: "#94a3b8",
              textAlign: "center",
            }}
          >
            Fatal error
          </p>
          <h1
            style={{
              fontSize: "1.875rem",
              fontWeight: 700,
              marginTop: "0.5rem",
              marginBottom: "0.75rem",
              textAlign: "center",
            }}
          >
            Application failed to load
          </h1>
          <p
            style={{
              color: "#94a3b8",
              marginBottom: "1.5rem",
              textAlign: "center",
              fontSize: "0.875rem",
            }}
          >
            FounderFlow crashed in the root layout. Reload to retry. If it keeps happening, send the
            technical details below to support.
          </p>

          <div style={{ display: "flex", gap: "0.75rem", justifyContent: "center" }}>
            <button
              onClick={reset}
              style={{
                borderRadius: "9999px",
                background: "#b6f425",
                color: "#0a0a0a",
                padding: "0.625rem 1.5rem",
                fontSize: "0.875rem",
                fontWeight: 700,
                border: "none",
                cursor: "pointer",
              }}
            >
              Reload
            </button>
            <button
              onClick={() => setShowDetails((v) => !v)}
              style={{
                borderRadius: "9999px",
                background: "transparent",
                color: "#94a3b8",
                padding: "0.625rem 1.25rem",
                fontSize: "0.75rem",
                fontFamily: "ui-monospace, monospace",
                letterSpacing: "0.15em",
                textTransform: "uppercase",
                border: "1px solid rgba(255,255,255,0.1)",
                cursor: "pointer",
              }}
            >
              {showDetails ? "Hide" : "Details"}
            </button>
          </div>

          {showDetails && (
            <div
              style={{
                marginTop: "1.5rem",
                borderRadius: "12px",
                border: "1px solid rgba(255,255,255,0.06)",
                background: "rgba(255,255,255,0.02)",
                overflow: "hidden",
                textAlign: "left",
              }}
            >
              <div
                style={{
                  padding: "0.75rem 1rem",
                  borderBottom: "1px solid rgba(255,255,255,0.06)",
                }}
              >
                <p
                  style={{
                    fontFamily: "ui-monospace, monospace",
                    fontSize: "10px",
                    letterSpacing: "0.15em",
                    textTransform: "uppercase",
                    color: "#94a3b8",
                    margin: 0,
                  }}
                >
                  Message
                </p>
                <p
                  style={{
                    marginTop: "0.25rem",
                    marginBottom: 0,
                    fontSize: "0.875rem",
                    wordBreak: "break-word",
                  }}
                >
                  {error.message || "(no message)"}
                </p>
              </div>
              {error.digest && (
                <div
                  style={{
                    padding: "0.75rem 1rem",
                    borderBottom: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <p
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "10px",
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                      color: "#94a3b8",
                      margin: 0,
                    }}
                  >
                    Digest
                  </p>
                  <p
                    style={{
                      marginTop: "0.25rem",
                      marginBottom: 0,
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "0.75rem",
                      color: "#94a3b8",
                    }}
                  >
                    {error.digest}
                  </p>
                </div>
              )}
              {error.stack && (
                <div style={{ padding: "0.75rem 1rem" }}>
                  <p
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "10px",
                      letterSpacing: "0.15em",
                      textTransform: "uppercase",
                      color: "#94a3b8",
                      margin: 0,
                    }}
                  >
                    Stack
                  </p>
                  <pre
                    style={{
                      marginTop: "0.25rem",
                      marginBottom: 0,
                      maxHeight: "16rem",
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      fontFamily: "ui-monospace, monospace",
                      fontSize: "11px",
                      lineHeight: 1.5,
                      color: "#94a3b8",
                    }}
                  >
                    {error.stack}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      </body>
    </html>
  );
}
