import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Polaris 12.27 initializes this context from matchMedia during hydration,
// although SSR always uses false. Page headers consequently render a different
// DOM in narrow Shopify iframes (React #418/#423). Match the server initially;
// the provider's existing mount effect and resize listener then read the viewport.
const packageRoot = new URL(
  "../node_modules/@shopify/polaris/",
  import.meta.url,
);
const { version } = JSON.parse(
  readFileSync(new URL("package.json", packageRoot), "utf8"),
);
if (version !== "12.27.0") {
  throw new Error(
    `Review the Polaris SSR media-query patch for version ${version} before building.`,
  );
}

for (const [format, expression] of [
  ["esm", "useState(navigationBarCollapsed().matches)"],
  ["cjs", "React.useState(breakpoints.navigationBarCollapsed().matches)"],
]) {
  const target = new URL(
    `build/${format}/components/MediaQueryProvider/MediaQueryProvider.js`,
    packageRoot,
  );
  const original = readFileSync(target, "utf8");
  const replacement =
    format === "esm" ? "useState(false)" : "React.useState(false)";
  if (original.includes(expression)) {
    writeFileSync(target, original.replace(expression, replacement));
  } else if (
    !original.includes(`setIsNavigationCollapsed] = ${replacement};`)
  ) {
    throw new Error(
      `Polaris SSR patch could not recognize ${fileURLToPath(target)}.`,
    );
  }
}
