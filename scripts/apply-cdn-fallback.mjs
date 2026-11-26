import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_HTML_PATH = resolve("dist/public/index.html");

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function resolveShadowClawVersion(html) {
  const installedPkg = await readJsonIfExists(
    resolve("node_modules/shadow-claw/package.json"),
  );
  if (
    typeof installedPkg?.version === "string" &&
    installedPkg.version.trim()
  ) {
    return installedPkg.version.trim();
  }

  const htmlMatch = html.match(/shadow-claw@([^/"'\s]+)/);
  if (htmlMatch?.[1]) {
    return htmlMatch[1];
  }

  const rootPkg = await readJsonIfExists(resolve("package.json"));
  const depSpec = rootPkg?.devDependencies?.["shadow-claw"] || "";
  const cleaned = depSpec.replace(/^[^0-9]*/, "").trim();
  if (cleaned) {
    return cleaned;
  }

  throw new Error("Unable to determine shadow-claw version.");
}

function escapeJsonForHtmlScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\//g, "\\u002f");
}

function updateSiteConfigCdnOrigins(html) {
  const configRe =
    /(<script\b[^>]*\bid=["']shadow-claw-site-config["'][^>]*>)([\s\S]*?)(<\/script>)/i;
  return html.replace(configRe, (full, openTag, rawJson, closeTag) => {
    try {
      const config = JSON.parse(rawJson);
      const allowedDomains = new Set(
        Array.isArray(config?.customElements?.allowedDomains)
          ? config.customElements.allowedDomains
          : [],
      );
      allowedDomains.add("unpkg.com");
      allowedDomains.add("esm.sh");
      allowedDomains.add("cdn.jsdelivr.net");
      config.customElements = {
        ...(config.customElements || {}),
        allowedDomains: Array.from(allowedDomains),
      };

      const connectSrc = new Set(
        Array.isArray(config?.security?.connectSrc)
          ? config.security.connectSrc
          : ["'self'", "blob:", "data:"],
      );
      connectSrc.add("https://unpkg.com");
      connectSrc.add("https://esm.sh");
      connectSrc.add("https://cdn.jsdelivr.net");
      config.security = {
        ...(config.security || {}),
        connectSrc: Array.from(connectSrc),
      };

      return `${openTag}${escapeJsonForHtmlScript(config)}${closeTag}`;
    } catch {
      return full;
    }
  });
}

function buildFallbackLoaderSnippet(cdns) {
  const cdnsJson = JSON.stringify(cdns);
  return [
    `  <!-- ShadowClaw Library Module (unpkg primary, esm.sh & jsDelivr fallbacks) -->`,
    `  <script data-shadow-claw-cdn-loader="true">`,
    `    (async () => {`,
    `      const cdns = ${cdnsJson};`,
    `      const primaryCdn = cdns[0];`,
    `      const toTrustedScript = (code) => {`,
    `        try {`,
    `          const policy = window.trustedTypes?.defaultPolicy || window.trustedTypes?.getPolicy?.("default");`,
    `          if (policy && typeof policy.createScript === "function") return policy.createScript(code);`,
    `        } catch {}`,
    `        return code;`,
    `      };`,
    `      const toTrustedScriptUrl = (url) => {`,
    `        try {`,
    `          const policy = window.trustedTypes?.defaultPolicy || window.trustedTypes?.getPolicy?.("default");`,
    `          if (policy && typeof policy.createScriptURL === "function") return policy.createScriptURL(url);`,
    `        } catch {}`,
    `        return url;`,
    `      };`,
    `      const probeCdn = async (cdn) => {`,
    `        const controller = typeof AbortController === "function" ? new AbortController() : null;`,
    `        const timer = controller ? setTimeout(() => controller.abort(), 5000) : null;`,
    `        try {`,
    `          const res = await fetch(\`\${cdn}/dist/lib/index.js\`, {`,
    `            method: "GET",`,
    `            mode: "cors",`,
    `            credentials: "omit",`,
    `            ...(controller ? { signal: controller.signal } : {}),`,
    `          });`,
    `          if (!res.ok) return false;`,
    `          const contentType = res.headers.get("content-type") || "";`,
    `          return !/text\\/html/i.test(contentType);`,
    `        } catch {`,
    `          return false;`,
    `        } finally {`,
    `          if (timer !== null) clearTimeout(timer);`,
    `        }`,
    `      };`,
    `      let activeCdn = primaryCdn;`,
    `      for (const cdn of cdns) {`,
    `        if (await probeCdn(cdn)) {`,
    `          activeCdn = cdn;`,
    `          break;`,
    `        }`,
    `      }`,
    `      const assetBase = \`\${activeCdn}/dist/public/\`;`,
    `      const metaAssetBase = document.querySelector('meta[name="shadow-claw-asset-base"]');`,
    `      if (metaAssetBase) metaAssetBase.setAttribute("content", assetBase);`,
    `      if (activeCdn !== primaryCdn) {`,
    `        const primaryPrefix = \`\${primaryCdn}/dist/public/\`;`,
    `        for (const link of document.querySelectorAll("link[href]")) {`,
    `          const href = link.getAttribute("href") || "";`,
    `          if (href.startsWith(primaryPrefix)) {`,
    `            const nextHref = \`\${assetBase}\${href.slice(primaryPrefix.length)}\`;`,
    `            if (link.rel === "stylesheet") {`,
    `              const replacement = document.createElement("link");`,
    `              replacement.rel = "stylesheet";`,
    `              replacement.href = nextHref;`,
    `              link.replaceWith(replacement);`,
    `            } else {`,
    `              link.setAttribute("href", nextHref);`,
    `            }`,
    `          }`,
    `        }`,
    `      }`,
    `      if (typeof window.ShadowClawThemeInit === "undefined") {`,
    `        const isEsmSh = activeCdn.startsWith("https://esm.sh/");`,
    `        const themeInitUrl = \`\${assetBase}theme-init.js\${isEsmSh ? "?raw" : ""}\`;`,
    `        await new Promise((resolve) => {`,
    `          const script = document.createElement("script");`,
    `          script.src = toTrustedScriptUrl(themeInitUrl);`,
    `          script.onload = resolve;`,
    `          script.onerror = resolve;`,
    `          document.head.appendChild(script);`,
    `        });`,
    `      }`,
    `      const libBase = \`\${activeCdn}/dist/lib/\`;`,
    `      const importMap = {`,
    `        imports: {`,
    `          "shadow-claw": \`\${libBase}index.js\`,`,
    `          "shadow-claw/": \`\${activeCdn}/\`,`,
    `          "shadow-claw/components": \`\${libBase}components/index.js\`,`,
    `          "shadow-claw/components/": \`\${libBase}components/\`,`,
    `          "shadow-claw/utils": \`\${libBase}utils/index.js\`,`,
    `          "shadow-claw/utils/": \`\${libBase}utils/\`,`,
    `          "shadow-claw/signals": \`\${libBase}utils/signals.js\`,`,
    `        },`,
    `      };`,
    `      const importMapScript = document.createElement("script");`,
    `      importMapScript.type = "importmap";`,
    `      importMapScript.textContent = toTrustedScript(JSON.stringify(importMap));`,
    `      document.head.appendChild(importMapScript);`,
    `      const entryScript = document.createElement("script");`,
    `      entryScript.type = "module";`,
    `      entryScript.textContent = toTrustedScript('import "shadow-claw";');`,
    `      document.head.appendChild(entryScript);`,
    `    })();`,
    `  </script>`,
  ].join("\n");
}

export async function applyCdnFallback(targetPath = DEFAULT_HTML_PATH) {
  let html = await readFile(targetPath, "utf8");
  const version = await resolveShadowClawVersion(html);

  const cdns = [
    `https://unpkg.com/shadow-claw@${version}`,
    `https://esm.sh/shadow-claw@${version}`,
    `https://cdn.jsdelivr.net/npm/shadow-claw@${version}`,
  ];
  const primaryCdn = cdns[0];

  const existingBaseMatch = html.match(
    /<meta\s+name="shadow-claw-asset-base"\s+content="([^"]+?)\/dist\/public\/"/i,
  );
  const existingCdnBase = existingBaseMatch?.[1];
  if (existingCdnBase && existingCdnBase !== primaryCdn) {
    html = html.replaceAll(`${existingCdnBase}/`, `${primaryCdn}/`);
  }

  html = updateSiteConfigCdnOrigins(html);

  const loaderSnippet = buildFallbackLoaderSnippet(cdns);

  const existingLoaderRe =
    /[ \t]*(?:<!--[^\n]*ShadowClaw Library Module[^\n]*-->\r?\n[ \t]*)?<script\b[^>]*\bdata-shadow-claw-cdn-loader=["']true["'][^>]*>[\s\S]*?<\/script>/i;
  if (existingLoaderRe.test(html)) {
    html = html.replace(existingLoaderRe, loaderSnippet);
  } else {
    html = html.replace(
      /[ \t]*<script\b[^>]*\btype=["']?importmap["']?[^>]*>[\s\S]*?<\/script>\r?\n?/giu,
      "",
    );
    const moduleEntryRe =
      /[ \t]*(?:<!--\s*ShadowClaw Library Module\s*-->\r?\n[ \t]*)?<script\b[^>]*\btype=["']?module["']?[^>]*>[\s\S]*?import\s+["']shadow-claw["'];?[\s\S]*?<\/script>/iu;
    if (!moduleEntryRe.test(html)) {
      throw new Error(
        `Could not locate module entry <script type="module"> in ${targetPath}`,
      );
    }
    html = html.replace(moduleEntryRe, loaderSnippet);
  }

  await writeFile(targetPath, html, "utf8");
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isCli) {
  const target = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_HTML_PATH;
  await applyCdnFallback(target);
}
