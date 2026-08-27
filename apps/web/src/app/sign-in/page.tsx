"use client";

import { SignInScreen } from "@/components/sign-in-screen";

export default function SignInPage() {
  const returnTo = typeof window === "undefined" ? "/" : window.location.href;
  return <SignInScreen returnTo={returnTo} />;
}
