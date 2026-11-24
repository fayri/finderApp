import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  async rewrites() {
    return process.env.NODE_ENV === "development"
      ? [
          {
            source: "/api/amazon/match",
            destination: "http://127.0.0.1:8001/api/amazon/match",
          },
        ]
      : [];
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
