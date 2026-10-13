import { createRoot } from "react-dom/client";
import { Workspace } from "../../src/components/workspace";
import "../../src/app/globals.css";
createRoot(document.getElementById("root")!).render(
  <>
    <div
      style={{
        position: "fixed",
        bottom: 0,
        right: 0,
        zIndex: 100,
        background: "#fff2c4",
        padding: "4px 12px",
        fontSize: 10,
      }}
    >
      AUTOMATED TEST · SYNTHETIC FIXTURES
    </div>
    <Workspace section={location.pathname.split("/")[2] || "home"} />
  </>,
);
