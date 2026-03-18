import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: [
    "apify-client",
    "proxy-agent",
    "pac-proxy-agent",
    "socks-proxy-agent",
    "https-proxy-agent",
    "http-proxy-agent",
    "socks",
    "axios",
    "async-retry",
    "@apify/log",
    "@apify/consts",
    "@apify/utilities",
    "ow",
  ],
};

export default nextConfig;
