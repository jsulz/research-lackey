import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ReportPage } from "./ReportPage";
import { route } from "./report";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// Two routes, chosen by path. Static Assets serves index.html for /reports/* (SPA fallback).
const current = route(window.location.pathname);
createRoot(root).render(
  <StrictMode>{current.page === "report" ? <ReportPage id={current.id} /> : <App />}</StrictMode>,
);
