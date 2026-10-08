import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/globals.css";
import { App } from "./App";

async function enableMocks() {
  // The MSW mock API is opt-in: only `VITE_USE_MOCKS=true` starts it. Anything else talks to
  // the real FastAPI backend at VITE_API_BASE_URL (see src/api/client.ts).
  if (import.meta.env.VITE_USE_MOCKS !== "true") return;
  const { worker } = await import("./api/mocks/browser");
  await worker.start({ onUnhandledRequest: "bypass", quiet: true });
}

enableMocks().then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
