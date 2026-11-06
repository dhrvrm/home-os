import { AuthGate } from "@/auth/auth-gate";

export default function HomePage() {
  return <AuthGate />;
}
