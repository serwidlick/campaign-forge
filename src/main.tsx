import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";
import { applyTheme } from "@/lib/theme";
import { useThemeStore } from "@/stores/theme-store";

// Before the first paint, so the saved theme never flashes through Ember.
applyTheme(useThemeStore.getState().theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
