import { lazy } from "react";
import { createBrowserRouter } from "react-router-dom";
import { AppShell } from "@/components/shell/AppShell";
import { NotFound } from "./NotFound";

// Code-split every route.
const Dashboard = lazy(() => import("@/features/dashboard/DashboardPage"));
const RunsList = lazy(() => import("@/features/runs/RunsListPage"));
const NewRun = lazy(() => import("@/features/runs/wizard/NewRunWizard"));
const RunDetail = lazy(() => import("@/features/runs/RunDetailPage"));
const FindingPage = lazy(() => import("@/features/anomalies/FindingPage"));
const ReviewQueue = lazy(() => import("@/features/review/ReviewQueuePage"));
const Rules = lazy(() => import("@/features/rules/RulesPage"));
const Reports = lazy(() => import("@/features/reports/ReportsPage"));
const Audit = lazy(() => import("@/features/audit/AuditPage"));
const Settings = lazy(() => import("@/features/settings/SettingsPage"));

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/runs", element: <RunsList /> },
      { path: "/runs/new", element: <NewRun /> },
      { path: "/runs/:runId", element: <RunDetail /> },
      { path: "/runs/:runId/findings/:findingId", element: <FindingPage /> },
      { path: "/review", element: <ReviewQueue /> },
      { path: "/rules", element: <Rules /> },
      { path: "/reports", element: <Reports /> },
      { path: "/audit", element: <Audit /> },
      { path: "/settings", element: <Settings /> },
      { path: "*", element: <NotFound /> },
    ],
  },
], {
  future: { v7_relativeSplatPath: true, v7_fetcherPersist: true, v7_normalizeFormMethod: true, v7_partialHydration: true, v7_skipActionErrorRevalidation: true },
});
