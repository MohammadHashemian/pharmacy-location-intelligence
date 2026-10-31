import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-mode indicator badge sits on top of the dashboard's bottom-left
  // corner and shows up in every screenshot; it adds nothing for a local tool.
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Set by `next upgrade --agent=security` (16.4.0 → 16.4.3 advisory fix).
    agentUpgrade: "security",
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
