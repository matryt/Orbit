/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        background: "#0c0d12",
        surface: {
          DEFAULT: "#12141c",
          hover: "#181b26",
          active: "#1f2332",
          muted: "#0f1017",
        },
        border: {
          subtle: "rgba(255, 255, 255, 0.07)",
          light: "rgba(255, 255, 255, 0.12)",
        },
        accent: {
          s3: "#f59e0b",      // Amber
          sftp: "#38bdf8",    // Sky blue
          brand: "#6366f1",   // Indigo
        }
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Text"',
          '"Segoe UI"',
          "Roboto",
          "sans-serif"
        ],
        mono: [
          '"SF Mono"',
          '"JetBrains Mono"',
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace"
        ]
      }
    },
  },
  plugins: [],
}

