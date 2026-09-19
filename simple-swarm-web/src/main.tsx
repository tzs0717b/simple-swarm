import { Component, StrictMode, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";

/* 白屏是信息量最少的失败方式。任何运行期错误都直接画到页面上，
   免得对着空白页只能靠猜（浏览器控制台里也留一份）。 */
function paint(title: string, detail: string): void {
  const root = document.getElementById("root");
  if (!root) return;
  const box = document.createElement("div");
  box.style.cssText =
    "margin:24px;padding:16px;border:1px solid #f0c0bb;border-radius:5px;background:#fdeceb;" +
    "font:12px/1.6 ui-monospace,SFMono-Regular,monospace;color:#a1553a;white-space:pre-wrap;word-break:break-all";
  const head = document.createElement("p");
  head.style.cssText = "margin:0 0 8px;font-weight:600;color:#b91c1c";
  head.textContent = title;
  const body = document.createElement("p");
  body.style.margin = "0";
  body.textContent = detail;
  box.append(head, body);
  root.textContent = "";
  root.append(box);
}

/* capture=true 才接得到 <script>/<link> 的资源加载失败（图片失败不算，别误伤） */
window.addEventListener(
  "error",
  (event) => {
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "SCRIPT" || tag === "LINK") {
      const element = target as HTMLScriptElement | HTMLLinkElement;
      paint("资源加载失败：" + ("src" in element ? element.src : element.href), location.href);
      return;
    }
    paint("前端运行出错", (event.error && event.error.stack) || event.message || String(event));
  },
  true,
);

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason as { stack?: string } | undefined;
  paint("未处理的 Promise 异常", String(reason?.stack ?? event.reason));
});

/* React 渲染/生命周期里抛的错不会走上面的 error 事件，得靠边界接住 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("渲染异常", error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <pre style={{ margin: 24, font: "12px/1.6 ui-monospace,monospace", color: "#b91c1c", whiteSpace: "pre-wrap" }}>
          {"渲染出错：\n" + (this.state.error.stack ?? this.state.error.message)}
        </pre>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
