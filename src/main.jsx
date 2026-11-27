import React from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
import App from "./App";
import { PreferencesProvider } from "./preferences";

createRoot(document.getElementById("root")).render(<PreferencesProvider><App /></PreferencesProvider>);
