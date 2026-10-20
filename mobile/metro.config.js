const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// The portable protocol is mirrored byte-for-byte from its Node16 package.
// Its relative .js specifiers point at TypeScript source in Metro's build.
const resolve = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    context.originModulePath.includes("/src/api/conversation-protocol/") &&
    moduleName.startsWith("./") &&
    moduleName.endsWith(".js")
  ) {
    return (resolve ?? context.resolveRequest)(
      context,
      moduleName.slice(0, -3) + ".ts",
      platform,
    );
  }
  return (resolve ?? context.resolveRequest)(context, moduleName, platform);
};

// Inline requires: a module runs the first time something uses it, not when
// the file that imports it loads. The navigators import every screen, so
// without this a cold start evaluated the chat screen's markdown, the HTML
// view's WebView, the camera and the speech recogniser before the first frame.
// Expo leaves it off by default; the app has no side-effect-only imports, which
// are the one thing it reorders.
const getTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (...args) => {
  const options = await getTransformOptions(...args);
  return { ...options, transform: { ...options.transform, inlineRequires: true } };
};

module.exports = config;
