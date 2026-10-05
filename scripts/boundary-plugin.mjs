import { builtinModules } from "node:module";
import path from "node:path";
import { definePlugin, defineRule } from "vite-plus/lint/plugins";

const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const root = process.cwd();

function layerFor(filename) {
  const relative = path.relative(root, filename).replaceAll("\\", "/");
  return relative.match(/^packages\/(common|core|platform-node)\/src\//)?.[1];
}

const boundaries = defineRule({
  meta: {
    type: "problem",
    schema: [],
    messages: { forbidden: "Import '{{source}}' violates the {{layer}} package boundary." },
  },
  create(context) {
    const filename = context.filename;
    const layer = layerFor(filename);
    const isDi = filename.replaceAll("\\", "/").includes("/core/src/di/");
    function check(node, source) {
      if (typeof source !== "string") return;
      const isRelative = source.startsWith(".");
      let allowed = true;
      if (layer) {
        allowed = isRelative
          ? layerFor(path.resolve(path.dirname(filename), source)) === layer
          : source === "@mini-nest/common" ||
            (layer === "core" && source.startsWith("@mini-nest/common/internal/")) ||
            (layer === "platform-node" && builtins.has(source.replace(/^node:/, "")));
        if (layer === "common" && !isRelative) allowed = false;
      } else if (source.includes("/internal/")) {
        allowed = false;
      }
      if (isDi && isRelative) {
        const target = path.resolve(path.dirname(filename), source).replaceAll("\\", "/");
        if (!target.includes("/core/src/di/")) allowed = false;
      }
      if (!allowed)
        context.report({
          node,
          messageId: "forbidden",
          data: { source, layer: layer ?? "public API" },
        });
    }
    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => {
        if (node.source.type === "Literal") check(node, node.source.value);
        else
          context.report({
            node,
            messageId: "forbidden",
            data: { source: "computed dynamic import", layer },
          });
      },
      TSImportType: (node) => check(node, node.argument?.value ?? node.argument?.literal?.value),
    };
  },
});

export default definePlugin({
  meta: { name: "architecture" },
  rules: { boundaries },
});
