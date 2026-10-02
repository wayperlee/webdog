/** @type {import("next").NextConfig} */

const nextConfig = {
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: process.cwd(),
  /** External on the server avoids missing `vendor-chunks/better-auth.js` and related webpack chunk bugs. */
  serverExternalPackages: ["pg", "better-auth"],
  /** Keep the dev overlay off the bottom-left corner where the floating Open Source button lives. */
  devIndicators: {
    position: "bottom-right",
  },
};

export default nextConfig;
