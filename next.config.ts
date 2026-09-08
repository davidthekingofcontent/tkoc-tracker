import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // puppeteer-core drives the system Chromium for the server-side report PDF
  // (src/lib/report-pdf.ts); it must not be bundled by the Next compiler.
  serverExternalPackages: ["puppeteer-core"],
};

export default nextConfig;
