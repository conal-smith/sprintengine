import * as LegacyFileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";

import { bytesFromBase64, pictureTypeOf, readPickedImage, type PickedImage } from "./composerOptions";

/**
 * One picture for a chat, from the library or the camera, as New and the chat
 * both pick it: null when the person cancels, and an error saying why when the
 * picture cannot be sent.
 *
 * The library is asked for its compatible form, so an iPhone's HEIC photo
 * arrives as a JPEG rather than as a type the desktop refuses. The type and
 * size sent are then read off the file the picker wrote, not taken from the
 * picker's word for the original photo: Android writes a compressed JPEG for a
 * HEIC, GIF or WebP photo and still reports the original's type and size.
 * `maxBytes` is the largest the desktop takes (`chatImageMaxBytes`).
 */
export async function pickChatImage(camera: boolean, maxBytes: number): Promise<PickedImage | null> {
  const permission = camera
    ? await ImagePicker.requestCameraPermissionsAsync()
    : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    throw new Error(camera ? "Camera access is required to take a photo." : "Photo access is required to attach an image.");
  }
  const result = camera
    ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.85 })
    : await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        quality: 0.85,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
      });
  const asset = !result.canceled ? result.assets[0] : undefined;
  if (!asset) return null;
  const picked = readPickedImage(asset, await inspectFile(asset.uri), maxBytes);
  if (!picked.ok) throw new Error(picked.message);
  return picked.image;
}

/** The written file's own type and size; whatever cannot be read is left to the picker's word. */
async function inspectFile(uri: string): Promise<{ type: string | null; size: number | null }> {
  const [head, info] = await Promise.all([
    LegacyFileSystem.readAsStringAsync(uri, {
      encoding: LegacyFileSystem.EncodingType.Base64,
      position: 0,
      length: 16,
    }).catch(() => null),
    LegacyFileSystem.getInfoAsync(uri).catch(() => null),
  ]);
  return {
    type: head ? pictureTypeOf(bytesFromBase64(head)) : null,
    size: info?.exists && typeof info.size === "number" ? info.size : null,
  };
}
