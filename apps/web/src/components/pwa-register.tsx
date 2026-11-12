"use client";

import { useEffect } from "react";
import { initializePWA } from "./pwa-state";

export function PWARegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    return initializePWA();
  }, []);
  return null;
}
