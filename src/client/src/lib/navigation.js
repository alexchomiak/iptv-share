import { useEffect, useState } from "react";

export function navigate(path) {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new Event("locationchange"));
}

export function useLocationPath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    window.addEventListener("locationchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("locationchange", update);
    };
  }, []);
  return path;
}
