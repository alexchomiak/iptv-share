import { createRoot } from "react-dom/client";
import React, { Suspense, lazy } from "react";
import { useLocationPath } from "./lib/navigation.js";
import "./styles.css";

const AdminPage = lazy(() => import("./components/admin/AdminPage.jsx"));
const AdminSharePage = lazy(() => import("./components/admin/AdminSharePage.jsx"));
const AppGuide = lazy(() => import("./components/guide/AppGuide.jsx"));
const Login = lazy(() => import("./components/Login.jsx"));
const SharePage = lazy(() => import("./components/share/SharePage.jsx"));

function Root() {
  const path = useLocationPath();
  let page = null;
  if (path === "/login") page = <Login />;
  else if (path === "/admin") page = <AdminPage />;
  else if (path.startsWith("/admin/s/")) page = <AdminSharePage shareRef={decodeURIComponent(path.split("/").pop())} />;
  else if (path.startsWith("/s/")) page = <SharePage slug={decodeURIComponent(path.split("/").pop())} />;
  else if (path !== "/") page = <SharePage slug={decodeURIComponent(path.slice(1))} />;
  else page = <AppGuide />;
  return <Suspense fallback={<main className="shareShell"><h1>Loading...</h1></main>}>{page}</Suspense>;
}

createRoot(document.getElementById("root")).render(<Root />);
