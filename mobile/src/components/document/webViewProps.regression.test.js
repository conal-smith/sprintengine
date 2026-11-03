/* global __dirname */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

// Every literal prop the app hands a WebView, held to the type react-native-
// webview's native spec declares for it (`RNCWebViewNativeComponent.ts`).
//
// Under the new architecture each prop is parsed in C++ against that spec, on
// both platforms, whether or not the platform uses it, and a value of the
// wrong shape is not refused but crashes the app. `dataDetectorTypes="none"`
// did exactly that on Android: the spec makes it an array, only iOS's wrapper
// turns a string into one, and Android handed the string to the parser, which
// took the app down the moment a reply drew a visual. TypeScript accepted it,
// since the wrapper's own props allow a string.

const mobileRoot = path.resolve(__dirname, "../../..");
const spec = fs.readFileSync(
  path.join(mobileRoot, "node_modules/react-native-webview/src/RNCWebViewNativeComponent.ts"),
  "utf8",
);

const WEBVIEW_FILES = [
  "src/components/document/HtmlDocument.tsx",
  "src/components/document/rich/RichRendererHost.tsx",
  "src/components/document/rich/VisualBlock.tsx",
];

/** The native props, each as the kind of value the parser takes. */
function nativeProps() {
  const body = /export interface NativeProps extends ViewProps \{([\s\S]*?)\n\}/.exec(spec);
  assert.ok(body, "RNCWebViewNativeComponent.ts declares NativeProps");
  const props = new Map();
  // Each prop starts on a line of its own at the interface's indent and runs
  // until the next one.
  for (const [, name, type] of body[1].matchAll(/^ {2}(\w+)\??:([\s\S]*?)(?=^ {2}\w+\??:|(?![\s\S]))/gm)) {
    const values = [...type.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    let kind;
    if (/ReadonlyArray</.test(type)) kind = { kind: "array", values };
    else if (/\bboolean\b/.test(type)) kind = { kind: "boolean" };
    else if (/\b(Int32|Double|Float)\b/.test(type)) kind = { kind: "number" };
    else if (values.length > 0) kind = { kind: "enum", values };
    else if (/^\s*(Readonly<)?string>?;/.test(type)) kind = { kind: "string" };
    else kind = { kind: "other" };
    props.set(name, kind);
  }
  return props;
}

/** Each `<WebView … />` in a file, as its props: a name and its literal value, if it has one. */
function webViewProps(source) {
  const elements = [...source.matchAll(/<WebView\b([\s\S]*?)\n\s*\/>/g)];
  return elements.map(([, body]) =>
    [...body.matchAll(/^\s+([a-zA-Z]\w*)(?:=(?:"([^"]*)"|\{([\s\S]*?)\}))?\s*$/gm)].map(([, name, string, expression]) => ({
      name,
      string,
      expression,
      bare: string === undefined && expression === undefined,
    })),
  );
}

test("the native spec reads as expected", () => {
  const props = nativeProps();
  assert.equal(props.get("dataDetectorTypes").kind, "array");
  assert.ok(props.get("dataDetectorTypes").values.includes("none"));
  assert.equal(props.get("mixedContentMode").kind, "enum");
  assert.equal(props.get("mediaCapturePermissionGrantType").kind, "enum");
  assert.equal(props.get("overScrollMode").kind, "string");
  assert.equal(props.get("javaScriptEnabled").kind, "boolean");
  assert.equal(props.get("textZoom").kind, "number");
});

test("the guard catches a string where the spec wants an array", () => {
  const [props] = webViewProps('<WebView\n  dataDetectorTypes="none"\n  incognito\n/>');
  assert.deepEqual(problems(props, nativeProps()), ['dataDetectorTypes="none" must be an array']);
});

function problems(props, spec) {
  const found = [];
  for (const prop of props) {
    const native = spec.get(prop.name);
    if (!native) continue; // a prop the wrapper keeps to itself
    if (prop.bare) {
      if (native.kind !== "boolean") found.push(`${prop.name} is written bare but is a ${native.kind}`);
    } else if (prop.string !== undefined) {
      if (native.kind === "array") found.push(`${prop.name}="${prop.string}" must be an array`);
      else if (native.kind === "enum" && !native.values.includes(prop.string))
        found.push(`${prop.name}="${prop.string}" is not one of ${native.values.join(", ")}`);
      else if (native.kind === "boolean" || native.kind === "number")
        found.push(`${prop.name}="${prop.string}" must be a ${native.kind}`);
    } else if (native.kind === "array") {
      const items = /^\s*\[([\s\S]*)\]\s*$/.exec(prop.expression);
      if (!items) {
        found.push(`${prop.name} must be an array literal, so it can be checked`);
        continue;
      }
      for (const [, value] of items[1].matchAll(/"([^"]*)"/g)) {
        if (!native.values.includes(value)) found.push(`${prop.name} holds "${value}", not one of ${native.values.join(", ")}`);
      }
    } else if (native.kind === "enum") {
      const literal = /^\s*"([^"]*)"\s*$/.exec(prop.expression);
      if (literal && !native.values.includes(literal[1])) found.push(`${prop.name}={"${literal[1]}"} is not one of ${native.values.join(", ")}`);
    }
  }
  return found;
}

for (const file of WEBVIEW_FILES) {
  test(`${file}: every literal WebView prop has the shape the native spec parses`, () => {
    const elements = webViewProps(fs.readFileSync(path.join(mobileRoot, file), "utf8"));
    assert.ok(elements.length > 0, `${file} draws a WebView`);
    const spec = nativeProps();
    for (const props of elements) {
      assert.ok(props.length > 5, `${file}: its WebView's props were read`);
      assert.deepEqual(problems(props, spec), []);
    }
  });
}
