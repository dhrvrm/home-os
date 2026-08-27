import type { NextConfig } from "next";

const developmentProxy: NextConfig = process.env.NODE_ENV === "production" ? {} : {
  async rewrites() {
    const target = (process.env.HOMEOS_API_PROXY ?? "http://127.0.0.1:8080").replace(/\/$/, "");
    return [
      { source: "/api/:path*", destination: `${target}/api/:path*` },
      { source: "/healthz", destination: `${target}/healthz` },
      { source: "/readyz", destination: `${target}/readyz` },
    ];
  },
};

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  agentRules: false,
  ...developmentProxy,
};

export default nextConfig;
