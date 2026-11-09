import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import "./styles.css";
import { queryClient } from "./lib/hooks";
import { TooltipProvider } from "./components/ui";
import { AppLayout } from "./components/AppLayout";
import { LoginPage } from "./pages/Login";
import { HomePage } from "./pages/Home";
import { MyTasksPage } from "./pages/MyTasks";
import { InboxPage } from "./pages/Inbox";
import { AgentsPage } from "./pages/Agents";
import { ProjectPage } from "./pages/Project";
import { OrganizationPage } from "./pages/Organization";
import { TeamPage, TeamsPage } from "./pages/Teams";
import { ReportsPage } from "./pages/Reports";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route element={<AppLayout />}>
              <Route index element={<HomePage />} />
              <Route path="my-tasks" element={<MyTasksPage />} />
              <Route path="inbox" element={<InboxPage />} />
              <Route path="ai" element={<AgentsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route path="org" element={<OrganizationPage />} />
              <Route path="teams" element={<TeamsPage />} />
              <Route path="teams/:id" element={<TeamPage />} />
              <Route path="projects/:id/:view?" element={<ProjectPage />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster position="bottom-left" toastOptions={{ className: "!rounded-xl !border-line !bg-raised !text-fg !shadow-lg !text-[13px]" }} />
      </TooltipProvider>
    </QueryClientProvider>
  </StrictMode>,
);
