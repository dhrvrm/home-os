import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Home OS Inventory",
    short_name: "Home OS",
    description: "Shared household inventory for roommates.",
    start_url: "/",
    display: "standalone",
    background_color: "#f1f3ef",
    theme_color: "#315f49",
    orientation: "portrait-primary",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
