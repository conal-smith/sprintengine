import { Platform } from "react-native";

// `--sem-font-family-*`. The system ships TWO families, permanently: a UI family
// and a mono one. There is no third and no serif; adding one is a system change,
// not a styling choice.
//
// This lives apart from `tokens.ts` so that file stays dependency-free and
// therefore testable under bare `node --test` — the same reason `roleRegistry.ts`
// keeps its role ids as string literals. `Platform` is the only react-native
// import the token layer ever wanted, and it only wanted it for this one value.
//
// The UI family is deliberately absent: the system's UI face is Inter, which this
// app does not bundle, and RN's platform default (SF on iOS, Roboto on Android) is
// the right answer for a phone anyway. Naming a family that is not loaded would
// silently fall back while claiming otherwise.
export const monoFontFamily = Platform.OS === "ios" ? "Menlo" : "monospace";
