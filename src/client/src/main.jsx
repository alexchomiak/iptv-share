import { createRoot } from "react-dom/client";
import AdminPage from "./components/admin/AdminPage.jsx";
import AdminSharePage from "./components/admin/AdminSharePage.jsx";
import AppGuide from "./components/guide/AppGuide.jsx";
import Login from "./components/Login.jsx";
import SharePage from "./components/share/SharePage.jsx";
import { useLocationPath } from "./lib/navigation.js";
import "./styles.css";

function Root() {
  const path = useLocationPath();
  if (path === "/login") return <Login />;
  if (path === "/admin") return <AdminPage />;
  if (path.startsWith("/admin/s/")) return <AdminSharePage shareRef={decodeURIComponent(path.split("/").pop())} />;
  if (path.startsWith("/s/")) return <SharePage slug={decodeURIComponent(path.split("/").pop())} />;
  return <AppGuide />;
}

createRoot(document.getElementById("root")).render(<Root />);
