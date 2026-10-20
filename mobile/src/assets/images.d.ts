// Metro resolves an imported image to an asset id, picking the @2x/@3x file
// beside it for the screen's density. This tells TypeScript what that import is.
declare module "*.png" {
  import type { ImageSourcePropType } from "react-native";

  const source: ImageSourcePropType;
  export default source;
}
